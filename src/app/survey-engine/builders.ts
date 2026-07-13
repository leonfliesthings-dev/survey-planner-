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

// ── Orbit: circle of waypoints around a point, nose facing the centre ──
export interface OrbitOptions {
  center: LatLng;
  radiusM: number;
  pointCount: number;
  aglM: number;
  speedMs: number;
  clockwise?: boolean;
}
export function buildOrbit(o: OrbitOptions): TransectPlan {
  if (o.radiusM <= 0) throw new RangeError('orbit radius must be > 0');
  const n = Math.max(3, Math.round(o.pointCount));
  const sign = o.clockwise === false ? -1 : 1;
  const waypoints: Waypoint[] = [];
  for (let k = 0; k <= n; k++) {
    const ang = ((sign * 360 * (k % n)) / n + 360) % 360;
    const pos = destination(o.center, o.radiusM, ang);
    waypoints.push({ pos, heightM: o.aglM, speedMs: o.speedMs, alignAtPoint: k === 0, headingDeg: bearingDeg(pos, o.center) });
  }
  const totalLengthM = 2 * Math.PI * o.radiusM;
  return {
    transects: [[waypoints[0].pos, waypoints[Math.floor(n / 2)].pos]],
    waypoints,
    lineCount: 1,
    totalLengthM,
    estMinutes: o.speedMs > 0 ? totalLengthM / o.speedMs / 60 : 0,
    warnings: [],
  };
}

// ── Corridor: parallel offset lanes along a centreline polyline ──
export interface CorridorOptions {
  line: LatLng[];
  widthM: number;
  laneSpacingM: number; // = side-overlap footprint spacing
  aglM: number;
  speedMs: number;
  turnaroundM?: number;
}
export function buildCorridor(o: CorridorOptions): TransectPlan {
  if (o.line.length < 2) throw new RangeError('corridor needs a line of at least 2 points');
  const spacing = Math.max(1, o.laneSpacingM);
  const laneCount = o.widthM <= 0 ? 1 : Math.max(1, Math.ceil(o.widthM / spacing));
  const half = o.widthM / 2;
  const turn = o.turnaroundM ?? 0;

  const waypoints: Waypoint[] = [];
  const transects: [LatLng, LatLng][] = [];
  let totalLengthM = 0;

  for (let i = 0; i < laneCount; i++) {
    const offset = laneCount === 1 ? 0 : half - (spacing / 2 + i * spacing);
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
    waypoints,
    lineCount: laneCount,
    totalLengthM,
    estMinutes: o.speedMs > 0 ? (totalLengthM / o.speedMs + turns * TURN_SECONDS) / 60 : 0,
    warnings: [],
  };
}

// ── Perimeter: fly the polygon boundary offset outward by a standoff ──
export interface PerimeterOptions {
  polygon: LatLng[];
  standoffM: number; // outward offset from the structure
  aglM: number;
  speedMs: number;
  spacingAlongM: number; // photo/waypoint spacing along the perimeter
}
export function buildPerimeter(o: PerimeterOptions): TransectPlan {
  if (o.polygon.length < 3) throw new RangeError('perimeter needs a polygon of at least 3 vertices');
  const ring = o.standoffM !== 0 ? bufferPolygonMeters(o.polygon, o.standoffM) : [...o.polygon];
  let clat = 0, clng = 0;
  for (const p of o.polygon) { clat += p.lat; clng += p.lng; }
  const center: LatLng = { lat: clat / o.polygon.length, lng: clng / o.polygon.length };
  const spacing = Math.max(2, o.spacingAlongM);
  const closed = [...ring, ring[0]];

  const waypoints: Waypoint[] = [];
  let totalLengthM = 0;
  for (let e = 0; e + 1 < closed.length; e++) {
    const a = closed[e], b = closed[e + 1];
    const steps = Math.max(1, Math.ceil(distanceM(a, b) / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const pos = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      waypoints.push({ pos, heightM: o.aglM, speedMs: o.speedMs, alignAtPoint: waypoints.length === 0, headingDeg: bearingDeg(pos, center) });
      if (waypoints.length > 1) totalLengthM += distanceM(waypoints[waypoints.length - 2].pos, pos);
    }
  }
  // Close the loop back to the first vertex.
  waypoints.push({ pos: closed[0], heightM: o.aglM, speedMs: o.speedMs, alignAtPoint: false, headingDeg: bearingDeg(closed[0], center) });
  totalLengthM += distanceM(waypoints[waypoints.length - 2].pos, closed[0]);

  return {
    transects: [[ring[0], ring[Math.floor(ring.length / 2)]]],
    waypoints,
    lineCount: 1,
    totalLengthM,
    estMinutes: o.speedMs > 0 ? totalLengthM / o.speedMs / 60 : 0,
    warnings: [],
  };
}
