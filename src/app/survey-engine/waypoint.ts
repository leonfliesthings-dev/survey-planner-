/**
 * Core geo + waypoint types. Faithful port of DeployPlanner
 * companion/lib/models/waypoint.dart (LatLng comes from Dart's latlong2).
 * Pure — no framework imports.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * A single mission waypoint produced by the transect engine.
 * Heights are metres RELATIVE TO THE LZ TAKEOFF POINT — never absolute —
 * i.e. (dsm(pos) − dsm(lz)) + AGL. (WILDLIFE_TRANSECT_MISSIONS_SPEC §5.2)
 */
export interface Waypoint {
  pos: LatLng;
  /** Metres above the LZ takeoff point. */
  heightM: number;
  speedMs: number;
  /**
   * True on the FIRST waypoint of each transect (the U-turn exit): gimbal
   * resets to the search angle there. Elsewhere the pilot keeps yaw/gimbal.
   */
  alignAtPoint: boolean;
  /**
   * Target nose heading (°TRUE, −180..180) reached AT this waypoint via a
   * gradual turn over the whole arriving leg. Set on line starts so the U-turn
   * uses the full cross-leg to come around. null = heading held manually.
   */
  headingDeg: number | null;
}
