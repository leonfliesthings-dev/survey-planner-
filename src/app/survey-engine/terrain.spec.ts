/**
 * Tests for the pure Terrarium math + grid sampling. (Tile fetch/PNG decode is a
 * browser adapter, not exercised here.)
 */
import { decodeTerrarium, lngLatToGlobalPx, bilinear, tilesForBounds, loadTerrainGrid, TILE_SIZE } from './terrain';
import { LatLng } from './waypoint';

describe('terrain — Terrarium decode', () => {
  it('decodes 0 m at the sea-level byte pattern', () => {
    // v = elev + 32768 = 32768 → R=128, G=0, B=0
    expect(decodeTerrarium(128, 0, 0)).toBeCloseTo(0, 9);
  });
  it('round-trips a fractional elevation', () => {
    const E = 436.5;
    const v = E + 32768;
    const r = Math.floor(v / 256);
    const g = Math.floor(v % 256);
    const b = Math.floor((v - Math.floor(v)) * 256);
    expect(decodeTerrarium(r, g, b)).toBeCloseTo(E, 6);
  });
});

describe('terrain — projection & bilinear', () => {
  it('maps lng to a monotonic global-x and equator lat to n/2', () => {
    const zoom = 13;
    const n = TILE_SIZE * 2 ** zoom;
    expect(lngLatToGlobalPx(0, -180, zoom).x).toBeCloseTo(0, 6);
    expect(lngLatToGlobalPx(0, 180, zoom).x).toBeCloseTo(n, 6);
    expect(lngLatToGlobalPx(0, 0, zoom).y).toBeCloseTo(n / 2, 6);
  });
  it('bilinear interpolates the 4 corners', () => {
    expect(bilinear(0, 10, 20, 30, 0, 0)).toBe(0);
    expect(bilinear(0, 10, 20, 30, 1, 0)).toBe(10);
    expect(bilinear(0, 10, 20, 30, 0, 1)).toBe(20);
    expect(bilinear(0, 10, 20, 30, 1, 1)).toBe(30);
    expect(bilinear(0, 10, 20, 30, 0.5, 0.5)).toBe(15);
  });
});

describe('terrain — grid sampling', () => {
  const zoom = 13;
  const P: LatLng = { lat: -37.611, lng: 143.851 };

  it('samples a constant tile as that constant (bilinear of equal corners)', async () => {
    // Synthetic fetcher: every covering tile is a flat 100 m surface.
    const flat = new Float32Array(TILE_SIZE * TILE_SIZE).fill(100);
    const bounds = { minLat: P.lat - 0.001, minLng: P.lng - 0.001, maxLat: P.lat + 0.001, maxLng: P.lng + 0.001 };
    const grid = await loadTerrainGrid(bounds, zoom, async () => flat, TILE_SIZE, 1);
    expect(grid.tileCount).toBeGreaterThan(0);
    expect(grid.elevationAt(P)).toBeCloseTo(100, 6);
  });

  it('returns null where no tile is loaded', async () => {
    const bounds = { minLat: P.lat - 0.001, minLng: P.lng - 0.001, maxLat: P.lat + 0.001, maxLng: P.lng + 0.001 };
    const grid = await loadTerrainGrid(bounds, zoom, async () => null, TILE_SIZE, 0); // no tiles
    expect(grid.tileCount).toBe(0);
    expect(grid.elevationAt(P)).toBeNull();
  });

  it('tilesForBounds covers a small area with a handful of tiles', () => {
    const bounds = { minLat: P.lat - 0.002, minLng: P.lng - 0.002, maxLat: P.lat + 0.002, maxLng: P.lng + 0.002 };
    const tiles = tilesForBounds(bounds, zoom);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThan(20);
  });
});
