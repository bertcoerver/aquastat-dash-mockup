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
 * top bar. For a range of years, every value is the mean of its yearly values. Clicking a row of a region (or country) also flies the map there, keeping
 * the selected country in view where both fit (see flyToArea).
 * Hovering a country on the map shows its value. A colour ramp in the legend is a menu
 * of how much of the countries' values it spans (panels/ramp-menu.ts), unless the map
 * has a fixed range (a share, 0–100%).
 *
 * The markup lives in index.html.
 */
import type { WaterMap } from "../map/map";
import { flyTo, type Box } from "../map/fly-to";
import { mixColor as mix, type Color } from "../map/theme";
import type { Selection } from "../selection";
import { fmt, hexToColor, rampScale, type ColorScale } from "../basin/variables";
import { DEFAULT_STRETCH, fmtStop, initRampMenu } from "../panels/ramp-menu";
import { dkY } from "../toolbar/dekads";
import type { DekadRange, View } from "../toolbar/range-rules";
import { TOPICS, type Card, type Ctx, type MapClass, type MapSpec, type Region, type Tile, type TopicDef } from "./cards";
import { WORLD, latestYear, loadTopic, periodLabel, type Period, type Topic } from "./data";
import { initTitleMenu, type MenuOption } from "../panels/title-menu";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import { slideSelection } from "../panels/segmented";

export interface CountryInfo {
  regions: { code: number; name: string }[];
  countries: Record<string, { region: number; center: [number, number] }>;
}

interface Options {
  map: WaterMap;
  info: CountryInfo;
  names: Map<number, string>;
  /** Each country's [west, south, east, north] (west > east across 180°). */
  boxes: Map<number, Box>;
  /** Select a year in the top bar (from clicking a year on a chart). */
  setYear: (year: number) => void;
  canSelect: (year: number) => boolean;
  /** AQUASTAT's latest year, each time a topic's data are loaded. */
  onLatestYear: (year: number) => void;
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
/** The period as the subtitle and the map legend show it: "2023", or "2019–2023 average". */
const shownPeriod = (ctx: Ctx) => (ctx.period.from < ctx.period.to ? `${ctx.label} average` : ctx.label);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The class a value falls in: the first whose upper bound it is below, else the last. */
const classIndex = (classes: MapClass[], v: number) => {
  const i = classes.findIndex((k) => v < k.max);
  return i < 0 ? classes.length - 1 : i;
};

export function initCountryPanel({ map, info, names, boxes, setYear, canSelect, onLatestYear }: Options): CountryPanel {
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
    period: { from: 0, to: 0 } as Period,
    selection: null as Selection | null,
    topic: "sdg" as Topic,
    status: new Map<Topic, Status>(),
    pinned: new Map<Topic, Driver>(),
    /** The map picked in the legend's menu, per topic (else the topic's first tile). */
    chosen: new Map<Topic, Driver>(),
    mapHover: null as number | null,
    /** Classes (or categories) switched off in the map legend, for the map with this id. */
    hiddenClasses: { id: "", set: new Set<number>() },
    /** How much of the countries' values a colour ramp spans (% cut at either end). */
    stretch: DEFAULT_STRETCH,
  };

  const panel = $("cp-panel");
  const legend = $("cp-legend");
  const tooltip = $("cp-tooltip");
  const cardsEl = $("cp-cards");
  let current: { ctx: Ctx; spec: MapSpec; csv: Map<string, (string | number)[][]> } | null = null;

  // --- Topic tabs ------------------------------------------------------------------
  $("cp-topics").innerHTML = TOPICS.map((t) => `<button role="tab" data-topic="${t.id}">${t.label}</button>`).join("");
  slideSelection($("cp-topics"));
  $("cp-topics").addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-topic]");
    if (!button) return;
    state.topic = button.dataset.topic as Topic;
    drivers.clearPreview();
    load();
    render();
  });

  function load() {
    const topic = state.topic;
    if (state.status.get(topic)?.kind === "ready") return;
    state.status.set(topic, { kind: "loading" });
    loadTopic(topic).then(
      () => {
        state.status.set(topic, { kind: "ready" });
        onLatestYear(latestYear());
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
      const area = areaOf(d);
      if (area !== null && area !== WORLD) flyToArea(area);
    },
    onChange() {
      drawMap();
      markAll();
    },
    onX: setYear,
    onCsv: download,
    tooltip,
  });

  // Clicking a class's swatch in the legend hides that class on the map, or shows it again.
  $("cp-legend-scale").addEventListener("click", (e) => {
    const swatch = (e.target as Element).closest<HTMLElement>("[data-class]");
    if (!swatch) return;
    const set = state.hiddenClasses.set;
    const index = Number(swatch.dataset.class);
    if (!set.delete(index)) set.add(index);
    drawMap();
  });

  // How much of the countries' values the colours span: a menu on the ramp.
  const rampMenu = initRampMenu($("cp-legend-ramp") as HTMLButtonElement, "the countries' values", state.stretch, (cut) => {
    state.stretch = cut;
    drawMap();
  });

  // --- The legend's indicator menu ---------------------------------------------------------
  // Each of the topic's maps once (several charts can share one), in the order of the
  // tiles and cards. Picking one unpins the chart that was pinned.
  const indicator = initTitleMenu(
    $("cp-indicator") as HTMLButtonElement,
    () => {
      if (!current) return { options: [], current: null };
      const ctx = current.ctx;
      const topic = topicDef();
      const options: MenuOption[] = [];
      const seen = new Set<string>();
      for (const [id, spec] of [
        ...topic.tiles.map((t) => [t.id, t.map(ctx)] as const),
        ...topic.cards.map((c) => [c.id, c.map(ctx, null)] as const),
      ]) {
        if (seen.has(spec.title)) continue;
        seen.add(spec.title);
        options.push({ id, label: spec.title });
      }
      return { options, current: options.find((o) => o.label === current!.spec.title)?.id ?? null };
    },
    (id) => {
      state.chosen.set(state.topic, { id, sub: null });
      state.pinned.delete(state.topic);
      drivers.clearPreview();
      drawMap();
      markAll();
    },
  );

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
    const to = Math.min(state.period.to, latest);
    const period = { from: Math.min(state.period.from, to), to };
    return {
      period,
      label: periodLabel(period),
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
    const status = state.status.get(state.topic) ?? { kind: "loading" };
    const ctx = status.kind === "ready" ? context() : null;
    const message = $("cp-message");
    message.classList.toggle("error", status.kind === "error");
    if (!ctx) {
      $("cp-subtitle").textContent = "";
      message.textContent = status.kind === "error" ? status.message : "";
      message.hidden = status.kind !== "error";
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
      ctx.period.to < state.period.to ? `${shownPeriod(ctx)}: AQUASTAT's latest` : shownPeriod(ctx),
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
      (hasCsv ? `<button class="wb-csv" data-csv="${card.id}">CSV</button>` : "") +
      `<button class="cp-unpin" data-unpin title="Remove pin" aria-label="Remove pin">×</button>` +
      `</span></h3><p>${esc(card.caption(ctx))}</p>${chart}</section>`;
  }

  /** The driver the map follows now. */
  function activeDriver(): Driver {
    return drivers.preview() ?? state.pinned.get(state.topic) ?? state.chosen.get(state.topic) ?? { id: topicDef().tiles[0].id, sub: null };
  }

  const areaOf = (d: Driver | null | undefined) => (d?.sub?.startsWith("area:") ? Number(d.sub.slice(5)) : null);

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
    // A series hovered in the pinned card keeps the pinned row's countries picked out.
    const area = areaOf(drivers.preview()) ?? areaOf(state.pinned.get(state.topic));
    // A row of a regional chart picks out its countries.
    const picked = area === null || area === WORLD ? null : new Set(regions.find((r) => r.code === area)?.members ?? [area]);
    // Classes switched off in the legend stay off only while the same map is shown.
    if (state.hiddenClasses.id !== spec.id) state.hiddenClasses = { id: spec.id, set: new Set(spec.hidden) };
    const hidden = state.hiddenClasses.set;
    const key = `${spec.id}:${state.stretch}:${ctx.label}:${area ?? ""}:${ctx.country?.m49 ?? ""}:${[...hidden].sort().join(",")}`;
    const values = countries.map((m49) => spec.value(m49));
    const theme = map.theme;
    // Countries outside the rows' countries are hidden (plain land), like a class switched
    // off in the legend. The selected country keeps its colour, in either case.
    const outside = (m49: number) => !!picked && !picked.has(m49) && m49 !== ctx.country?.m49;

    const style = spec.style;
    let scale: ColorScale | null = null;
    const fills = new Map<number, Color>();
    const symbols: { position: [number, number]; radius: number; fill: Color; line: Color }[] = [];
    // The classes (or categories) of the countries a picked row leaves on the map.
    const present = picked ? new Set<number>() : null;

    if (style.kind === "circles") {
      // Circle area proportional to the value; the largest gets MAX_R pixels.
      const MAX_R = 30;
      const max = Math.max(...values.filter(Number.isFinite), 0) || 1;
      const color = hexToColor(style.color);
      countries.forEach((m49, i) => {
        const v = values[i];
        const center = centerOf.get(m49);
        if (!center || !(v > 0) || outside(m49)) return;
        symbols.push({
          position: center,
          radius: Math.max(1.5, MAX_R * Math.sqrt(v / max)),
          fill: [color[0], color[1], color[2], 150],
          line: [255, 255, 255, 220],
        });
      });
      // Small ones on top of big ones.
      symbols.sort((a, b) => b.radius - a.radius);
      if (picked) for (const m49 of picked) fills.set(m49, theme.selected);
    } else {
      if (style.kind === "ramp") scale = rampScale(style, values, style.domain, state.stretch);
      countries.forEach((m49, i) => {
        if (outside(m49)) return fills.set(m49, theme.land);
        const v = values[i];
        let c: Color | null = null;
        if (style.kind === "ramp") c = scale!.color(v);
        else if (style.kind === "classes") {
          if (Number.isFinite(v)) {
            const index = classIndex(style.classes, v);
            present?.add(index);
            if (hidden.has(index) && m49 !== ctx.country?.m49) return fills.set(m49, theme.land);
            c = hexToColor(style.classes[index].color);
          }
        } else if (style.kind === "categories") {
          const cat = style.category(m49);
          if (cat) present?.add(cat.index);
          if (cat && hidden.has(cat.index) && m49 !== ctx.country?.m49) return fills.set(m49, theme.land);
          // A third (a tie of all three) is palest, all of it is the full colour.
          if (cat) c = mix(hexToColor(style.categories[cat.index].color), theme.land, 0.7 * (1 - Math.min(1, (cat.share - 1 / 3) / (2 / 3))));
        }
        fills.set(m49, c ?? theme.noData);
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
    drawLegend(spec, scale, ctx, present);
    showMapTooltip();
  }

  /** `present`: with a row picked, the classes its countries fall in; the others show as off. */
  function drawLegend(spec: MapSpec, scale: ColorScale | null, ctx: Ctx, present: Set<number> | null) {
    legend.hidden = false;
    indicator.setLabel(spec.title);
    $("cp-legend-note").textContent = spec.note ?? "";
    $("cp-legend-year").textContent = shownPeriod(ctx);
    $("cp-legend-unit").textContent = spec.unit;
    const style = spec.style;
    const scaleEl = $("cp-legend-scale");
    const ramp = $("cp-legend-ramp");
    const ticks = $("cp-legend-ticks");
    const isRamp = style.kind === "ramp" && !!scale;
    ramp.hidden = ticks.hidden = !isRamp;
    if (style.kind === "ramp" && scale) {
      // A fixed range (a share): nothing to pick.
      rampMenu.setEnabled(!style.domain);
      ramp.style.background = scale.gradient;
      const span = Math.max(...scale.ticks.map((t) => t.value)) - Math.min(...scale.ticks.map((t) => t.value));
      ticks.innerHTML = scale.ticks.map((t) => `<span style="left:${t.at * 100}%">${fmtStop(t.value, span)}</span>`).join("");
      scaleEl.innerHTML = "";
    } else if (style.kind === "classes") {
      scaleEl.innerHTML = `<ul class="cp-classes">${style.classes
        .map((k, i) => classItem(i, k.label, k.color, present))
        .join("")}</ul>`;
    } else if (style.kind === "categories") {
      scaleEl.innerHTML = `<ul class="cp-classes">${style.categories
        .map((k, i) => classItem(i, k.label, `linear-gradient(to right, ${k.color}55, ${k.color})`, present))
        .join("")}</ul>`;
    } else {
      scaleEl.innerHTML = "";
    }
    const latest = latestYear();
    $("cp-legend-status").textContent = state.period.to > latest ? `AQUASTAT's latest data are for ${latest}.` : "";
  }

  /** A legend row whose swatch switches its class on and off on the map. */
  function classItem(index: number, label: string, background: string, present: Set<number> | null) {
    if (present && !present.has(index)) {
      return `<li class="off"><button type="button" class="cp-swatch" disabled title="None of the picked countries" ` +
        `style="background:${background}"></button>${esc(label)}</li>`;
    }
    const off = state.hiddenClasses.set.has(index);
    return `<li${off ? ` class="off"` : ""}><button type="button" class="cp-swatch" data-class="${index}" aria-pressed="${!off}" ` +
      `title="${off ? "Show" : "Hide"} on the map" style="background:${background}"></button>${esc(label)}</li>`;
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

  // --- The camera ------------------------------------------------------------------------------
  /** Fly to an area's countries, and the selected country where they fit with it (see flyTo). */
  function flyToArea(area: number) {
    const members = regions.find((r) => r.code === area)?.members ?? [area];
    const extent = (m49: number) => ({ box: boxes.get(m49)!, center: centerOf.get(m49) });
    const sel = state.selection?.country?.m49;
    const extra = sel !== undefined && !members.includes(sel) && boxes.has(sel) ? extent(sel) : null;
    flyTo(map, members.filter((m49) => boxes.has(m49)).map(extent), extra);
  }

  // --- Downloads ----------------------------------------------------------------------------------
  function download(id: string) {
    const rows = current?.csv.get(id);
    if (!rows || !current) return;
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${id}_${current.ctx.country?.m49 ?? "world"}_${current.ctx.period.from}-${current.ctx.period.to}.csv`;
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
      const [from, to] = [dkY(range.start), dkY(range.end)];
      if (from === state.period.from && to === state.period.to) return;
      state.period = { from, to };
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
