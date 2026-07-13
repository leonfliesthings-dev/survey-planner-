/**
 * Golden + property tests for the transect engine port.
 *
 * The flat-square case has analytically-derived expectations (line count,
 * length, waypoint count). The curved case verifies terrain-follow densification
 * and the exact relative-height formula against the injected surface. Runs under
 * `ng test` (Vitest).
 */
import { plan, ElevationFn } from './transect-engine';
import { LatLng } from './waypoint';

// Build lat/lng from local metres around a centre, using the engine's own
// metres-per-degree constants so the centroid/scan math lines up exactly.
const C: LatLng = { lat: -37.0, lng: 144.0 };
const M_LAT = 110540.0;
const M_LNG = 111320.0;
const cosLat0 = Math.cos((C.lat * Math.PI) / 180);
const at = (eastM: number, northM: number): LatLng => ({
  lat: C.lat + northM / M_LAT,
  lng: C.lng + eastM / (cosLat0 * M_LNG),
});
const northMetresOf = (p: LatLng) => (p.lat - C.lat) * M_LAT;

// 100 m × 100 m square centred on C (centroid = C).
const SQUARE: LatLng[] = [at(-50, -50), at(50, -50), at(50, 50), at(-50, 50)];
const LZ = at(-60, -60);
const AGL = 60;
const SPEED = 5;

describe('transect engine — flat square (analytical golden)', () => {
  const flat: ElevationFn = () => 100;
  const r = plan({ polygon: SQUARE, directionDeg: 0, spacingM: 25, aglM: AGL, speedMs: SPEED, lz: LZ, elevationAt: flat });

  it('lays 4 scan lines at 25 m spacing, ~400 m total', () => {
    expect(r.lineCount).toBe(4);
    expect(r.totalLengthM).toBeCloseTo(400, 1);
    expect(r.warnings.length).toBe(0);
  });

  it('flat terrain → 2 waypoints per line, all at AGL', () => {
    expect(r.waypoints.length).toBe(8);
    for (const w of r.waypoints) expect(w.heightM).toBeCloseTo(AGL, 9);
  });

  it('one aligned line-start per line, with a heading set there', () => {
    expect(r.waypoints.filter((w) => w.alignAtPoint).length).toBe(4);
    for (const w of r.waypoints) {
      if (w.alignAtPoint) expect(w.headingDeg).not.toBeNull();
      else expect(w.headingDeg).toBeNull();
    }
  });

  it('serpentine: consecutive line headings reverse (~180° apart)', () => {
    const headings = r.waypoints.filter((w) => w.alignAtPoint).map((w) => w.headingDeg as number);
    expect(headings.length).toBe(4);
    for (let i = 0; i + 1 < headings.length; i++) {
      let d = Math.abs(headings[i] - headings[i + 1]);
      if (d > 180) d = 360 - d;
      expect(d).toBeCloseTo(180, 3);
    }
  });

  it('flight-time estimate = length/speed + 10 s per turn', () => {
    // (400/5 + 3*10)/60 = (80 + 30)/60
    expect(r.estMinutes).toBeCloseTo((400 / SPEED + 3 * 10) / 60, 3);
  });
});

describe('transect engine — curved surface (terrain follow)', () => {
  // Parabolic ridge along north: forces non-linear profile → densification.
  const surface: ElevationFn = (p) => 100 + 0.02 * northMetresOf(p) ** 2;
  const r = plan({ polygon: SQUARE, directionDeg: 0, spacingM: 25, aglM: AGL, speedMs: SPEED, lz: LZ, elevationAt: surface });

  it('densifies beyond the flat 2-per-line case', () => {
    expect(r.waypoints.length).toBeGreaterThan(8);
    expect(r.warnings.length).toBe(0);
  });

  it('every waypoint height = dsm(pos) − dsm(lz) + AGL, exactly', () => {
    const elevLz = surface(LZ) as number;
    for (const w of r.waypoints) {
      const expected = (surface(w.pos) as number) - elevLz + AGL;
      expect(w.heightM).toBeCloseTo(expected, 9);
    }
  });
});

describe('transect engine — guards & degenerate cases', () => {
  const flat: ElevationFn = () => 0;

  it('throws on non-positive spacing', () => {
    expect(() => plan({ polygon: SQUARE, directionDeg: 0, spacingM: 0, aglM: AGL, speedMs: SPEED, lz: LZ, elevationAt: flat })).toThrow();
  });

  it('throws on a polygon with fewer than 3 vertices', () => {
    expect(() => plan({ polygon: [at(0, 0), at(10, 10)], directionDeg: 0, spacingM: 5, aglM: AGL, speedMs: SPEED, lz: LZ, elevationAt: flat })).toThrow();
  });

  it('spacing wider than the polygon → empty plan + warning', () => {
    // First line is inset spacing/2 = 125 m, past the 100 m square → no lines.
    const r = plan({ polygon: SQUARE, directionDeg: 0, spacingM: 250, aglM: AGL, speedMs: SPEED, lz: LZ, elevationAt: flat });
    expect(r.lineCount).toBe(0);
    expect(r.waypoints.length).toBe(0);
    expect(r.warnings.some((w) => w.includes('No transect lines fit'))).toBe(true);
  });
});
