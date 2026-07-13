import { buildOrbit, buildCorridor, buildPerimeter } from './builders';
import { distanceM } from './geo';
import { LatLng } from './waypoint';

const C: LatLng = { lat: -37.0, lng: 144.0 };
const cosLat = Math.cos((C.lat * Math.PI) / 180);
const at = (eastM: number, northM: number): LatLng => ({ lat: C.lat + northM / 110540, lng: C.lng + eastM / (cosLat * 111320) });

describe('builders — orbit', () => {
  const r = buildOrbit({ center: C, radiusM: 100, pointCount: 12, aglM: 40, speedMs: 6 });
  it('places N+1 points (closed loop) on the radius', () => {
    expect(r.waypoints.length).toBe(13);
    // equirectangular vs haversine differ ~0.6% → allow ~1.5 m on a 100 m radius
    for (const w of r.waypoints) expect(Math.abs(distanceM(C, w.pos) - 100)).toBeLessThan(1.5);
  });
  it('every waypoint faces the centre and only the first is a run-start', () => {
    for (const w of r.waypoints) expect(w.headingDeg).not.toBeNull();
    expect(r.waypoints.filter((w) => w.alignAtPoint).length).toBe(1);
    expect(r.totalLengthM).toBeCloseTo(2 * Math.PI * 100, 0);
  });
});

describe('builders — corridor', () => {
  const line = [at(-200, 0), at(0, 0), at(200, 0)]; // east-west centreline
  it('splits a 60 m corridor into 2 lanes at 30 m spacing', () => {
    const r = buildCorridor({ line, widthM: 60, laneSpacingM: 30, aglM: 60, speedMs: 8 });
    expect(r.lineCount).toBe(2);
    expect(r.waypoints.filter((w) => w.alignAtPoint).length).toBe(2); // one start per lane
    expect(r.totalLengthM).toBeGreaterThan(700); // ~2 × 400 m lanes
  });
  it('single pass when width is 0', () => {
    const r = buildCorridor({ line, widthM: 0, laneSpacingM: 30, aglM: 60, speedMs: 8 });
    expect(r.lineCount).toBe(1);
  });
});

describe('builders — perimeter', () => {
  const square: LatLng[] = [at(-50, -50), at(50, -50), at(50, 50), at(-50, 50)];
  it('offsets outward by the standoff and loops closed', () => {
    const r = buildPerimeter({ polygon: square, standoffM: 20, aglM: 50, speedMs: 5, spacingAlongM: 20 });
    expect(r.lineCount).toBe(1);
    expect(r.waypoints.filter((w) => w.alignAtPoint).length).toBe(1);
    // 100 m square + 20 m standoff each side ≈ 140 m sides → perimeter ≈ 560 m.
    expect(r.totalLengthM).toBeGreaterThan(500);
    expect(r.totalLengthM).toBeLessThan(620);
    // loop closes back to the start vertex
    const first = r.waypoints[0].pos, last = r.waypoints[r.waypoints.length - 1].pos;
    expect(distanceM(first, last)).toBeLessThan(1);
  });
});
