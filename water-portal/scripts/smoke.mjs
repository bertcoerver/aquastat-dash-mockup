// Smoke test of the built site (`npm run build` first): serves dist/ and drives it in a
// headless browser through the three views, a hover, a drag of the slider and the date
// picker, and fails on any page error, console error or failed request to the site.
// Usage: node scripts/smoke.mjs [url]   (without a URL it starts `vite preview` itself)
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 4199;
const base = process.argv[2] ?? `http://localhost:${PORT}/`;
const errors = [];
const warnings = [];

/** `vite preview` on PORT, once it answers. */
async function serve() {
  // (Vite itself, not through npx: killing npx would leave the server running.)
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base, { method: "HEAD" });
      return server;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  server.kill();
  throw new Error(`vite preview didn't answer on port ${PORT}`);
}

const server = process.argv[2] ? null : await serve();
try {
  // (Software rendering: the runners have no GPU.)
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => {
    const text = m.text();
    const url = m.location().url ?? "";
    // (deck.gl's GeoTIFF worker logs "Unimplemented type" under software rendering; a tile
    // pyramid has no tile where there's nothing, so FAO's bucket answers 404 for those.)
    if (text.includes("Unimplemented type") || (text.startsWith("Failed to load resource") && !url.startsWith(base))) return;
    if (m.type() === "error") errors.push(`console.error: ${text} (${url})`);
    else if (m.type() === "warning") warnings.push(`console.warn: ${text}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ""}`));
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(base)) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });

  const step = async (name, fn) => {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      errors.push(`step "${name}": ${e.message}`);
      console.log(`FAIL ${name}: ${e.message}`);
    }
  };

  await step("load", async () => {
    await page.goto(base, { waitUntil: "load", timeout: 60000 });
    await page.waitForSelector("#cp-panel:not([hidden])", { timeout: 60000 });
    await page.waitForTimeout(1500);
  });
  await step("has a map canvas", async () => {
    if (!(await page.evaluate(() => !!document.querySelector("#map canvas")))) throw new Error("no map canvas");
  });
  await step("country cards", async () => {
    await page.waitForFunction(() => document.querySelectorAll("#cp-cards [data-driver]").length > 0, null, { timeout: 30000 });
  });
  /** The pointer over the graph pane's heading unfolds it (panels/foldable.ts). */
  const unfold = async () => {
    await page.mouse.move(120, 60, { steps: 3 });
    await page.waitForTimeout(700);
  };
  /** The pointer onto a card: its map is previewed (panels/stat-panel.ts). */
  const hoverCard = async (selector) => {
    await unfold();
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`no card ${selector}`);
    await page.mouse.move(box.x + 30, box.y + 10, { steps: 5 });
    await page.waitForFunction((s) => !!document.querySelector(`${s}.previewing`), selector, { timeout: 5000 });
  };
  await step("hover a country card: its map previewed", async () => {
    await hoverCard("#cp-cards [data-driver]");
    await page.mouse.move(700, 450);
    await page.waitForTimeout(300);
  });
  await step("keyboard: Tab to a chart, arrows along it, Enter selects a year", async () => {
    // (Focus in the pane's heading unfolds it; Tab then reaches the tiles and cards.)
    await page.focus("#country-input");
    await page.waitForTimeout(900);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.matches("#cp-cards [data-driver]:has([data-x])"))) break;
    }
    if (!(await page.evaluate(() => document.activeElement?.matches("#cp-cards [data-driver]")))) throw new Error("Tab didn't reach a chart");
    const before = await page.$eval("#start-label", (e) => e.textContent);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(60);
      if (await page.evaluate(() => document.querySelector("#cp-cards .ch-focus")?.closest("[data-x]"))) break;
    }
    if (!(await page.evaluate(() => !!document.querySelector("#cp-cards .ch-focus") && !document.getElementById("cp-tooltip").hidden))) throw new Error("no mark focused with its tooltip");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const after = await page.$eval("#start-label", (e) => e.textContent);
    if (after === before) throw new Error(`Enter didn't select the year (${before})`);
    await page.keyboard.press("Escape");
    await page.mouse.move(700, 450);
    await page.waitForTimeout(500);
  });
  await step("drag the slider's start handle", async () => {
    const box = await page.locator("#start-handle").boundingBox();
    if (!box) throw new Error("no handle");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 2 + i * 6, box.y + box.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(300);
  });
  await step("open the date picker and close it with Escape", async () => {
    await page.click("#start-label");
    await page.waitForSelector(".date-picker:not([hidden])", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".date-picker:not(.length-picker)")?.hidden === true, null, { timeout: 5000 });
  });
  await step("basin view", async () => {
    await page.click('.tab[data-view="basin"]');
    await page.waitForSelector("#wb-panel:not([hidden])", { timeout: 10000 });
    await page.waitForTimeout(2500);
    // (Its cards need the model output, which a checkout doesn't have.)
    if (await page.locator("#bs-cards [data-driver]").count()) await hoverCard("#bs-cards [data-driver]");
  });
  await step("hover the globe", async () => {
    for (let i = 0; i < 8; i++) {
      await page.mouse.move(600 + i * 15, 400 + i * 5);
      await page.waitForTimeout(60);
    }
  });
  await step("local view: click a point", async () => {
    await page.click('.tab[data-view="local"]');
    await page.waitForSelector("#lp-panel:not([hidden])", { timeout: 10000 });
    await page.waitForTimeout(3000);
    // The WaPOR raster, read from FAO's bucket, drawn (the legend says so).
    await page.waitForFunction(() => document.getElementById("wapor-legend")?.dataset.status === "ready", null, { timeout: 90000 });
    await page.mouse.move(650, 420);
    await page.waitForTimeout(300);
    await page.mouse.click(650, 420);
    await page.waitForTimeout(2500);
  });
  await step("the URL keeps the state", async () => {
    const hash = await page.evaluate(() => window.location.hash);
    if (!/^#map=[\d.-]+\/[\d.-]+\/[\d.-]+&view=local&.*days=\d{4}-\d\d-\d\d\.\.\d{4}-\d\d-\d\d/.test(hash)) throw new Error(`unexpected hash ${hash}`);
  });
  await step("play and pause", async () => {
    await page.click("#play-button");
    await page.waitForTimeout(2500);
    await page.click("#play-button");
    await page.waitForTimeout(500);
  });
  await step("back to the country view", async () => {
    await page.click('.tab[data-view="country"]');
    await page.waitForSelector("#cp-panel:not([hidden])", { timeout: 10000 });
    await page.waitForTimeout(800);
  });
  await browser.close();
} finally {
  server?.kill();
}

const uniq = (a) => [...new Set(a)];
console.log(`\nwarnings (${uniq(warnings).length}):`);
for (const w of uniq(warnings).slice(0, 15)) console.log("  " + w.slice(0, 300));
console.log(`\nerrors (${uniq(errors).length}):`);
for (const e of uniq(errors)) console.log("  " + e.slice(0, 600));
process.exit(uniq(errors).length ? 1 : 0);
