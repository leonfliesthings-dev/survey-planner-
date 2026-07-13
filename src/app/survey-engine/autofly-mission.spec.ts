/**
 * Golden tests for the Autofly mission emitter — asserts the exact camera-action
 * sequence and route-point schema against a real transect plan. Runs under Vitest.
 */
import { emitAutoflyMission } from './autofly-mission';
import { plan, ElevationFn } from './transect-engine';
import { LatLng } from './waypoint';

const C: LatLng = { lat: -37.0, lng: 144.0 };
const cosLat0 = Math.cos((C.lat * Math.PI) / 180);
const at = (eastM: number, northM: number): LatLng => ({
  lat: C.lat + northM / 110540,
  lng: C.lng + eastM / (cosLat0 * 111320),
});
const SQUARE: LatLng[] = [at(-50, -50), at(50, -50), at(50, 50), at(-50, 50)];

// Flat transect → 4 lines, 8 waypoints (2 per line).
const transect = plan({
  polygon: SQUARE, directionDeg: 0, spacingM: 25, aglM: 60, speedMs: 8,
  lz: at(-60, -60), elevationAt: (() => 100) as ElevationFn,
});
const PHOTO_SPACING = 23.8;

describe('autofly emitter — mission envelope', () => {
  const m = emitAutoflyMission({ name: 'Test Survey', waypoints: transect.waypoints, photoSpacingM: PHOTO_SPACING });

  it('is a waypoint mission with matching count', () => {
    expect(m.type).toBe('waypoint');
    expect(m.name).toBe('Test Survey');
    expect(m.waypointCount).toBe(m.route.length);
    expect(m.route.length).toBe(8);
  });

  it('every point is nadir, gimbal 0, carries speed + relative altitude', () => {
    for (const p of m.route) {
      expect(p.pitch).toBe(-90);
      expect(p.gimbal).toBe(0);
      expect(p.speed).toBe(8);
      expect(p.altitude).toBeCloseTo(60, 6); // flat terrain → AGL
      expect(p.altitudeEGM).toBeUndefined(); // no take-off MSL supplied
    }
  });
});

describe('autofly emitter — camera action weld', () => {
  const m = emitAutoflyMission({ name: 'S', waypoints: transect.waypoints, photoSpacingM: PHOTO_SPACING });
  const starts = m.route.filter((p) => p.actions.some((a) => a.action === 'START_DISTANCE_INTERVAL_SHOT'));
  const stops = m.route.filter((p) => p.actions.some((a) => a.action === 'STOP_INTERVAL_SHOT'));

  it('one START and one STOP interval-shot per line', () => {
    expect(starts.length).toBe(transect.lineCount); // 4
    expect(stops.length).toBe(transect.lineCount); // 4
  });

  it('line-start action sequence = GIMBAL_PITCH, AIRCRAFT_YAW, START_DISTANCE_INTERVAL_SHOT', () => {
    const first = m.route[0];
    expect(first.actions.map((a) => a.action)).toEqual([
      'GIMBAL_PITCH',
      'AIRCRAFT_YAW',
      'START_DISTANCE_INTERVAL_SHOT',
    ]);
    expect(first.actions[0].param).toBe('-90');
    expect(first.actions[2].param).toBe('23.8'); // photo spacing, metres
  });

  it('the START point maps to an aligned line-start waypoint', () => {
    // route[0] is the first line start
    expect(transect.waypoints[0].alignAtPoint).toBe(true);
    expect(m.route[0].heading).toBe(Math.round(transect.waypoints[0].headingDeg as number));
  });
});

describe('autofly emitter — absolute altitude + guards', () => {
  it('populates altitudeEGM when a take-off MSL is given', () => {
    const m = emitAutoflyMission({ name: 'S', waypoints: transect.waypoints, photoSpacingM: PHOTO_SPACING, takeoffElevationMslM: 435, heightMode: 'EGM96' });
    expect(m.heightMode).toBe('EGM96');
    for (const p of m.route) expect(p.altitudeEGM).toBeCloseTo(p.altitude + 435, 6);
  });

  it('throws on empty waypoints or non-positive spacing', () => {
    expect(() => emitAutoflyMission({ name: 'S', waypoints: [], photoSpacingM: 10 })).toThrow();
    expect(() => emitAutoflyMission({ name: 'S', waypoints: transect.waypoints, photoSpacingM: 0 })).toThrow();
  });
});
