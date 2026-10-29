import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * A version for the static data's URLs (src/lib/data-url.ts): a hash of the files in
 * public/data (not the model's output, which carries its own), so it changes when one
 * of them does and stays the same otherwise.
 */
function dataVersion() {
  const hash = createHash("sha1");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "model") continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else hash.update(path).update(readFileSync(path));
    }
  };
  try {
    walk("public/data");
  } catch {
    // (No data yet: every URL still works, with one version.)
  }
  return hash.digest("hex").slice(0, 8);
}
// (As an environment variable, so index.html's preloads get it too: %VITE_DATA_VERSION%.)
process.env.VITE_DATA_VERSION = dataVersion();

export default defineConfig({
  server: { port: 5173 },
  // The unit tests (test/*.test.ts): pure modules, no DOM.
  test: { include: ["test/**/*.test.ts"], environment: "node" },
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
            // (Loaded on demand, with the first raster: see src/map/layers/geotiff-lib.ts.)
            { name: "geotiff", test: /node_modules[\\/](@developmentseed|@cogeotiff|flatbush|proj4|wkt-parser|mgrs)[\\/]/ },
            { name: "loaders", test: /node_modules[\\/]@loaders\.gl[\\/]/ },
          ],
        },
      },
    },
  },
});
