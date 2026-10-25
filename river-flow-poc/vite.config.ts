import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The water balance model and the sub-basin list come straight from the portal
// (../water-portal), so this PoC runs the same model on the same data.
const portal = fileURLToPath(new URL("../water-portal", import.meta.url));

export default defineConfig({
  // The portal's precomputed model output (public/data/model/, not in git), if it's there;
  // without it the model is run in the browser (src/basin-model.ts).
  define: {
    "import.meta.env.VITE_MODEL_FILES": JSON.stringify(
      process.env.VITE_MODEL_FILES ?? `/@fs${portal}/public/data/model/`,
    ),
  },
  resolve: { alias: { "@portal": `${portal}/src`, "@portal-data": `${portal}/public/data` } },
  server: { port: 5175, fs: { allow: [".", portal] } },
  // Four pages: the wind map as deck.gl layers (index.html) and on its own canvas
  // (canvas.html), the lanes version (lanes.html), and rain (rain.html).
  build: { rollupOptions: { input: ["index.html", "canvas.html", "lanes.html", "rain.html"] } },
});
