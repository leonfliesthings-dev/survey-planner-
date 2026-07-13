import { bufferPolygonMeters, parseKmlPolygon, parseKmlPoint, parseKmlLine } from './geo';
import { LatLng } from './waypoint';

const C: LatLng = { lat: -37.0, lng: 144.0 };
const cosLat0 = Math.cos((C.lat * Math.PI) / 180);
const at = (eastM: number, northM: number): LatLng => ({ lat: C.lat + northM / 110540, lng: C.lng + eastM / (cosLat0 * 111320) });
const SQUARE: LatLng[] = [at(-50, -50), at(50, -50), at(50, 50), at(-50, 50)];

const northExtentM = (ring: LatLng[]) => (Math.max(...ring.map((p) => p.lat)) - Math.min(...ring.map((p) => p.lat))) * 110540;
const eastExtentM = (ring: LatLng[]) => (Math.max(...ring.map((p) => p.lng)) - Math.min(...ring.map((p) => p.lng))) * cosLat0 * 111320;

describe('geo — bufferPolygonMeters', () => {
  it('grows a 100 m square by ~10 m on every side', () => {
    const b = bufferPolygonMeters(SQUARE, 10);
    expect(b.length).toBe(4);
    expect(northExtentM(b)).toBeCloseTo(120, 0); // 100 + 2×10
    expect(eastExtentM(b)).toBeCloseTo(120, 0);
  });

  it('a negative distance shrinks', () => {
    const b = bufferPolygonMeters(SQUARE, -10);
    expect(northExtentM(b)).toBeCloseTo(80, 0);
  });

  it('returns the ring unchanged for zero distance', () => {
    expect(bufferPolygonMeters(SQUARE, 0)).toEqual(SQUARE);
  });
});

describe('geo — parseKmlPolygon', () => {
  const kml = `<?xml version="1.0"?><kml><Placemark><Polygon><outerBoundaryIs><LinearRing>
    <coordinates>144.0,-37.0,0 144.01,-37.0,0 144.01,-37.01,0 144.0,-37.01,0 144.0,-37.0,0</coordinates>
    </LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
  it('parses lng,lat,alt tuples and drops the closing vertex', () => {
    const ring = parseKmlPolygon(kml);
    expect(ring.length).toBe(4); // 5 coords minus the duplicated closer
    expect(ring[0]).toEqual({ lat: -37.0, lng: 144.0 });
    expect(ring[2]).toEqual({ lat: -37.01, lng: 144.01 });
  });
  it('returns empty for KML with no coordinates', () => {
    expect(parseKmlPolygon('<kml></kml>')).toEqual([]);
  });
});

describe('geo — parseKmlPoint / parseKmlLine', () => {
  it('parses a Point', () => {
    const kml = '<kml><Placemark><Point><coordinates>143.85,-37.61,0</coordinates></Point></Placemark></kml>';
    expect(parseKmlPoint(kml)).toEqual({ lat: -37.61, lng: 143.85 });
  });
  it('parses a LineString', () => {
    const kml = '<kml><Placemark><LineString><coordinates>143.85,-37.61,0 143.86,-37.62,0 143.87,-37.60,0</coordinates></LineString></Placemark></kml>';
    const line = parseKmlLine(kml);
    expect(line.length).toBe(3);
    expect(line[1]).toEqual({ lat: -37.62, lng: 143.86 });
  });
  it("doesn't confuse a Point KML for a polygon/line", () => {
    const kml = '<kml><Point><coordinates>143.85,-37.61</coordinates></Point></kml>';
    expect(parseKmlLine(kml)).toEqual([]);
    expect(parseKmlPoint(kml)).toEqual({ lat: -37.61, lng: 143.85 });
  });
});
