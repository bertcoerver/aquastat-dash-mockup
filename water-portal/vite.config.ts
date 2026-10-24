import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  // deck.gl-raster's GeoTIFF decoder worker uses top-level await.
  worker: { format: "es" },
});
