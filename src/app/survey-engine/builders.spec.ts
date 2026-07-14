import { buildOrbit, buildCorridor, buildPerimeter, applyTerrainFollow } from './builders';
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
  it('aims the gimbal down at the POI (−45° for equal radius & height)', () => {
    const eq = buildOrbit({ center: C, radiusM: 50, pointCount: 8, aglM: 50, speedMs: 5 });
    expect(eq.waypoints[0].gimbalPitchDeg!).toBeCloseTo(-45, 1);
    // Raising the POI to aircraft height flattens the gimbal to horizontal.
    const level = buildOrbit({ center: C, radiusM: 50, pointCount: 8, aglM: 50, speedMs: 5, poiAltM: 50 });
    expect(level.waypoints[0].gimbalPitchDeg!).toBeCloseTo(0, 1);
  });
  it('repeats the circle for multiple loops and captures at every point but the closer', () => {
    const two = buildOrbit({ center: C, radiusM: 100, pointCount: 12, aglM: 40, speedMs: 6, loops: 2 });
    expect(two.waypoints.length).toBe(25); // 12×2 + closing point
    expect(two.lineCount).toBe(2);
    expect(two.totalLengthM).toBeCloseTo(2 * 2 * Math.PI * 100, 0);
    expect(two.waypoints.filter((w) => w.capture).length).toBe(24);
  });
});

describe('builders — terrain follow', () => {
  const line = [at(-200, 0), at(0, 0), at(200, 0)];
  // A ridge in the middle of the corridor: +40 m near lng of C, flat elsewhere.
  const elevationAt = (p: LatLng) => 100 + 40 * Math.exp(-(((p.lng - C.lng) * 111320 / 60) ** 2));
  it('inserts intermediate waypoints over a ridge and bakes AGL-relative heights', () => {
    const flat = buildCorridor({ line, widthM: 0, laneSpacingM: 30, aglM: 60, speedMs: 8 });
    const tf = buildCorridor({ line, widthM: 0, laneSpacingM: 30, aglM: 60, speedMs: 8, terrain: { elevationAt, lzElevMsl: 100, aglM: 60 } });
    expect(tf.waypoints.length).toBeGreaterThan(flat.waypoints.length); // densified over the ridge
    // A waypoint near the ridge crest sits ~AGL above the raised terrain (≈ 60 + 40).
    const peak = Math.max(...tf.waypoints.map((w) => w.heightM));
    expect(peak).toBeGreaterThan(90);
  });
  it('applyTerrainFollow is a no-op on flat terrain', () => {
    const wps = buildOrbit({ center: C, radiusM: 80, pointCount: 12, aglM: 50, speedMs: 5 }).waypoints;
    const out = applyTerrainFollow(wps, { elevationAt: () => 200, lzElevMsl: 200, aglM: 50 });
    expect(out.length).toBe(wps.length);
    for (const w of out) expect(w.heightM).toBeCloseTo(50, 6);
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
