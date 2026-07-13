/**
 * Small geodesy helpers. Pure — no deps.
 */
import { LatLng } from './waypoint';

const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LNG = 111320.0;
const DEG = Math.PI / 180;

/**
 * Extract the first polygon ring from a KML string. KML coordinates are
 * whitespace-separated `lng,lat[,alt]` tuples; we return them as {lat,lng}.
 * Drops a duplicated closing vertex. Pure (regex, no DOM) so it's testable.
 */
export function parseKmlPolygon(kml: string): LatLng[] {
  const m = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(kml);
  if (!m) return [];
  const ring = m[1]
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lng, lat] = tok.split(',').map(Number);
      return { lat, lng };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (ring.length >= 2) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.abs(a.lat - b.lat) < 1e-12 && Math.abs(a.lng - b.lng) < 1e-12) ring.pop();
  }
  return ring;
}

/**
 * Expand (or, with a negative distance, shrink) a polygon outward by `meters`,
 * so survey lines run beyond the target boundary and the outer photos' overlap
 * fully resolves the edges. Miter offset in a local equirectangular frame at the
 * polygon centroid — accurate for survey-scale areas. Simple/convex polygons
 * offset cleanly; very sharp reflex corners may miter long (fine for drawn
 * survey cells).
 */
export function bufferPolygonMeters(ring: LatLng[], meters: number): LatLng[] {
  if (meters === 0 || ring.length < 3) return [...ring];

  // Local frame at centroid.
  let lat0 = 0;
  let lng0 = 0;
  for (const p of ring) {
    lat0 += p.lat;
    lng0 += p.lng;
  }
  lat0 /= ring.length;
  lng0 /= ring.length;
  const cosLat0 = Math.cos(lat0 * DEG);
  const toLocal = (p: LatLng): [number, number] => [(p.lng - lng0) * cosLat0 * M_PER_DEG_LNG, (p.lat - lat0) * M_PER_DEG_LAT];
  const toLatLng = (x: number, y: number): LatLng => ({ lat: lat0 + y / M_PER_DEG_LAT, lng: lng0 + x / (cosLat0 * M_PER_DEG_LNG) });

  const pts = ring.map(toLocal);
  const n = pts.length;

  // Signed area → orientation. Normalise to CCW so the outward normal is the
  // right-hand side of travel (dy, −dx).
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area2 += x0 * y1 - x1 * y0;
  }
  const ccw = area2 > 0;
  const p = ccw ? pts : [...pts].reverse();

  const norm = (dx: number, dy: number): [number, number] => {
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };

  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = p[(i - 1 + n) % n];
    const cur = p[i];
    const next = p[(i + 1) % n];
    const e1 = norm(cur[0] - prev[0], cur[1] - prev[1]); // edge into cur
    const e2 = norm(next[0] - cur[0], next[1] - cur[1]); // edge out of cur
    const n1: [number, number] = [e1[1] * meters, -e1[0] * meters]; // outward offsets
    const n2: [number, number] = [e2[1] * meters, -e2[0] * meters];

    // Intersect offset line through (cur+n1) dir e1 with (cur+n2) dir e2.
    const a0: [number, number] = [cur[0] + n1[0], cur[1] + n1[1]];
    const b0: [number, number] = [cur[0] + n2[0], cur[1] + n2[1]];
    const det = -(e1[0] * e2[1] - e1[1] * e2[0]); // = cross(e2,e1)
    if (Math.abs(det) < 1e-9) {
      // Collinear edges: just push out along the (equal) normal.
      out.push([cur[0] + n1[0], cur[1] + n1[1]]);
    } else {
      const t = ((b0[0] - a0[0]) * -e2[1] - -e2[0] * (b0[1] - a0[1])) / det;
      out.push([a0[0] + t * e1[0], a0[1] + t * e1[1]]);
    }
  }

  const result = out.map(([x, y]) => toLatLng(x, y));
  return ccw ? result : result.reverse(); // restore original winding
}
