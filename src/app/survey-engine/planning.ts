/**
 * Planning helper: resolves the interchangeable GSD ⇄ AGL-height inputs, applies
 * a user speed override, and raises the operational warnings (>120 m AGL, and
 * camera-overwhelm when the shutter can't keep up at the chosen speed).
 * Pure — wraps the photogrammetry engine. Tested.
 */
import { CameraSpec, LensSpec, CaptureTypeConfig, FlightParameters, calculate, calculateGsd } from './photogrammetry';

export const MAX_AGL_M = 120;
/** Conservative default min interval between photos (s). */
export const DEFAULT_MIN_PHOTO_INTERVAL_S = 2.0;

export type PlanMode = 'gsd' | 'height';

export interface PlanningInput {
  camera: CameraSpec;
  lens: LensSpec;
  captureType: CaptureTypeConfig;
  mode: PlanMode;
  targetGsdCm?: number; // used when mode = 'gsd'
  targetHeightM?: number; // used when mode = 'height'
  mappingSpeedMs?: number; // default cruise / auto-speed ceiling
  speedOverrideMs?: number | null; // user-set flight speed (null = use recommended)
  minPhotoIntervalS?: number;
  aircraftFlightTimeMinutes?: number;
}

export interface PlanningResult {
  fp: FlightParameters;
  gsdCm: number; // effective GSD (input or derived from height)
  effectiveSpeedMs: number; // speed actually used for the mission
  recommendedSpeedMs: number; // engine's auto (overlap-safe) speed
  photoIntervalS: number; // photo cadence at effectiveSpeed
  maxSafeSpeedMs: number; // fastest speed that keeps the camera happy
  warnings: string[];
}

export function planFlight(input: PlanningInput): PlanningResult {
  const minInt = input.minPhotoIntervalS ?? DEFAULT_MIN_PHOTO_INTERVAL_S;
  const mapping = input.mappingSpeedMs ?? 12;

  // GSD ⇄ height are interchangeable: derive GSD from height if that's the input.
  const gsdCm =
    input.mode === 'height'
      ? calculateGsd(input.targetHeightM ?? 0, input.camera, input.lens)
      : input.targetGsdCm ?? 0;

  const fp = calculate({
    camera: input.camera,
    lens: input.lens,
    targetGsdCm: gsdCm,
    captureType: input.captureType,
    mappingSpeedMs: mapping,
    minPhotoIntervalS: minInt,
    aircraftFlightTimeMinutes: input.aircraftFlightTimeMinutes ?? 45,
    availableLenses: [input.lens],
  });

  const override = input.speedOverrideMs;
  const effectiveSpeedMs = override && override > 0 ? override : fp.speedMs;
  const photoIntervalS = fp.triggerDistanceM / effectiveSpeedMs;
  const maxSafeSpeedMs = fp.triggerDistanceM / minInt;

  const warnings: string[] = [];
  if (fp.heightM > MAX_AGL_M) {
    warnings.push(
      `Flight height ${fp.heightM.toFixed(0)} m is above the 120 m AGL limit.` +
        (fp.lensRecommendation ? ` ${fp.lensRecommendation}.` : '')
    );
  }
  if (photoIntervalS < minInt - 1e-9) {
    warnings.push(
      `Camera can't keep up: at ${effectiveSpeedMs.toFixed(1)} m/s it would need a photo every ` +
        `${photoIntervalS.toFixed(1)} s, but the camera needs ≥ ${minInt.toFixed(1)} s. ` +
        `Reduce speed to ≤ ${maxSafeSpeedMs.toFixed(1)} m/s.`
    );
  }

  return { fp, gsdCm, effectiveSpeedMs, recommendedSpeedMs: fp.speedMs, photoIntervalS, maxSafeSpeedMs, warnings };
}
