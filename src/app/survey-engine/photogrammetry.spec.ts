/**
 * Golden regression tests for the photogrammetry port.
 *
 * Expected values were produced by an independent transcription of the original
 * Dart formulas (DeployPlanner flight_calculator.dart) and verified to match this
 * TS port to 1e-9. They lock the port against accidental drift. Runs under `ng test`.
 */
import {
  calculate,
  calculateHeight,
  calculateGsd,
  calculateFootprint,
  captureTypes,
  CameraSpec,
  LensSpec,
} from './photogrammetry';

const ct = (t: string) => captureTypes.find((c) => c.type === t)!;
const L = (f: number): LensSpec => ({ name: `${f}mm`, focalLengthMm: f });

const M4E: CameraSpec = { name: 'M4E', sensorWidthMm: 17.3, sensorHeightMm: 13.0, imageWidthPx: 5280, imageHeightPx: 3956 };
const P1: CameraSpec = { name: 'P1', sensorWidthMm: 35.9, sensorHeightMm: 24.0, imageWidthPx: 8192, imageHeightPx: 5460 };
const L2: CameraSpec = { name: 'L2', sensorWidthMm: 17.3, sensorHeightMm: 13.0, imageWidthPx: 5280, imageHeightPx: 3956 };
const M3E: CameraSpec = { name: 'M3E', sensorWidthMm: 17.3, sensorHeightMm: 13.0, imageWidthPx: 5280, imageHeightPx: 3956 };

describe('photogrammetry — core formulas', () => {
  it('height solves from target GSD and round-trips through calculateGsd', () => {
    const h = calculateHeight(2.0, M4E, L(12.3));
    expect(h).toBeCloseTo(75.079769, 5);
    expect(calculateGsd(h, M4E, L(12.3))).toBeCloseTo(2.0, 9);
  });

  it('footprint scales with sensor size / focal length', () => {
    const fp = calculateFootprint(75.079769, M4E, L(12.3));
    expect(fp.widthM).toBeCloseTo(105.6, 3);
    expect(fp.heightM).toBeCloseTo(79.35260, 4);
  });
});

describe('photogrammetry — golden scenarios (vs Dart reference)', () => {
  it('A: M4E, 2cm GSD, nadir ortho — speed capped by overlap', () => {
    const r = calculate({ camera: M4E, lens: L(12.3), targetGsdCm: 2.0, captureType: ct('ortho2d'), aircraftId: 'm4e', aircraftFlightTimeMinutes: 49, mappingSpeedMs: 12 });
    expect(r.heightM).toBeCloseTo(75.079769, 5);
    expect(r.resultingGsdCmPx).toBeCloseTo(2.0, 9);
    expect(r.speedMs).toBeCloseTo(11.90289, 4);   // capped below 12 by min photo interval
    expect(r.triggerDistanceM).toBeCloseTo(23.80578, 4);
    expect(r.lineSpacingM).toBeCloseTo(31.68, 4);
    expect(r.photoIntervalS).toBeCloseTo(2.0, 6);
    expect(r.coveragePerFlightHa).toBeCloseTo(57.648535, 4);
    expect(r.numPasses).toBe(1);
    expect(r.exceedsMaxHeight).toBe(false);
    expect(r.lensRecommendation).toBeNull();
  });

  it('B: P1 24mm, 3cm GSD — exceeds 120m, emits lens advice', () => {
    const r = calculate({ camera: P1, lens: L(24), targetGsdCm: 3.0, captureType: ct('ortho2d'), aircraftId: 'm400', aircraftFlightTimeMinutes: 59, mappingSpeedMs: 12, availableLenses: [L(24), L(35), L(50)] });
    expect(r.heightM).toBeCloseTo(164.296379, 4);
    expect(r.exceedsMaxHeight).toBe(true);
    expect(r.speedMs).toBeCloseTo(12.0, 6);       // full mapping speed (overlap allows)
    expect(r.lineSpacingM).toBeCloseTo(73.728, 3);
    expect(r.lensRecommendation).toContain('No lens achieves this GSD below 120m');
  });

  it('C: L2 LiDAR @80m — altitude-led, GSD is an output', () => {
    const r = calculate({ camera: L2, lens: L(18.1), targetGsdCm: 2.0, captureType: ct('lidarSurveyGrade'), aircraftId: 'm350', aircraftFlightTimeMinutes: 55, targetAltitudeM: 80 });
    expect(r.isLidar).toBe(true);
    expect(r.heightM).toBe(80);
    expect(r.resultingGsdCmPx).toBeCloseTo(1.448183, 5);
    expect(r.speedMs).toBeCloseTo(8.0, 6);        // LiDAR default speed
    expect(r.sideOverlapPct).toBe(50);
    expect(r.lineSpacingM).toBeCloseTo(38.232044, 4);
  });

  it('D: M3E smart oblique — 2 passes, half speed, cross-grid, coverage halved', () => {
    const r = calculate({ camera: M3E, lens: L(12.3), targetGsdCm: 2.0, captureType: ct('smartOblique'), aircraftId: 'm3e', aircraftFlightTimeMinutes: 45, mappingSpeedMs: 12 });
    expect(r.numPasses).toBe(2);
    expect(r.crossGrid).toBe(true);
    expect(r.speedMs).toBeCloseTo(6.0, 6);        // 12 * 0.5 speed factor
    expect(r.coveragePerFlightHa).toBeCloseTo(8.895744, 4);
  });
});
