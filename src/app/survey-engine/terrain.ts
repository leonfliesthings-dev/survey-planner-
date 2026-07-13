/**
 * Terrarium DSM elevation sampling (the source DeployPlanner uses: AWS
 * `elevation-tiles-prod`, free/no-token). Mirrors companion terrain_store.dart:
 * prefetch the tiles covering an area, decode to elevation grids, then sample
 * synchronously with bilinear interpolation — so it can back the transect
 * engine's synchronous `elevationAt` callback.
 *
 * The pure math (decode, projection, bilinear, grid sampling) has no I/O and is
 * unit-tested. Tile fetching + PNG decode is a browser adapter (fetch +
 * OffscreenCanvas) injected as a `TileFetcher`.
 */
import { LatLng } from './waypoint';

export const TILE_SIZE = 256;

/** Terrarium RGB → metres (orthometric ~MSL). */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** lat/lng → global web-mercator pixel at `zoom`. */
export function lngLatToGlobalPx(lat: number, lng: number, zoom: number, tileSize = TILE_SIZE): { x: number; y: number } {
  const n = tileSize * 2 ** zoom;
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((lng + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

/** Bilinear interpolation over 4 corner values. */
export function bilinear(v00: number, v10: number, v01: number, v11: number, fx: number, fy: number): number {
  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  return top + (bot - top) * fy;
}

export interface Bounds {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Returns a decoded elevation grid (row-major, length tileSize²) or null. */
export type TileFetcher = (tx: number, ty: number, zoom: number) => Promise<Float32Array | null>;

/** In-memory decoded tiles; samples elevation with cross-seam bilinear. */
export class TerrainGrid {
  constructor(
    readonly zoom: number,
    private readonly tiles: Map<string, Float32Array>,
    readonly tileSize = TILE_SIZE
  ) {}

  get tileCount(): number {
    return this.tiles.size;
  }

  private px(gx: number, gy: number): number | null {
    const tx = Math.floor(gx / this.tileSize);
    const ty = Math.floor(gy / this.tileSize);
    const tile = this.tiles.get(`${tx}/${ty}`);
    if (!tile) return null;
    const lx = Math.min(Math.max(gx - tx * this.tileSize, 0), this.tileSize - 1);
    const ly = Math.min(Math.max(gy - ty * this.tileSize, 0), this.tileSize - 1);
    return tile[ly * this.tileSize + lx];
  }

  /** Elevation (m) at a point, or null if any covering tile is missing. */
  elevationAt = (p: LatLng): number | null => {
    const { x, y } = lngLatToGlobalPx(p.lat, p.lng, this.zoom, this.tileSize);
    // Sample at pixel centres.
    const sx = x - 0.5;
    const sy = y - 0.5;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    const v00 = this.px(x0, y0);
    const v10 = this.px(x0 + 1, y0);
    const v01 = this.px(x0, y0 + 1);
    const v11 = this.px(x0 + 1, y0 + 1);
    if (v00 == null || v10 == null || v01 == null || v11 == null) return null;
    return bilinear(v00, v10, v01, v11, fx, fy);
  };
}

/** Tiles (tx,ty) covering `bounds` at `zoom`, expanded by `marginTiles`. */
export function tilesForBounds(bounds: Bounds, zoom: number, tileSize = TILE_SIZE, marginTiles = 0): { tx: number; ty: number }[] {
  const tl = lngLatToGlobalPx(bounds.maxLat, bounds.minLng, zoom, tileSize); // top-left
  const br = lngLatToGlobalPx(bounds.minLat, bounds.maxLng, zoom, tileSize); // bottom-right
  const tx0 = Math.floor(tl.x / tileSize) - marginTiles;
  const tx1 = Math.floor(br.x / tileSize) + marginTiles;
  const ty0 = Math.floor(tl.y / tileSize) - marginTiles;
  const ty1 = Math.floor(br.y / tileSize) + marginTiles;
  const out: { tx: number; ty: number }[] = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) out.push({ tx, ty });
  return out;
}

/** Prefetch + decode all tiles covering `bounds`, returning a samplable grid. */
export async function loadTerrainGrid(bounds: Bounds, zoom: number, fetchTile: TileFetcher, tileSize = TILE_SIZE, marginTiles = 1): Promise<TerrainGrid> {
  const tiles = new Map<string, Float32Array>();
  await Promise.all(
    tilesForBounds(bounds, zoom, tileSize, marginTiles).map(async ({ tx, ty }) => {
      const grid = await fetchTile(tx, ty, zoom);
      if (grid) tiles.set(`${tx}/${ty}`, grid);
    })
  );
  return new TerrainGrid(zoom, tiles, tileSize);
}

/**
 * Browser TileFetcher for Terrarium tiles (fetch + OffscreenCanvas decode).
 * NOTE: the AWS `elevation-tiles-prod` bucket's CORS support is inconsistent; if
 * the browser blocks it, route through a proxy or fetch server-side. Not used in
 * unit tests (pure math is tested with synthetic grids).
 */
export function browserTerrariumFetcher(): TileFetcher {
  return async (tx, ty, zoom) => {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${tx}/${ty}.png`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const out = new Float32Array(bmp.width * bmp.height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) out[p] = decodeTerrarium(data[i], data[i + 1], data[i + 2]);
    return out;
  };
}
