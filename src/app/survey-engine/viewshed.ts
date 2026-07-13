/**
 * Line-of-sight viewshed from the LZ. Port of DeployPlanner
 * app/lib/services/viewshed_service.dart (analyse()).
 *
 * For each radial (default 36 = every 10°), step out over the DSM tracking the
 * max terrain "shadow" angle from the observer; the drone (flying at
 * flightHeightAGL above local terrain) is visible at a step while it stays above
 * that shadow line. A radial is obstructed if >30% of its steps are blocked.
 * Pure — DSM injected as `elevationAt`. Used to draw a visibility rose from the LZ.
 */
import { LatLng } from './waypoint';

export interface RadialResult {
  bearingDeg: number;
  obstructed: boolean;
  /** Furthest visible distance (m) — full range when clear, else last clear step. */
  clearDistM: number;
  /** Per-step (per 50 m ring) line-of-sight clear/blocked, for cell rendering. */
  stepsClear: boolean[];
}

export interface ViewshedResult {
  radials: RadialResult[];
  clearRadials: number;
  totalRadials: number;
  clearPercent: number;
  /** Ring step distance (m) — cell i spans [i·stepM, (i+1)·stepM]. */
  stepM: number;
}

export interface ViewshedOptions {
  lz: LatLng;
  flightHeightAGL: number;
  maxRangeM: number;
  elevationAt: (p: LatLng) => number | null;
  observerElevMsl?: number; // DSM at LZ; defaults to elevationAt(lz)
  numRadials?: number; // default 36
  stepM?: number; // default 50
  minObstructionM?: number; // ignore terrain within this radius (launch site). default 60
  observerEyeM?: number; // default 1.8
}

const M_PER_DEG_LAT = 111320.0;

export function analyseViewshed(o: ViewshedOptions): ViewshedResult {
  const numRadials = o.numRadials ?? 36;
  const step = o.stepM ?? 50;
  const minObs = o.minObstructionM ?? 60;
  const eye = o.observerEyeM ?? 1.8;
  const numSteps = Math.max(1, Math.ceil(o.maxRangeM / step));
  const mLng = M_PER_DEG_LAT * Math.cos((o.lz.lat * Math.PI) / 180);
  const obsElev = (o.observerElevMsl ?? o.elevationAt(o.lz) ?? 0) + eye;

  const radials: RadialResult[] = [];
  let clearCount = 0;

  for (let r = 0; r < numRadials; r++) {
    const bearingDeg = (360 * r) / numRadials;
    const br = (bearingDeg * Math.PI) / 180;
    let maxTerrainAngle = -Infinity;
    let blocked = 0;
    let total = 0;
    let furthestClearM = 0;
    const stepsClear: boolean[] = [];

    for (let s = 1; s <= numSteps; s++) {
      const dist = s * step;
      const p: LatLng = {
        lat: o.lz.lat + (dist * Math.cos(br)) / M_PER_DEG_LAT,
        lng: o.lz.lng + (dist * Math.sin(br)) / mLng,
      };
      const surf = o.elevationAt(p);
      if (surf == null) { stepsClear.push(true); continue; } // no DSM data → keep index aligned

      const terrainAngle = Math.atan2(surf - obsElev, dist);
      if (dist >= minObs && terrainAngle > maxTerrainAngle) maxTerrainAngle = terrainAngle;

      const droneAngle = Math.atan2(surf + o.flightHeightAGL - obsElev, dist);
      total++;
      const clear = maxTerrainAngle <= droneAngle; // LOS regained if the drone climbs above the ridge shadow
      stepsClear.push(clear);
      if (clear) furthestClearM = dist;
      else blocked++;
    }

    const obstructed = total > 0 && blocked / total > 0.3;
    if (!obstructed) clearCount++;
    radials.push({ bearingDeg, obstructed, clearDistM: obstructed ? furthestClearM : o.maxRangeM, stepsClear });
  }

  return { radials, clearRadials: clearCount, totalRadials: numRadials, clearPercent: (clearCount / numRadials) * 100, stepM: step };
}
