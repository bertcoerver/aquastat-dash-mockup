import { defineConfig } from "vite";

export default defineConfig({
  // deck.gl-raster's GeoTIFF decoder worker uses top-level await.
  worker: { format: "es" },
});
