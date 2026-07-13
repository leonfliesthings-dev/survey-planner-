/**
 * Autofly mission emitter.
 *
 * Turns terrain-following Waypoint[] (from the transect engine) into an Unleash
 * Live / Autofly `type:"waypoint"` mission JSON, welding in the distance-interval
 * camera capture the transect mode never had. The photo spacing comes from the
 * photogrammetry engine's triggerDistanceM.
 *
 * Route-point + action shapes match the live schema observed via GET /v1/mission
 * (waypoint has lat/lng, relative + EGM altitude, heading, pitch, gimbal, speed,
 * actions[]; camera actions include GIMBAL_PITCH / AIRCRAFT_YAW /
 * START_DISTANCE_INTERVAL_SHOT / STOP_INTERVAL_SHOT).
 *
 * Pure module — no framework or I/O.
 */
import { Waypoint } from './waypoint';

export interface AutoflyAction {
  action: string;
  /** Autofly params are stringly/number-typed per action; we mirror observed types. */
  param: string | number;
}

export interface AutoflyRoutePoint {
  lat: number;
  lng: number;
  /** Height relative to take-off (m). Primary altitude for relative height mode. */
  altitude: number;
  /** Orthometric (EGM/MSL) altitude, populated when a take-off MSL is supplied. */
  altitudeEGM?: number;
  heading: number;
  pitch: number;
  gimbal: number;
  speed: number;
  actions: AutoflyAction[];
}

export interface AutoflyMission {
  name: string;
  description?: string;
  type: 'waypoint';
  heightMode: string;
  waypointCount: number;
  route: AutoflyRoutePoint[];
}

export interface EmitOptions {
  name: string;
  /** Serpentine, terrain-following waypoints from the transect engine. */
  waypoints: Waypoint[];
  /** Along-track photo spacing in metres (photogrammetry triggerDistanceM). */
  photoSpacingM: number;
  description?: string;
  /** Nadir gimbal pitch for mapping (default −90 = straight down). */
  nadirPitchDeg?: number;
  /**
   * How the aircraft interprets altitude. Default 'relativeToStartPoint' — our
   * heights are relative to take-off. NOTE: confirm the exact string the cloud
   * honours; pass 'EGM96' + takeoffElevationMslM to fly absolute instead.
   */
  heightMode?: string;
  /** Take-off elevation (MSL, m). When set, altitudeEGM is populated per point. */
  takeoffElevationMslM?: number | null;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Emit an Autofly waypoint mission from transect waypoints + photo spacing. */
export function emitAutoflyMission(o: EmitOptions): AutoflyMission {
  const { waypoints, photoSpacingM } = o;
  if (waypoints.length === 0) throw new RangeError('emitAutoflyMission: no waypoints');
  if (photoSpacingM <= 0) throw new RangeError(`photoSpacingM must be > 0 (was ${photoSpacingM})`);

  const nadir = o.nadirPitchDeg ?? -90;
  const heightMode = o.heightMode ?? 'relativeToStartPoint';

  // Line boundaries: a new line begins at index 0 and at every aligned start.
  const lineStart = new Set<number>();
  waypoints.forEach((w, i) => {
    if (i === 0 || w.alignAtPoint) lineStart.add(i);
  });
  const lineEnd = new Set<number>();
  const starts = [...lineStart].sort((a, b) => a - b);
  starts.forEach((s, k) => {
    lineEnd.add(k + 1 < starts.length ? starts[k + 1] - 1 : waypoints.length - 1);
  });

  let currentHeading = waypoints[0].headingDeg ?? 0;

  const route: AutoflyRoutePoint[] = waypoints.map((w, i) => {
    if (w.headingDeg != null) currentHeading = w.headingDeg;
    const headingInt = Math.round(currentHeading);

    const actions: AutoflyAction[] = [];
    if (lineStart.has(i)) {
      // Square up out of the turn, drop to nadir, begin distance-interval capture.
      actions.push({ action: 'GIMBAL_PITCH', param: String(nadir) });
      actions.push({ action: 'AIRCRAFT_YAW', param: headingInt });
      actions.push({ action: 'START_DISTANCE_INTERVAL_SHOT', param: photoSpacingM.toFixed(1) });
    }
    if (lineEnd.has(i)) {
      actions.push({ action: 'STOP_INTERVAL_SHOT', param: 0 });
    }

    const rp: AutoflyRoutePoint = {
      lat: w.pos.lat,
      lng: w.pos.lng,
      altitude: round6(w.heightM),
      heading: headingInt,
      pitch: nadir,
      gimbal: 0,
      speed: w.speedMs,
      actions,
    };
    if (o.takeoffElevationMslM != null) {
      rp.altitudeEGM = round6(w.heightM + o.takeoffElevationMslM);
    }
    return rp;
  });

  return {
    name: o.name,
    description: o.description,
    type: 'waypoint',
    heightMode,
    waypointCount: route.length,
    route,
  };
}
