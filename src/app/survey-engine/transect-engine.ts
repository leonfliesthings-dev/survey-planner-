/**
 * Terrain-following serpentine transect generator.
 *
 * Faithful TypeScript port of DeployPlanner
 *   companion/lib/services/transect_engine.dart  (class TransectEngine)
 * Pure geometry: the DSM is injected as `elevationAt`, so the engine is
 * decoupled from any terrain store and unit-testable with synthetic surfaces.
 * Heights returned are metres RELATIVE to the LZ takeoff point (spec §5.2).
 */
import { LatLng, Waypoint } from './waypoint';

export interface TransectPlan {
  /** Clipped transect segments `[start, end]` in serpentine (flight) order. */
  transects: [LatLng, LatLng][];
  /** Densified, terrain-following waypoints in serpentine order. */
  waypoints: Waypoint[];
  lineCount: number;
  /** Sum of transect lengths (metres); turns between lines excluded. */
  totalLengthM: number;
  /** totalLength / speed + 10 s per turn, in minutes. */
  estMinutes: number;
  warnings: string[];
}

export type ElevationFn = (p: LatLng) => number | null;

interface ClippedLine {
  v: number; // cross-line offset in the rotated frame
  u0: number; // kept segment extent along the line (u0 < u1)
  u1: number;
}

// ── Constants (transect_engine.dart:47-63) ──
const SAMPLE_STEP_M = 12.0;
const DP_VERTICAL_TOL_M = 5.0;
const SAG_ALLOWANCE_M = 15.0;
const TURN_SECONDS = 10.0;
const DISCARD_WARN_FRACTION = 0.05;
const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LNG = 111320.0;

const DEG = Math.PI / 180;

/** Initial bearing a→b in °TRUE, −180..180 (equirectangular). (dart:67) */
function bearingDeg(a: LatLng, b: LatLng): number {
  const dLat = b.lat - a.lat;
  const dLng = (b.lng - a.lng) * Math.cos(a.lat * DEG);
  return (Math.atan2(dLng, dLat) * 180) / Math.PI;
}

/**
 * Douglas–Peucker on a 1-D profile using VERTICAL deviation from the chord.
 * Returns sorted kept indices, always including both endpoints. (dart:339)
 */
function douglasPeucker(xs: number[], hs: number[], tol: number): number[] {
  const keep = new Set<number>([0, xs.length - 1]);
  const recurse = (a: number, b: number): void => {
    if (b - a < 2) return;
    let worst = -1;
    let worstDev = tol;
    for (let m = a + 1; m < b; m++) {
      const t = (xs[m] - xs[a]) / (xs[b] - xs[a]);
      const chord = hs[a] + t * (hs[b] - hs[a]);
      const dev = Math.abs(hs[m] - chord);
      if (dev > worstDev) {
        worstDev = dev;
        worst = m;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      recurse(a, worst);
      recurse(worst, b);
    }
  };
  recurse(0, xs.length - 1);
  return [...keep].sort((p, q) => p - q);
}

export interface PlanOptions {
  polygon: LatLng[];
  directionDeg: number;
  spacingM: number;
  aglM: number;
  speedMs: number;
  lz: LatLng;
  elevationAt: ElevationFn;
}

/** Plan serpentine terrain-following transects over one polygon. (dart:74) */
export function plan(opts: PlanOptions): TransectPlan {
  const { polygon, directionDeg, spacingM, aglM, speedMs, lz, elevationAt } = opts;

  if (spacingM <= 0) throw new RangeError(`spacingM must be > 0 (was ${spacingM})`);

  // Normalise the ring: drop a duplicated closing vertex.
  const ring = [...polygon];
  if (ring.length >= 2) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (Math.abs(a.lat - b.lat) < 1e-12 && Math.abs(a.lng - b.lng) < 1e-12) ring.pop();
  }
  if (ring.length < 3) throw new RangeError('polygon needs at least 3 vertices');

  const warnings: string[] = [];

  // 1. Local equirectangular tangent frame at the polygon centroid.
  let lat0 = 0;
  let lng0 = 0;
  for (const p of ring) {
    lat0 += p.lat;
    lng0 += p.lng;
  }
  lat0 /= ring.length;
  lng0 /= ring.length;
  const cosLat0 = Math.cos(lat0 * DEG);

  const toLocal = (p: LatLng): [number, number] => [
    (p.lng - lng0) * cosLat0 * M_PER_DEG_LNG,
    (p.lat - lat0) * M_PER_DEG_LAT,
  ];
  const toLatLng = (x: number, y: number): LatLng => ({
    lat: lat0 + y / M_PER_DEG_LAT,
    lng: lng0 + x / (cosLat0 * M_PER_DEG_LNG),
  });

  // 2. Rotate so transects run along +u at bearing directionDeg.
  const theta = directionDeg * DEG;
  const dx = Math.sin(theta);
  const dy = Math.cos(theta); // along-line
  const px = dy;
  const py = -dx; // cross-line (offset axis)
  const rotate = (x: number, y: number): [number, number] => [x * dx + y * dy, x * px + y * py];
  const unrotate = (u: number, v: number): [number, number] => [u * dx + v * px, u * dy + v * py];

  const rot: [number, number][] = ring.map((p) => {
    const [x, y] = toLocal(p);
    return rotate(x, y);
  });
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [, v] of rot) {
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  // 2/3. Scan lines every spacingM, first inset spacingM/2; clip each to the
  // polygon by even-odd pairing of edge intersections.
  const lines: ClippedLine[] = [];
  let discardedM = 0;
  for (let v = vMin + spacingM / 2; v < vMax - 1e-9; v += spacingM) {
    const crossings: number[] = [];
    for (let i = 0; i < rot.length; i++) {
      const [ua, va] = rot[i];
      const [ub, vb] = rot[(i + 1) % rot.length];
      // Half-open rule so a vertex exactly on the line counts once.
      if ((va <= v && v < vb) || (vb <= v && v < va)) {
        const t = (v - va) / (vb - va);
        crossings.push(ua + t * (ub - ua));
      }
    }
    crossings.sort((p, q) => p - q);
    // Pair even-odd into inside segments; keep the longest, tally the rest.
    let bestU0: number | null = null;
    let bestU1: number | null = null;
    let bestLen = 0;
    let lineDiscard = 0;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const len = crossings[i + 1] - crossings[i];
      if (len < 0.01) continue; // degenerate touch
      if (len > bestLen) {
        if (bestLen > 0) lineDiscard += bestLen;
        bestLen = len;
        bestU0 = crossings[i];
        bestU1 = crossings[i + 1];
      } else {
        lineDiscard += len;
      }
    }
    discardedM += lineDiscard;
    if (bestU0 !== null && bestU1 !== null) lines.push({ v, u0: bestU0, u1: bestU1 });
  }

  let totalLengthM = 0;
  for (const l of lines) totalLengthM += l.u1 - l.u0;
  if (totalLengthM > 0 && discardedM > DISCARD_WARN_FRACTION * totalLengthM) {
    const pct = (100 * discardedM) / totalLengthM;
    warnings.push(
      `Clipping discarded ${discardedM.toFixed(0)} m of transect coverage ` +
        `(${pct.toFixed(1)}% of kept length) — cell shape splits scan lines; ` +
        `only the longest segment per line is flown.`
    );
  }

  if (lines.length === 0) {
    warnings.push(`No transect lines fit inside the polygon at ${spacingM.toFixed(0)} m spacing.`);
    return { transects: [], waypoints: [], lineCount: 0, totalLengthM: 0, estMinutes: 0, warnings };
  }

  // 4. Serpentine order, overall start nearest the LZ.
  const [lzX, lzY] = toLocal(lz);
  const [lzU, lzV] = rotate(lzX, lzY);
  const d2 = (u: number, v: number): number => (u - lzU) ** 2 + (v - lzV) ** 2;

  const first = lines[0];
  const last = lines[lines.length - 1];
  // Candidates: [reverse line order?, start first line at u1 end?, dist²]
  const candidates: [boolean, boolean, number][] = [
    [false, false, d2(first.u0, first.v)],
    [false, true, d2(first.u1, first.v)],
    [true, false, d2(last.u0, last.v)],
    [true, true, d2(last.u1, last.v)],
  ];
  candidates.sort((a, b) => a[2] - b[2]);
  const [reverseOrder, startAtU1] = candidates[0];

  const ordered = reverseOrder ? [...lines].reverse() : lines;

  // 5/6. Densify each line, terrain-follow, simplify, safety pass.
  let elevLz = elevationAt(lz);
  let terrainGap = false;
  if (elevLz === null) {
    terrainGap = true;
    elevLz = 0;
  }
  let lastKnownElev = elevLz;

  const transects: [LatLng, LatLng][] = [];
  const waypoints: Waypoint[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const line = ordered[i];
    // Alternate direction each line; first line per the LZ-nearest choice.
    const forward = i % 2 === 0 ? !startAtU1 : startAtU1;
    const uStart = forward ? line.u0 : line.u1;
    const uEnd = forward ? line.u1 : line.u0;
    const segLen = Math.abs(uEnd - uStart);

    // Sample every ~30 m plus both ends.
    const n = Math.max(1, Math.ceil(segLen / SAMPLE_STEP_M));
    const dist = Array.from({ length: n + 1 }, (_, k) => (segLen * k) / n);
    const pos = Array.from({ length: n + 1 }, (_, k) => {
      const u = uStart + (uEnd - uStart) * (k / n);
      const [x, y] = unrotate(u, line.v);
      return toLatLng(x, y);
    });
    const height = Array.from({ length: n + 1 }, (_, k) => {
      let e = elevationAt(pos[k]);
      if (e === null) {
        terrainGap = true;
        e = lastKnownElev;
      }
      lastKnownElev = e;
      return e - (elevLz as number) + aglM; // relative-to-LZ height (§5.2)
    });

    // Douglas–Peucker on the (distance, height) profile, endpoints kept.
    const keep = douglasPeucker(dist, height, DP_VERTICAL_TOL_M);

    // Safety pass: straight legs must stay within aglM − 15 of the sampled
    // terrain; re-insert the worst violating sample until clean.
    const floor = aglM - SAG_ALLOWANCE_M;
    for (;;) {
      let worstIdx = -1;
      let worstDeficit = 1e-6;
      for (let k = 0; k + 1 < keep.length; k++) {
        const a = keep[k];
        const b = keep[k + 1];
        for (let m = a + 1; m < b; m++) {
          const t = (dist[m] - dist[a]) / (dist[b] - dist[a]);
          const flight = height[a] + t * (height[b] - height[a]);
          // clearance over terrain = flight − (height[m] − aglM)
          const deficit = floor - (flight - height[m] + aglM);
          if (deficit > worstDeficit) {
            worstDeficit = deficit;
            worstIdx = m;
          }
        }
      }
      if (worstIdx < 0) break;
      keep.push(worstIdx);
      keep.sort((p, q) => p - q);
    }

    transects.push([pos[0], pos[pos.length - 1]]);
    // Nose heading down THIS line as flown; set on the line-start waypoint so
    // the aircraft rotates gradually over the entire cross-leg from the
    // previous line's end (field feedback 2026-07-12).
    const lineHeading = bearingDeg(pos[0], pos[pos.length - 1]);
    for (let j = 0; j < keep.length; j++) {
      const k = keep[j];
      waypoints.push({
        pos: pos[k],
        heightM: height[k],
        speedMs,
        alignAtPoint: j === 0,
        headingDeg: j === 0 ? lineHeading : null,
      });
    }
  }

  if (terrainGap) {
    warnings.push(
      'Terrain coverage gap: DSM returned no elevation for one or more samples; ' +
        'last known elevation used as fallback.'
    );
  }

  // Flight-time estimate: length/speed + 10 s per turn.
  const turns = Math.max(0, transects.length - 1);
  const estMinutes = speedMs > 0 ? (totalLengthM / speedMs + turns * TURN_SECONDS) / 60 : 0;

  return {
    transects,
    waypoints,
    lineCount: transects.length,
    totalLengthM,
    estMinutes,
    warnings,
  };
}
