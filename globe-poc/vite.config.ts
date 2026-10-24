import { defineConfig } from "vite";

// FAO's GAEZ v4 bucket answers range requests but sends no CORS headers, so the
// browser can't read the COGs directly. Proxy them through the dev server.
const gaezProxy = {
  "/gaez": {
    target: "https://storage.googleapis.com",
    changeOrigin: true,
    rewrite: (path: string) =>
      path.replace(/^\/gaez/, "/fao-gismgr-gaez-v4-data/DATA/GAEZ-V4/MAPSET"),
  },
};

export default defineConfig({
  server: { proxy: gaezProxy },
  preview: { proxy: gaezProxy },
  // deck.gl-raster's GeoTIFF decoder worker uses top-level await.
  worker: { format: "es" },
});
