/* Where the vector tile sets ({z}/{x}/{y}.pbf) live. */

/** A tile set in public/tiles/ (built by scripts/build-tiles.sh). */
export function localTiles(name: string) {
  return new URL(`${import.meta.env.BASE_URL}tiles/${name}/{z}/{x}/{y}.pbf`, window.location.href).href
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}");
}

/** A tile set in FAO's cloud bucket. All of these go up to zoom 8. */
function faoTiles(name: string) {
  return `https://storage.googleapis.com/fao-cog-data/basins/${name}/{z}/{x}/{y}.pbf`;
}

export const FAO_TILES = {
  lakes: faoTiles("HydroLAKES_polys_v10_tiles"),
  rivers: faoTiles("rivers_world_47950_tiles"),
  majorBasins: faoTiles("SDG6_MBM_v1_tiles"),
  subBasins: faoTiles("SDG6_SBM_v1_tiles"),
};

/**
 * For MVTLayer's onTileError. Tile sets have no files for empty tiles (open ocean,
 * say), so the server answers 404 there; that just means "nothing here".
 */
export function ignoreMissingTile() {}
