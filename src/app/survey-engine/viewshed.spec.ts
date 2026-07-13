import { analyseViewshed } from './viewshed';
import { LatLng } from './waypoint';

const LZ: LatLng = { lat: -37.0, lng: 144.0 };
const mLng = 111320 * Math.cos((LZ.lat * Math.PI) / 180);
const eastM = (p: LatLng) => (p.lng - LZ.lng) * mLng;
const northM = (p: LatLng) => (p.lat - LZ.lat) * 111320;

describe('viewshed', () => {
  it('flat terrain → every radial clear', () => {
    const vs = analyseViewshed({ lz: LZ, flightHeightAGL: 60, maxRangeM: 300, elevationAt: () => 100 });
    expect(vs.totalRadials).toBe(36);
    expect(vs.clearRadials).toBe(36);
    expect(vs.clearPercent).toBe(100);
  });

  it('a tall wall to the east obstructs the eastern radial but not the north', () => {
    // 500 m wall at 90–130 m east; flat 100 m elsewhere.
    const wall = (p: LatLng) => (Math.abs(northM(p)) < 25 && eastM(p) >= 90 && eastM(p) <= 130 ? 500 : 100);
    const vs = analyseViewshed({ lz: LZ, flightHeightAGL: 60, maxRangeM: 300, elevationAt: wall });
    const east = vs.radials.find((r) => r.bearingDeg === 90)!;
    const north = vs.radials.find((r) => r.bearingDeg === 0)!;
    expect(east.obstructed).toBe(true);
    expect(east.clearDistM).toBeLessThan(300); // visibility cut short by the wall
    expect(north.obstructed).toBe(false);
    expect(vs.clearRadials).toBeLessThan(36);
    // Per-cell data for the wedge rendering.
    expect(vs.stepM).toBe(50);
    expect(east.stepsClear.some((c) => !c)).toBe(true); // some cells blocked behind the wall
    expect(north.stepsClear.every((c) => c)).toBe(true); // northern cells all clear
  });
});
