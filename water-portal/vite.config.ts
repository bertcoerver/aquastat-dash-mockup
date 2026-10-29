import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173 },
  // deck.gl-raster's GeoTIFF decoder worker uses top-level await.
  worker: { format: "es" },
  build: {
    // The browsers the stylesheets already need (color-mix(), :has(), translate).
    target: ["chrome111", "safari16.4", "firefox113"],
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      output: {
        // The libraries in chunks of their own: a change to the app doesn't have a
        // returning visitor download the map libraries again.
        advancedChunks: {
          groups: [
            { name: "maplibre", test: /node_modules[\\/]maplibre-gl[\\/]/ },
            { name: "deck", test: /node_modules[\\/]@(deck|luma|math|probe)\.gl[\\/]/ },
            { name: "geotiff", test: /node_modules[\\/](@developmentseed|proj4|wkt-parser|mgrs|@loaders\.gl)[\\/]/ },
          ],
        },
      },
    },
  },
});
