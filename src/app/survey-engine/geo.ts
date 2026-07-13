/**
 * Small geodesy helpers. Pure — no deps.
 */
import { LatLng } from './waypoint';

const M_PER_DEG_LAT = 110540.0;
const M_PER_DEG_LNG = 111320.0;
const DEG = Math.PI / 180;

/** Great-circle distance between two points, metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Bearing a→b in °TRUE, 0..360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLat = b.lat - a.lat;
  const dLng = (b.lng - a.lng) * Math.cos(a.lat * DEG);
  return (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
}

/** Point at distance/bearing from an origin (equirectangular, survey-scale). */
export function destination(from: LatLng, meters: number, bearingDegrees: number): LatLng {
  const br = bearingDegrees * DEG;
  const cosLat = Math.cos(from.lat * DEG);
  return {
    lat: from.lat + (meters * Math.cos(br)) / M_PER_DEG_LAT,
    lng: from.lng + (meters * Math.sin(br)) / (cosLat * M_PER_DEG_LNG),
  };
}

/**
 * Offset an OPEN polyline sideways by `meters` (signed: +right / −left of travel),
 * producing a parallel line. Each edge is shifted along its normal, then adjacent
 * offset edges are intersected for the interior vertices (QGCMapPolyline.offsetPolyline).
 * Local equirectangular frame at the line centroid.
 */
export function offsetPolyline(line: LatLng[], meters: number): LatLng[] {
  if (line.length < 2 || meters === 0) return [...line];
  let lat0 = 0, lng0 = 0;
  for (const p of line) { lat0 += p.lat; lng0 += p.lng; }
  lat0 /= line.length; lng0 /= line.length;
  const cosLat0 = Math.cos(lat0 * DEG);
  const toLocal = (p: LatLng): [number, number] => [(p.lng - lng0) * cosLat0 * M_PER_DEG_LNG, (p.lat - lat0) * M_PER_DEG_LAT];
  const toLL = (x: number, y: number): LatLng => ({ lat: lat0 + y / M_PER_DEG_LAT, lng: lng0 + x / (cosLat0 * M_PER_DEG_LNG) });
  const pts = line.map(toLocal);
  const norm = (dx: number, dy: number): [number, number] => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };

  // Offset segment endpoints per edge: shift by the right-hand normal (dy, −dx).
  const segA: [number, number][] = [];
  const segB: [number, number][] = [];
  const dir: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = norm(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const nx = d[1] * meters, ny = -d[0] * meters;
    dir.push(d);
    segA.push([pts[i][0] + nx, pts[i][1] + ny]);
    segB.push([pts[i + 1][0] + nx, pts[i + 1][1] + ny]);
  }

  const out: [number, number][] = [segA[0]];
  for (let i = 1; i < segA.length; i++) {
    // Intersect offset edge i-1 with offset edge i.
    const p0 = segA[i - 1], d0 = dir[i - 1];
    const p1 = segA[i], d1 = dir[i];
    const det = d0[0] * -d1[1] - -d1[0] * d0[1];
    if (Math.abs(det) < 1e-9) { out.push(segB[i - 1]); continue; } // colinear
    const t = ((p1[0] - p0[0]) * -d1[1] - -d1[0] * (p1[1] - p0[1])) / det;
    out.push([p0[0] + t * d0[0], p0[1] + t * d0[1]]);
  }
  out.push(segB[segB.length - 1]);
  return out.map(([x, y]) => toLL(x, y));
}

// KML coordinates are whitespace-separated `lng,lat[,alt]` tuples → {lat,lng}.
function parseCoords(text: string): LatLng[] {
  return text
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const [lng, lat] = tok.split(',').map(Number);
      return { lat, lng };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

// First <coordinates> block inside the given KML geometry tag (Polygon,
// LineString, Point). Scoped to the tag so a Point KML can't be read as a line.
function coordsFor(kml: string, tag: string): LatLng[] {
  const m = new RegExp(`<${tag}[\\s\\S]*?<coordinates>([\\s\\S]*?)</coordinates>`, 'i').exec(kml);
  return m ? parseCoords(m[1]) : [];
}

/** First polygon ring from a KML string (closing vertex dropped). Pure/testable. */
export function parseKmlPolygon(kml: string): LatLng[] {
  const ring = coordsFor(kml, 'Polygon');
  if (ring.length >= 2) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.abs(a.lat - b.lat) < 1e-12 && Math.abs(a.lng - b.lng) < 1e-12) ring.pop();
  }
  return ring;
}

/** First point from a KML string (for Orbit POI). */
export function parseKmlPoint(kml: string): LatLng | null {
  return coordsFor(kml, 'Point')[0] ?? null;
}

/** First line/string from a KML string (for Corridor centreline). */
export function parseKmlLine(kml: string): LatLng[] {
  return coordsFor(kml, 'LineString');
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
