import { planFlight } from './planning';
import { captureTypes, CameraSpec, LensSpec, calculateGsd } from './photogrammetry';

const M4E: CameraSpec = { name: 'M4E', sensorWidthMm: 17.3, sensorHeightMm: 13.0, imageWidthPx: 5280, imageHeightPx: 3956 };
const LENS: LensSpec = { name: '24mm eq', focalLengthMm: 12.3 };
const ortho = captureTypes.find((c) => c.type === 'ortho2d')!;

describe('planning — GSD ⇄ height interchange', () => {
  it('height mode derives GSD and reproduces the input height', () => {
    const r = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'height', targetHeightM: 80 });
    expect(r.fp.heightM).toBeCloseTo(80, 4);
    expect(r.gsdCm).toBeCloseTo(calculateGsd(80, M4E, LENS), 6);
  });
  it('gsd mode matches a height-mode plan at the equivalent height', () => {
    const g = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'gsd', targetGsdCm: 2 });
    const h = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'height', targetHeightM: g.fp.heightM });
    expect(h.gsdCm).toBeCloseTo(2, 6);
  });
});

describe('planning — 120 m AGL warning', () => {
  it('warns when derived height exceeds 120 m', () => {
    const r = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'height', targetHeightM: 150 });
    expect(r.warnings.some((w) => w.includes('above the 120 m'))).toBe(true);
  });
  it('no height warning under 120 m', () => {
    const r = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'height', targetHeightM: 80 });
    expect(r.warnings.some((w) => w.includes('above the 120 m'))).toBe(false);
  });
});

describe('planning — camera overwhelm', () => {
  it('warns and reports a max safe speed when the shutter cannot keep up', () => {
    // Low altitude → small trigger distance; force a fast speed override.
    const r = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'height', targetHeightM: 40, speedOverrideMs: 18, minPhotoIntervalS: 2 });
    expect(r.effectiveSpeedMs).toBe(18);
    expect(r.warnings.some((w) => w.includes("Camera can't keep up"))).toBe(true);
    expect(r.maxSafeSpeedMs).toBeCloseTo(r.fp.triggerDistanceM / 2, 6);
  });
  it('no overwhelm at the engine-recommended (auto) speed', () => {
    const r = planFlight({ camera: M4E, lens: LENS, captureType: ortho, mode: 'gsd', targetGsdCm: 2 });
    expect(r.effectiveSpeedMs).toBe(r.recommendedSpeedMs);
    expect(r.warnings.some((w) => w.includes("Camera can't keep up"))).toBe(false);
  });
});
