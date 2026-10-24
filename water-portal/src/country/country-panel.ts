/*
 * Country view: AQUASTAT statistics for the selected country (or the World), after the
 * Country tabs of FAO's Water Portal. A panel on the right, styled like the Basin
 * view's, has one tab per topic (SDG 6.4, water resources, water use, irrigation),
 * each with number tiles and chart cards (cards.ts).
 *
 * Every tile and card has a map that goes with it: hovering previews it, clicking pins
 * it (map-drivers.ts); unpinned, the map shows the topic's first tile. Within a card,
 * hovering a row picks out that area's countries on the map, hovering a series in a
 * legend maps that series, and clicking a year on a line chart sets the year in the
 * top bar.
 * Hovering a country on the map shows its value.
 *
 * The markup lives in index.html.
 */
import type { WaterMap } from "../map/map";
import { mixColor as mix, type Color } from "../map/theme";
import type { Selection } from "../selection";
import { fmt, hexToColor, rampScale, type ColorScale } from "../basin/variables";
import { dkY } from "../toolbar/dekads";
import type { DekadRange, View } from "../toolbar/range-rules";
import { TOPICS, type Card, type Ctx, type MapSpec, type Region, type Tile, type TopicDef } from "./cards";
import { WORLD, latestYear, loadTopic, type Topic } from "./data";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";

export interface CountryInfo {
  regions: { code: number; name: string }[];
  countries: Record<string, { region: number; center: [number, number] }>;
}

interface Options {
  map: WaterMap;
  info: CountryInfo;
  names: Map<number, string>;
  /** Select a year in the top bar (from clicking a year on a chart). */
  setYear: (year: number) => void;
  canSelect: (year: number) => boolean;
}

export interface CountryPanel {
  setView(view: View): void;
  setRange(range: DekadRange): void;
  setSelection(selection: Selection): void;
  /** The country under the pointer on the map (null: none). */
  hover(m49: number | null): void;
}

type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

const SHORT: Record<number, string> = { 419: "Latin Am. & Caribbean", 513: "Europe & N. America" };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function initCountryPanel({ map, info, names, setYear, canSelect }: Options): CountryPanel {
  const regionOf = new Map(Object.entries(info.countries).map(([m49, c]) => [Number(m49), c.region]));
  const centerOf = new Map(Object.entries(info.countries).map(([m49, c]) => [Number(m49), c.center]));
  const regions: Region[] = info.regions.map((r) => ({
    ...r,
    short: SHORT[r.code] ?? r.name,
    members: [...regionOf].filter(([, code]) => code === r.code).map(([m49]) => m49),
  }));
  const countries = [...regionOf.keys()];

  const state = {
    view: "country" as View,
    year: 0,
    selection: null as Selection | null,
    topic: "sdg" as Topic,
    status: new Map<Topic, Status>(),
    pinned: new Map<Topic, Driver>(),
    mapHover: null as number | null,
  };

  const panel = $("cp-panel");
  const legend = $("cp-legend");
  const tooltip = $("cp-tooltip");
  const cardsEl = $("cp-cards");
  let current: { ctx: Ctx; spec: MapSpec; csv: Map<string, (string | number)[][]> } | null = null;

  // --- Topic tabs ------------------------------------------------------------------
  $("cp-topics").innerHTML = TOPICS.map((t) => `<button role="tab" data-topic="${t.id}">${t.label}</button>`).join("");
  $("cp-topics").addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-topic]");
    if (!button) return;
    state.topic = button.dataset.topic as Topic;
    drivers.clearPreview();
    load();
    render();
  });

  const collapse = $("cp-collapse");
  collapse.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.textContent = collapsed ? "+" : "–";
  });

  function load() {
    const topic = state.topic;
    if (state.status.get(topic)?.kind === "ready") return;
    state.status.set(topic, { kind: "loading" });
    loadTopic(topic).then(
      () => {
        state.status.set(topic, { kind: "ready" });
        render();
      },
      (err: Error) => {
        state.status.set(topic, { kind: "error", message: err.message });
        render();
      },
    );
  }

  // --- Preview and pin -------------------------------------------------------------------
  // Tiles and cards are both drivers (map-drivers.ts). The map follows the previewed
  // one, else the pinned one, else the topic's first tile. Pins are kept per topic.
  const drivers = initDrivers($("cp-body"), {
    enabled: () => state.view === "country",
    pinned: () => state.pinned.get(state.topic) ?? null,
    setPinned(d) {
      if (d) state.pinned.set(state.topic, d);
      else state.pinned.delete(state.topic);
    },
    onChange() {
      drawMap();
      markAll();
    },
    onX: setYear,
    onCsv: download,
    tooltip,
  });

  // The map tooltip follows the pointer (to its right).
  const mapEl = map.map.getContainer();
  mapEl.addEventListener("pointermove", (e) => {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  mapEl.addEventListener("pointerleave", () => (tooltip.hidden = true));

  // --- Rendering -------------------------------------------------------------------------------
  let frame = 0;
  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  const topicDef = (): TopicDef => TOPICS.find((t) => t.id === state.topic)!;

  function context(): Ctx | null {
    const latest = latestYear();
    if (!latest) return null;
    const c = state.selection?.country ?? null;
    const country = c && regionOf.has(c.m49) ? { m49: c.m49, name: names.get(c.m49) ?? c.name } : null;
    return {
      year: Math.min(state.year, latest),
      selectedYear: state.year,
      country,
      region: country ? regions.find((r) => r.code === regionOf.get(country.m49)) ?? null : null,
      regions,
      countries,
      nameOf: (m49) => names.get(m49) ?? String(m49),
      canSelect,
      width: Math.max(240, cardsEl.clientWidth - 22),
    };
  }

  function draw() {
    const shown = state.view === "country";
    panel.hidden = !shown;
    if (!shown) {
      legend.hidden = true;
      tooltip.hidden = true;
      current = null;
      map.setCountryFills(null);
      map.setCountrySymbols(null);
      return;
    }
    for (const b of $("cp-topics").querySelectorAll<HTMLElement>("[data-topic]")) {
      b.setAttribute("aria-selected", String(b.dataset.topic === state.topic));
    }

    const sel = state.selection?.country;
    $("cp-title").textContent = sel?.name ?? "World";
    const status = state.status.get(state.topic) ?? { kind: "loading" };
    const ctx = status.kind === "ready" ? context() : null;
    const message = $("cp-message");
    message.classList.toggle("error", status.kind === "error");
    if (!ctx) {
      $("cp-subtitle").textContent = "";
      message.textContent = status.kind === "error" ? status.message : "Loading AQUASTAT data…";
      message.hidden = false;
      $("cp-stats").innerHTML = "";
      cardsEl.innerHTML = "";
      legend.hidden = true;
      map.setCountryFills(null);
      map.setCountrySymbols(null);
      current = null;
      return;
    }

    $("cp-subtitle").textContent = [
      sel && !ctx.country ? "Not reported by AQUASTAT" : ctx.region?.name ?? (sel ? "" : "All countries"),
      ctx.year < state.year ? `${ctx.year}: AQUASTAT's latest` : String(ctx.year),
    ].filter(Boolean).join(" · ");
    message.hidden = true;

    const topic = topicDef();
    $("cp-stats").innerHTML = topic.tiles.map((t) => tileHtml(t, ctx)).join("");
    const csv = new Map<string, (string | number)[][]>();
    cardsEl.innerHTML = topic.cards
      .map((card) => {
        const out = card.render(ctx);
        csv.set(card.id, out.csv);
        return cardHtml(card, ctx, out.html, out.csv.length > 1);
      })
      .join("") + `<p class="wb-about">${esc(topic.about)} Source: FAO AQUASTAT.</p>`;
    current = { ctx, spec: specFor(ctx), csv };
    markAll();
    drawMap();
  }

  function tileHtml(t: Tile, ctx: Ctx) {
    const v = t.value(ctx);
    return `<button data-driver="${t.id}" style="--var-color:${t.color}" title="Show on the map">` +
      `<span class="wb-stat-label">${esc(t.label)}</span>` +
      `<span class="wb-stat-value">${fmt(v)}</span>` +
      `<span class="wb-stat-unit">${esc(t.unit)}</span></button>`;
  }

  function cardHtml(card: Card, ctx: Ctx, chart: string, hasCsv: boolean) {
    return `<section class="cp-card" data-driver="${card.id}" tabindex="0" aria-label="${esc(card.title(ctx))}">` +
      `<h3><span>${esc(card.title(ctx))}</span><span class="cp-card-actions">` +
      `<span class="cp-pin" aria-hidden="true">Pinned</span>` +
      (hasCsv ? `<button class="wb-csv" data-csv="${card.id}">CSV</button>` : "") +
      `</span></h3><p>${esc(card.caption(ctx))}</p>${chart}</section>`;
  }

  /** The driver the map follows now. */
  function activeDriver(): Driver {
    return drivers.preview() ?? state.pinned.get(state.topic) ?? { id: topicDef().tiles[0].id, sub: null };
  }

  function specFor(ctx: Ctx): MapSpec {
    const topic = topicDef();
    const d = activeDriver();
    const tile = topic.tiles.find((t) => t.id === d.id);
    if (tile) return tile.map(ctx);
    const card = topic.cards.find((c) => c.id === d.id) ?? topic.cards[0];
    return card.map(ctx, d.sub);
  }

  function markAll() {
    markDrivers(panel, activeDriver(), drivers.preview(), state.pinned.get(state.topic) ?? null);
  }

  // --- The map ---------------------------------------------------------------------------------
  function drawMap() {
    if (!current) return;
    const { ctx } = current;
    const spec = specFor(ctx);
    current.spec = spec;
    const d = activeDriver();
    const area = d.sub?.startsWith("area:") ? Number(d.sub.slice(5)) : null;
    // A row of a regional chart picks out its countries.
    const picked = area === null || area === WORLD ? null : new Set(regions.find((r) => r.code === area)?.members ?? [area]);
    const key = `${spec.id}:${ctx.year}:${area ?? ""}:${ctx.country?.m49 ?? ""}`;
    const values = countries.map((m49) => spec.value(m49));
    const theme = map.theme;
    const dim = (c: Color, m49: number, v: number): Color => {
      const out = (picked && !picked.has(m49)) || (spec.emphasis && !spec.emphasis(v));
      return out ? mix(c, theme.land, 0.78) : c;
    };

    const style = spec.style;
    let scale: ColorScale | null = null;
    const fills = new Map<number, Color>();
    const symbols: { position: [number, number]; radius: number; fill: Color; line: Color }[] = [];

    if (style.kind === "circles") {
      // Circle area proportional to the value; the largest gets MAX_R pixels.
      const MAX_R = 30;
      const max = Math.max(...values.filter(Number.isFinite), 0) || 1;
      const color = hexToColor(style.color);
      countries.forEach((m49, i) => {
        const v = values[i];
        const center = centerOf.get(m49);
        if (!center || !(v > 0)) return;
        const faded = (picked && !picked.has(m49)) || (spec.emphasis && !spec.emphasis(v));
        symbols.push({
          position: center,
          radius: Math.max(1.5, MAX_R * Math.sqrt(v / max)),
          fill: [color[0], color[1], color[2], faded ? 40 : 150],
          line: faded ? [color[0], color[1], color[2], 90] : [255, 255, 255, 220],
        });
      });
      // Small ones on top of big ones.
      symbols.sort((a, b) => b.radius - a.radius);
      if (picked) for (const m49 of picked) fills.set(m49, theme.selected);
    } else {
      if (style.kind === "ramp") scale = rampScale(style, values, style.domain);
      countries.forEach((m49, i) => {
        const v = values[i];
        let c: Color | null = null;
        if (style.kind === "ramp") c = scale!.color(v);
        else if (style.kind === "classes") c = Number.isFinite(v) ? hexToColor((style.classes.find((k) => v < k.max) ?? style.classes[style.classes.length - 1]).color) : null;
        else if (style.kind === "categories") {
          const cat = style.category(m49);
          // A third (a tie of all three) is palest, all of it is the full colour.
          if (cat) c = mix(hexToColor(style.categories[cat.index].color), theme.land, 0.7 * (1 - Math.min(1, (cat.share - 1 / 3) / (2 / 3))));
        }
        fills.set(m49, dim(c ?? theme.noData, m49, v));
      });
    }
    // Rings around the countries a ranking names (most are too small to see).
    for (const m49 of spec.listed ?? []) {
      const center = centerOf.get(m49);
      if (center) symbols.push({ position: center, radius: 7, fill: [0, 0, 0, 0], line: theme.outline });
    }
    // …and a bigger one in the marker colour around a country picked in a chart.
    if (picked && picked.size === 1) {
      const center = centerOf.get([...picked][0]);
      if (center) symbols.push({ position: center, radius: 12, fill: [0, 0, 0, 0], line: theme.marker });
    }
    map.setCountryFills({ key, colors: fills });
    map.setCountrySymbols(symbols.length ? { key: `${key}:${symbols.length}`, items: symbols } : null);
    drawLegend(spec, scale, d, ctx);
    showMapTooltip();
  }

  function drawLegend(spec: MapSpec, scale: ColorScale | null, d: Driver, ctx: Ctx) {
    legend.hidden = false;
    const topic = topicDef();
    const name = topic.tiles.find((t) => t.id === d.id)?.label ?? topic.cards.find((c) => c.id === d.id)?.title(ctx) ?? "";
    const pinned = state.pinned.get(state.topic);
    const mode = drivers.preview() ? "Preview" : pinned ? "Pinned" : "Default";
    $("cp-legend-source").innerHTML = `<b>${mode}</b> · ${esc(name)}` + (pinned && !drivers.preview() ? ` <span class="cp-unpin">(Esc to unpin)</span>` : "");
    $("cp-legend-title").innerHTML = `${esc(spec.title)}${spec.note ? `<small>${esc(spec.note)}</small>` : ""}`;
    $("cp-legend-year").textContent = String(ctx.year);
    $("cp-legend-unit").textContent = spec.unit;
    const style = spec.style;
    const scaleEl = $("cp-legend-scale");
    if (style.kind === "ramp" && scale) {
      scaleEl.innerHTML = `<div class="legend-ramp" style="background:${scale.gradient}"></div>` +
        `<div class="legend-ticks">${scale.ticks.map((t) => `<span style="left:${t.at * 100}%">${fmt(t.value)}</span>`).join("")}</div>`;
    } else if (style.kind === "classes") {
      scaleEl.innerHTML = `<ul class="cp-classes">${style.classes
        .map((k) => `<li${spec.emphasis && !spec.emphasis(k.max - 1e-9) ? ` class="dimmed"` : ""}><i style="background:${k.color}"></i>${esc(k.label)}</li>`)
        .join("")}</ul>`;
    } else if (style.kind === "categories") {
      scaleEl.innerHTML = `<ul class="cp-classes">${style.categories
        .map((k) => `<li><i style="background:linear-gradient(to right, ${k.color}55, ${k.color})"></i>${esc(k.label)}</li>`)
        .join("")}</ul>`;
    } else {
      scaleEl.innerHTML = "";
    }
    const latest = latestYear();
    $("cp-legend-status").textContent = state.year > latest ? `AQUASTAT's latest data are for ${latest}.` : "";
  }

  function showMapTooltip() {
    const m49 = state.mapHover;
    if (m49 === null || !current) return;
    const { spec } = current;
    const v = spec.value(m49);
    let text = `${fmt(v)} ${esc(spec.unit)}`;
    if (spec.style.kind === "categories") {
      const cat = spec.style.category(m49);
      text = cat ? `${esc(spec.style.categories[cat.index].label)}: ${Math.round(cat.share * 100)}% of withdrawal` : "–";
    }
    tooltip.innerHTML = `<b>${esc(names.get(m49) ?? String(m49))}</b><br>${esc(spec.title)}: ${text}`;
    tooltip.hidden = false;
  }

  // --- Downloads ----------------------------------------------------------------------------------
  function download(id: string) {
    const rows = current?.csv.get(id);
    if (!rows || !current) return;
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${id}_${current.ctx.country?.m49 ?? "world"}_${current.ctx.year}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  new ResizeObserver(() => {
    if (state.view === "country") render();
  }).observe(cardsEl);

  return {
    setView(view) {
      state.view = view;
      if (view === "country") load();
      render();
    },
    setRange(range) {
      const year = dkY(range.start);
      if (year === state.year) return;
      state.year = year;
      render();
    },
    setSelection(selection) {
      state.selection = selection;
      render();
    },
    hover(m49) {
      state.mapHover = m49;
      if (m49 === null) tooltip.hidden = true;
      else showMapTooltip();
    },
  };
}

const csvCell = (v: string | number) =>
  typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
