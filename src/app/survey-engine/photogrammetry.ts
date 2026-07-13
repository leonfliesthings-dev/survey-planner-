/**
 * Photogrammetry engine — flight height / speed / pattern from camera specs,
 * lens, target GSD and capture type.
 *
 * Faithful TypeScript port of DeployPlanner:
 *   app/lib/services/flight_calculator.dart  (class FlightCalculator)
 * Formulas and defaults are transcribed 1:1; line refs noted inline.
 * Pure module — no framework, DOM, or I/O imports.
 */

export interface CameraSpec {
  name: string;
  sensorWidthMm: number;
  sensorHeightMm: number;
  imageWidthPx: number;
  imageHeightPx: number;
}

export interface LensSpec {
  name: string;
  focalLengthMm: number;
}

export type CaptureType =
  | 'ortho2d'
  | 'flat3d'
  | 'smartOblique'
  | 'lidarSurveyGrade'
  | 'lidarEcological';

export interface CaptureTypeConfig {
  type: CaptureType;
  name: string;
  description: string;
  frontOverlapPct: number;
  sideOverlapPct: number;
  cameraAngleDeg: number; // 90 = nadir, 75 = oblique
  crossGrid: boolean;
  numPasses: number;
  isLidar?: boolean;
  defaultAltitudeM?: number;
  defaultSpeedMs?: number;
}

export interface FlightParameters {
  heightM: number;
  speedMs: number;
  gsdCmPx: number;
  resultingGsdCmPx: number;
  frontOverlapPct: number;
  sideOverlapPct: number;
  cameraAngleDeg: number;
  crossGrid: boolean;
  numPasses: number;
  photoIntervalS: number;
  lineSpacingM: number;
  triggerDistanceM: number;
  captureTypeName: string;
  coveragePerFlightHa: number;
  linealDistancePerFlightKm: number;
  forecastAccuracyHorizontalCm: number;
  forecastAccuracyVerticalCm: number;
  exceedsMaxHeight: boolean;
  resultingGsdExceedsTarget: boolean;
  isLidar: boolean;
  lensRecommendation: string | null;
}

// ── Constants (flight_calculator.dart:117-126) ──
export const FlightConstants = {
  maxHeightM: 120.0,
  defaultBatteryReservePct: 20.0,
  surveyEfficiency: 0.65, // 65% of flight time is actual survey
  forecastAccuracyHorizontalMultiplier: 1.5,
  forecastAccuracyVerticalMultiplier: 2.0,
} as const;

// Mirrors Dart's num.clamp(lower, upper).
const clampNum = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(v, lo), hi);

// ── Capture type configs (flight_calculator.dart:199-256) ──
export const captureTypes: CaptureTypeConfig[] = [
  { type: 'ortho2d', name: '2.5D Ortho', description: 'Nadir capture, single grid — orthomosaic & DSM', frontOverlapPct: 70, sideOverlapPct: 70, cameraAngleDeg: 90, crossGrid: false, numPasses: 1 },
  { type: 'flat3d', name: '3D Flat Terrain', description: '75° oblique camera, cross-grid pattern', frontOverlapPct: 75, sideOverlapPct: 75, cameraAngleDeg: 75, crossGrid: true, numPasses: 2 },
  { type: 'smartOblique', name: 'Smart Oblique', description: 'Gimbal rotates to capture nadir + oblique angles per waypoint', frontOverlapPct: 80, sideOverlapPct: 80, cameraAngleDeg: 45, crossGrid: false, numPasses: 1 },
  { type: 'lidarSurveyGrade', name: 'Survey Grade', description: 'LiDAR-anchored survey grade — dense point cloud, RGB ortho draped on LiDAR surface', frontOverlapPct: 70, sideOverlapPct: 50, cameraAngleDeg: 90, crossGrid: false, numPasses: 1, isLidar: true, defaultAltitudeM: 80, defaultSpeedMs: 8 },
  { type: 'lidarEcological', name: 'Ecological Orthomosaic', description: 'LiDAR-anchored ortho — 120m capped, GSD treated as max acceptable', frontOverlapPct: 70, sideOverlapPct: 40, cameraAngleDeg: 90, crossGrid: false, numPasses: 1, isLidar: true, defaultAltitudeM: 120, defaultSpeedMs: 12 },
];

/**
 * Flight height from target GSD (flight_calculator.dart:262-269).
 * height_m = (GSD × focal_mm × imageWidth_px) / (sensorWidth_mm × 100)
 */
export function calculateHeight(targetGsdCm: number, camera: CameraSpec, lens: LensSpec): number {
  return (targetGsdCm * lens.focalLengthMm * camera.imageWidthPx) / (camera.sensorWidthMm * 100);
}

/** Actual GSD at a given height (flight_calculator.dart:272-279). */
export function calculateGsd(heightM: number, camera: CameraSpec, lens: LensSpec): number {
  return (camera.sensorWidthMm * heightM * 100) / (lens.focalLengthMm * camera.imageWidthPx);
}

/** Ground footprint of a single image (flight_calculator.dart:282-290). */
export function calculateFootprint(flightHeightM: number, camera: CameraSpec, lens: LensSpec): { widthM: number; heightM: number } {
  return {
    widthM: (camera.sensorWidthMm * flightHeightM) / lens.focalLengthMm,
    heightM: (camera.sensorHeightMm * flightHeightM) / lens.focalLengthMm,
  };
}

/** Area coverage per flight in hectares (flight_calculator.dart:298-312). */
export function calculateCoveragePerFlight(opts: {
  speedMs: number;
  lineSpacingM: number;
  flightTimeMinutes: number;
  numPasses: number;
  batteryReservePct?: number;
}): number {
  const batteryReservePct = opts.batteryReservePct ?? FlightConstants.defaultBatteryReservePct;
  const batteryBudget = (100 - clampNum(batteryReservePct, 0, 90)) / 100;
  const effectiveSurveyTimeS = opts.flightTimeMinutes * 60 * batteryBudget * FlightConstants.surveyEfficiency;
  const areaSqM = (opts.speedMs * effectiveSurveyTimeS * opts.lineSpacingM) / opts.numPasses;
  return areaSqM / 10000;
}

/** Suggest a shorter lens if height exceeds 120 m (flight_calculator.dart:315-331). */
export function suggestLens(targetGsdCm: number, camera: CameraSpec, availableLenses: LensSpec[]): string {
  for (const lens of availableLenses) {
    const height = calculateHeight(targetGsdCm, camera, lens);
    if (height <= FlightConstants.maxHeightM) {
      return `Try ${lens.name} lens (${height.toFixed(0)}m altitude)`;
    }
  }
  return 'No lens achieves this GSD below 120m — consider a larger GSD';
}

/** Smart Oblique config per aircraft (flight_calculator.dart:336-352). */
export function smartObliqueConfig(aircraftId: string | null | undefined): { passes: number; speedFactor: number; crossGrid: boolean } {
  switch (aircraftId) {
    case 'm3e':
    case 'm3t':
    case 'm3m':
      return { passes: 2, speedFactor: 0.5, crossGrid: true };
    case 'm4e':
    case 'm4t':
      return { passes: 1, speedFactor: 0.6, crossGrid: false };
    case 'm400':
    case 'm350':
    case 'm300':
      return { passes: 1, speedFactor: 0.6, crossGrid: false };
    default:
      return { passes: 2, speedFactor: 0.5, crossGrid: true };
  }
}

export interface CalculateOptions {
  camera: CameraSpec;
  lens: LensSpec;
  targetGsdCm: number;
  captureType: CaptureTypeConfig;
  mappingSpeedMs?: number;
  minPhotoIntervalS?: number;
  aircraftFlightTimeMinutes?: number;
  availableLenses?: LensSpec[] | null;
  aircraftId?: string | null;
  targetAltitudeM?: number | null;
  sideOverlapPctOverride?: number | null;
  batteryReservePct?: number;
}

/** Calculate all flight parameters (flight_calculator.dart:364-495). */
export function calculate(opts: CalculateOptions): FlightParameters {
  const {
    camera,
    lens,
    targetGsdCm,
    captureType,
    mappingSpeedMs = 12.0,
    minPhotoIntervalS = 2.0,
    aircraftFlightTimeMinutes = 45,
    availableLenses = null,
    aircraftId = null,
    targetAltitudeM = null,
    sideOverlapPctOverride = null,
    batteryReservePct = FlightConstants.defaultBatteryReservePct,
  } = opts;

  // 1. Flight height — LiDAR: altitude is input; photogrammetry: solve from GSD.
  const heightM = captureType.isLidar
    ? (targetAltitudeM ?? captureType.defaultAltitudeM ?? FlightConstants.maxHeightM)
    : calculateHeight(targetGsdCm, camera, lens);

  // 2. Ground footprint.
  const footprint = calculateFootprint(heightM, camera, lens);

  // 3. Resulting GSD at planned altitude.
  const resultingGsdCmPx = calculateGsd(heightM, camera, lens);

  // 4. Effective overlap — LiDAR UI may override sidelap.
  const effectiveSideOverlap = sideOverlapPctOverride ?? captureType.sideOverlapPct;

  // 5. Trigger distance (between photos along a line).
  const triggerDistanceM = footprint.heightM * (1 - captureType.frontOverlapPct / 100);

  // 6. Line spacing (between flight lines).
  const lineSpacingM = footprint.widthM * (1 - effectiveSideOverlap / 100);

  // 7. Smart Oblique adjustments.
  let effectivePasses = captureType.numPasses;
  let effectiveMappingSpeed = captureType.isLidar ? (captureType.defaultSpeedMs ?? mappingSpeedMs) : mappingSpeedMs;
  let effectiveCrossGrid = captureType.crossGrid;
  if (captureType.type === 'smartOblique') {
    const so = smartObliqueConfig(aircraftId);
    effectivePasses = so.passes;
    effectiveMappingSpeed = mappingSpeedMs * so.speedFactor;
    effectiveCrossGrid = so.crossGrid;
  }

  // 8. Speed — mapping speed, capped if overlap requires slower.
  const maxSpeedForOverlap = triggerDistanceM / minPhotoIntervalS;
  const speedMs = clampNum(maxSpeedForOverlap, 1.0, effectiveMappingSpeed);

  // 9. Actual photo interval at chosen speed.
  const photoIntervalS = triggerDistanceM / speedMs;

  // 10. Area coverage per flight.
  const coverageHa = calculateCoveragePerFlight({
    speedMs,
    lineSpacingM,
    flightTimeMinutes: aircraftFlightTimeMinutes,
    numPasses: effectivePasses,
    batteryReservePct,
  });

  // 11. Lineal distance per battery flight (km).
  const linealDistanceKm = lineSpacingM > 0 ? (coverageHa * 10000) / lineSpacingM / 1000 : 0.0;

  // 12. Forecast accuracy (RTK + GCP rule of thumb).
  const forecastH = resultingGsdCmPx * FlightConstants.forecastAccuracyHorizontalMultiplier;
  const forecastV = resultingGsdCmPx * FlightConstants.forecastAccuracyVerticalMultiplier;

  // 13. Height limit + (photogrammetry) lens suggestion.
  const exceedsMax = heightM > FlightConstants.maxHeightM;
  let lensRec: string | null = null;
  if (!captureType.isLidar && exceedsMax && availableLenses) {
    lensRec = suggestLens(targetGsdCm, camera, availableLenses);
  }

  // 14. LiDAR Ecological GSD shortfall flag.
  const resultingGsdExceedsTarget =
    captureType.type === 'lidarEcological' && targetGsdCm > 0 && resultingGsdCmPx > targetGsdCm;

  return {
    heightM,
    speedMs,
    gsdCmPx: targetGsdCm,
    resultingGsdCmPx,
    frontOverlapPct: captureType.frontOverlapPct,
    sideOverlapPct: effectiveSideOverlap,
    cameraAngleDeg: captureType.cameraAngleDeg,
    crossGrid: effectiveCrossGrid,
    numPasses: effectivePasses,
    photoIntervalS,
    lineSpacingM,
    triggerDistanceM,
    captureTypeName: captureType.name,
    coveragePerFlightHa: coverageHa,
    linealDistancePerFlightKm: linealDistanceKm,
    forecastAccuracyHorizontalCm: forecastH,
    forecastAccuracyVerticalCm: forecastV,
    exceedsMaxHeight: exceedsMax,
    resultingGsdExceedsTarget,
    isLidar: captureType.isLidar ?? false,
    lensRecommendation: lensRec,
  };
}
