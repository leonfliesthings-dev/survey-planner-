/**
 * Extra mission builders — orbit, corridor, perimeter — matching GCS
 * (QGroundControl) semantics. Each returns a TransectPlan (same shape as the
 * grid transect engine) with `Waypoint[]` whose `alignAtPoint`/`headingDeg` drive
 * the shared Autofly emitter's interval-shot capture. Pure geometry, tested.
 */
import { LatLng, Waypoint } from './waypoint';
import { TransectPlan } from './transect-engine';
import { offsetPolyline, bufferPolygonMeters, distanceM, bearingDeg, destination } from './geo';

const TURN_SECONDS = 10;

// ── Terrain follow: sample terrain under the flown path and re-bake heights,
// inserting intermediate waypoints where the surface deviates from a straight
// leg (Douglas-Peucker on the AGL profile — same idea as the transect engine).
export interface TerrainFollow {
  elevationAt: (p: LatLng) => number | null;
  lzElevMsl: number; // terrain elevation at the take-off point (MSL)
  aglM: number; // target height above ground
}
// Douglas–Peucker on a 1-D (distance, height) profile: keep only the samples
// whose vertical deviation from the chord exceeds `tol`. Endpoints always kept.
function douglasPeucker1D(xs: number[], hs: number[], tol: number): number[] {
  const keep = new Set<number>([0, xs.length - 1]);
  const recurse = (a: number, b: number): void => {
    if (b - a < 2) return;
    let worst = -1, worstDev = tol;
    for (let m = a + 1; m < b; m++) {
      const t = (xs[m] - xs[a]) / (xs[b] - xs[a]);
      const chord = hs[a] + t * (hs[b] - hs[a]);
      const dev = Math.abs(hs[m] - chord);
      if (dev > worstDev) { worstDev = dev; worst = m; }
    }
    if (worst >= 0) { keep.add(worst); recurse(a, worst); recurse(worst, b); }
  };
  recurse(0, xs.length - 1);
  return [...keep].sort((p, q) => p - q);
}

export function applyTerrainFollow(waypoints: Waypoint[], tf: TerrainFollow): Waypoint[] {
  if (waypoints.length === 0) return waypoints;
  // Match the area-survey engine: sample the surface every 12 m along each leg,
  // then keep an extra altitude waypoint only where the terrain deviates > 5 m
  // from a straight line (Douglas–Peucker). Flat/linear ground adds nothing.
  const STEP_M = 12, TOL_M = 5;
  const h = (p: LatLng): number => tf.aglM + ((tf.elevationAt(p) ?? tf.lzElevMsl) - tf.lzElevMsl);
  const out: Waypoint[] = [{ ...waypoints[0], heightM: h(waypoints[0].pos) }];
  for (let i = 1; i < waypoints.length; i++) {
    const seg = waypoints[i];
    const a = waypoints[i - 1].pos, b = seg.pos;
    const segLen = distanceM(a, b);
    const n = Math.floor(segLen / STEP_M);
    if (n >= 1) {
      const xs = [0], hs = [h(a)], pts: LatLng[] = [a];
      for (let k = 1; k <= n; k++) {
        const t = (k * STEP_M) / segLen;
        const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
        xs.push(k * STEP_M); hs.push(h(p)); pts.push(p);
      }
      xs.push(segLen); hs.push(h(b)); pts.push(b);
      for (const idx of douglasPeucker1D(xs, hs, TOL_M)) {
        if (idx === 0 || idx === pts.length - 1) continue; // endpoints handled outside
        out.push({ pos: pts[idx], heightM: hs[idx], speedMs: seg.speedMs, alignAtPoint: false, headingDeg: null, capture: false });
      }
    }
    out.push({ ...seg, heightM: h(b) });
  }
  return out;
}

// ── Orbit: circle(s) of waypoints around a point, camera aimed at the POI ──
export interface OrbitOptions {
  center: LatLng;
  radiusM: number;
  pointCount: number;
  aglM: number;
  speedMs: number;
  clockwise?: boolean;
  loops?: number; // number of times around, default 1
  poiAltM?: number; // POI height above take-off (m) — raises the aim point up a structure
  terrain?: TerrainFollow; // when set, re-bake heights + densify to follow terrain
}
export function buildOrbit(o: OrbitOptions): TransectPlan {
  if (o.radiusM <= 0) throw new RangeError('orbit radius must be > 0');
  const n = Math.max(3, Math.round(o.pointCount));
  const loops = Math.max(1, Math.round(o.loops ?? 1));
  const sign = o.clockwise === false ? -1 : 1;
  // Gimbal depression so the camera looks AT the POI: vertical drop from the
  // aircraft (aglM) to the POI (poiAltM), horizontal = radius.
  const pitch = -(Math.atan2(o.aglM - (o.poiAltM ?? 0), o.radiusM) * 180) / Math.PI;
  const gimbalPitchDeg = Math.max(-90, Math.min(30, pitch));
  const total = n * loops;
  let waypoints: Waypoint[] = [];
  for (let k = 0; k <= total; k++) {
    const ang = ((sign * 360 * (k % n)) / n + 360) % 360;
    const pos = destination(o.center, o.radiusM, ang);
    waypoints.push({ pos, heightM: o.aglM, speedMs: o.speedMs, alignAtPoint: k === 0, headingDeg: bearingDeg(pos, o.center), gimbalPitchDeg, capture: k < total });
  }
  if (o.terrain) waypoints = applyTerrainFollow(waypoints, o.terrain);
  const totalLengthM = 2 * Math.PI * o.radiusM * loops;
  return {
    transects: [[waypoints[0].pos, waypoints[Math.floor(n / 2)].pos]],
    waypoints,
    lineCount: loops,
    totalLengthM,
    estMinutes: o.speedMs > 0 ? totalLengthM / o.speedMs / 60 : 0,
    warnings: [],
  };
}

// ── Corridor: parallel offset lanes along a centreline polyline ──
export interface CorridorOptions {
  line: LatLng[];
  widthM: number;
  laneSpacingM: number; // = side-overlap footprint spacing (used when lanes not given)
  aglM: number;
  speedMs: number;
  turnaroundM?: number;
  lanes?: number; // explicit number of parallel runs; 0/undefined = auto from width/spacing
  terrain?: TerrainFollow; // when set, re-bake heights + densify to follow terrain
}
export function buildCorridor(o: CorridorOptions): TransectPlan {
  if (o.line.length < 2) throw new RangeError('corridor needs a line of at least 2 points');
  const spacing0 = Math.max(1, o.laneSpacingM);
  let laneCount: number;
  let laneSpacing: number;
  if (o.lanes && o.lanes > 0) {
    laneCount = Math.round(o.lanes);
    laneSpacing = o.widthM > 0 && laneCount > 0 ? o.widthM / laneCount : spacing0; // spread runs across the width
  } else {
    laneCount = o.widthM <= 0 ? 1 : Math.max(1, Math.ceil(o.widthM / spacing0));
    laneSpacing = spacing0;
  }
  const half = o.widthM / 2;
  const turn = o.turnaroundM ?? 0;

  const waypoints: Waypoint[] = [];
  const transects: [LatLng, LatLng][] = [];
  let totalLengthM = 0;

  for (let i = 0; i < laneCount; i++) {
    const offset = laneCount === 1 ? 0 : half - (laneSpacing / 2 + i * laneSpacing);
    let lane = offsetPolyline(o.line, offset);
    if (turn > 0 && lane.length >= 2) {
      lane = [
        destination(lane[0], turn, bearingDeg(lane[1], lane[0])),
        ...lane,
        destination(lane[lane.length - 1], turn, bearingDeg(lane[lane.length - 2], lane[lane.length - 1])),
      ];
    }
    const seq = i % 2 === 0 ? lane : [...lane].reverse(); // serpentine
    transects.push([seq[0], seq[seq.length - 1]]);
    for (let j = 0; j < seq.length; j++) {
      const heading = j + 1 < seq.length ? bearingDeg(seq[j], seq[j + 1]) : bearingDeg(seq[j - 1], seq[j]);
      waypoints.push({ pos: seq[j], heightM: o.aglM, speedMs: o.speedMs, alignAtPoint: j === 0, headingDeg: heading });
      if (j > 0) totalLengthM += distanceM(seq[j - 1], seq[j]);
    }
  }
  const turns = Math.max(0, laneCount - 1);
  return {
    transects,
    waypoints: o.terrain ? applyTerrainFollow(waypoints, o.terrain) : waypoints,
    lineCount: laneCount,
    totalLengthM,
    estMinutes: o.speedMs > 0 ? (totalLengthM / o.speedMs + turns * TURN_SECONDS) / 60 : 0,
    warnings: [],
  };
}

// ── Perimeter: fly the polygon boundary offset outward by a standoff ──
export interface PerimeterOptions {
  polygon: LatLng[];
  standoffM: number; // outward offset of the innermost run from the structure
  aglM: number;
  speedMs: number;
  spacingAlongM?: number; // (unused) photos are driven by interval capture, not waypoints
  runs?: number; // number of concentric loops, default 1
  runSpacingM?: number; // spacing between runs — driven by image side-overlap footprint
  terrain?: TerrainFollow; // when set, re-bake heights + densify to follow terrain
}
export function buildPerimeter(o: PerimeterOptions): TransectPlan {
  if (o.polygon.length < 3) throw new RangeError('perimeter needs a polygon of at least 3 vertices');
  const runs = Math.max(1, Math.round(o.runs ?? 1));
  const runSpacing = o.runSpacingM ?? 0;

  // A waypoint at each boundary vertex only; the camera faces ALONG the flight
  // track (bearing to the next vertex). Photos come from interval capture, and
  // terrain follow inserts altitude waypoints where the surface needs them.
  const waypoints: Waypoint[] = [];
  const rings: LatLng[][] = [];
  let totalLengthM = 0;
  let prev: LatLng | null = null;
  for (let run = 0; run < runs; run++) {
    // Each run is a concentric loop, stepped outward by the overlap-driven spacing.
    const offset = o.standoffM + run * runSpacing;
    const ring = offset !== 0 ? bufferPolygonMeters(o.polygon, offset) : [...o.polygon];
    rings.push(ring);
    const closed = [...ring, ring[0]]; // return to the first vertex
    for (let v = 0; v < closed.length; v++) {
      const pos = closed[v];
      const headingDeg = v + 1 < closed.length ? bearingDeg(pos, closed[v + 1]) : bearingDeg(closed[v - 1], pos);
      waypoints.push({ pos, heightM: o.aglM, speedMs: o.speedMs, alignAtPoint: v === 0, headingDeg });
      if (prev) totalLengthM += distanceM(prev, pos);
      prev = pos;
    }
  }

  return {
    transects: [[rings[0][0], rings[0][Math.floor(rings[0].length / 2)]]],
    waypoints: o.terrain ? applyTerrainFollow(waypoints, o.terrain) : waypoints,
    lineCount: runs,
    totalLengthM,
    estMinutes: o.speedMs > 0 ? totalLengthM / o.speedMs / 60 : 0,
    warnings: [],
  };
}
