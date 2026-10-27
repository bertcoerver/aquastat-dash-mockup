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
 * Hovering a country on the map shows its value. A switch in a map's legend section draws
 * it as the countries' colours, circles or 3D bars (panels/shape-switch.ts); the amounts'
 * maps are circles or bars. Their key of sizes is a menu of how they look
 * (panels/shape-style.ts: the map's colours or by sign, the full size). A colour ramp in the legend is a menu
 * of how much of the countries' values it spans (panels/ramp-menu.ts), unless the map
 * has a fixed range (a share, 0–100%).
 *
 * The markup lives in index.html.
 */
import type { WaterMap } from "../map/map";
import { flyTo, type Box } from "../map/fly-to";
import { mixColor as mix, type Color } from "../map/theme";
import type { Selection } from "../selection";
import { fmt, hexToColor, rampScale } from "../basin/variables";
import { SLOT_HINTS, initLayerLegend, onePerSlot, toggled, type LegendKey, type SizesKey } from "../panels/legend";
import { DEFAULT_STRETCH } from "../panels/ramp-menu";
import { dkY } from "../toolbar/dekads";
import type { DekadRange, View } from "../toolbar/range-rules";
import { TOPICS, type Card, type Ctx, type MapClass, type MapSpec, type Region, type Tile, type TopicDef } from "./cards";
import { WORLD, latestYear, loadTopic, periodLabel, type Period, type Topic } from "./data";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import { slideSelection } from "../panels/segmented";
import { SHAPE_NOTES, SHAPES, initShapeSwitch, shapeSizes, type Shape } from "../panels/shape-switch";
import { describeStyle, initShapeStyles, signColor, sizeKey, type ShapeStyle } from "../panels/shape-style";
import type { Bar } from "../map/layers/bars";
import type { CountrySymbol } from "../map/layers/countries";

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
  /** Lock the legend's ranges (when a range starts playing, so the years compare). */
  lockLegend(): void;
}

/** How the maps are drawn, in the legend's order: fills, circles, bars (each a Shape). */
const SLOTS: Shape[] = ["fill", "circles", "bars"];

/** A map on the map: its tile or card, and how it's drawn (the legend's slot). */
interface Layer {
  d: Driver;
  spec: MapSpec;
  slot: Shape;
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
    /** The maps checked in the legend, oldest first, per topic (none: the topic's first tile's). */
    chosen: new Map<Topic, string[]>(),
    mapHover: null as number | null,
    /** Classes (or categories) switched off in the map legend, per map on the map (by id). */
    hiddenClasses: new Map<string, Set<number>>(),
    /** How much of the countries' values a colour ramp spans (% cut at either end). */
    stretch: DEFAULT_STRETCH,
  };

  const panel = $("cp-panel");
  const tooltip = $("cp-tooltip");
  const cardsEl = $("cp-cards");
  let current: { ctx: Ctx; layers: Layer[]; csv: Map<string, (string | number)[][]> } | null = null;

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

  // --- The legend ----------------------------------------------------------------------------
  // Its title is a checklist of the topic's maps, each once (several charts can share one),
  // in the order of the tiles and cards; each one on the map has a section
  // (panels/legend.ts). Checking one unpins the chart that was pinned (its map stays).
  const legend = initLayerLegend($("cp-legend"), {
    slots: SLOTS,
    options() {
      if (!current) return { options: [], current: [] };
      const ctx = current.ctx;
      const options = menuMaps(ctx).map(({ id, spec }) => ({ id, label: spec.title, hint: SLOT_HINTS[slotOf(spec)] }));
      return { options, current: current.layers.map((l) => optionId(ctx, l.spec)) };
    },
    onToggle(id) {
      if (!current) return;
      state.chosen.set(state.topic, toggled(current.layers.map((l) => optionId(current!.ctx, l.spec)), id));
      state.pinned.delete(state.topic);
      drivers.clearPreview();
      drawMap();
      markAll();
    },
    // How much of the countries' values the colours span: a menu on the ramp.
    ramp: {
      of: "the countries' values",
      initial: state.stretch,
      onPick(cut) {
        state.stretch = cut;
        drawMap();
      },
    },
    // How a map's circles or bars look: a menu on their sizes.
    sizes: {
      options(slot) {
        const spec = current?.layers.find((l) => l.slot === slot)?.spec;
        return spec ? styles.menu(spec.title, initialStyle(spec, slot as Shape), signed(spec)) : { options: [], current: [] };
      },
      onPick(slot, id) {
        const spec = current?.layers.find((l) => l.slot === slot)?.spec;
        if (!spec) return;
        styles.pick(spec.title, id);
        drawMap();
      },
      title(slot) {
        const layer = current?.layers.find((l) => l.slot === slot);
        return layer ? describeStyle(styleOf(layer.spec, layer.slot), layer.slot) : "";
      },
    },
    // Clicking a class's swatch hides that class on the map, or shows it again.
    onClass(slot, index) {
      const set = state.hiddenClasses.get(current?.layers.find((l) => l.slot === slot)?.spec.id ?? "");
      if (!set) return;
      if (!set.delete(index)) set.add(index);
      drawMap();
    },
    onLock: () => drawMap(),
  });

  /** The topic's maps, each once, in the order of the tiles and cards. */
  function menuMaps(ctx: Ctx): { id: string; spec: MapSpec }[] {
    const topic = topicDef();
    const seen = new Set<string>();
    return [
      ...topic.tiles.map((t) => ({ id: t.id, spec: t.map(ctx) })),
      ...topic.cards.map((c) => ({ id: c.id, spec: c.map(ctx, null) })),
    ].filter(({ spec }) => !seen.has(spec.title) && !!seen.add(spec.title));
  }
  /** The checklist's option for a map (by its title, as charts share maps). */
  const optionId = (ctx: Ctx, spec: MapSpec) => menuMaps(ctx).find((m) => m.spec.title === spec.title)?.id ?? spec.id;
  // Each map's shape (colours, circles, bars): a switch in its legend section. Switched, it
  // goes last in the checklist, so it takes its new slot from the map there.
  const shapes = initShapeSwitch(legend, (title) => {
    const ctx = current?.ctx;
    const ids = state.chosen.get(state.topic);
    const moved = ctx && ids?.find((id) => specFor(ctx, { id, sub: null }).title === title);
    if (moved) state.chosen.set(state.topic, [...ids!.filter((id) => id !== moved), moved]);
    drawMap();
  });
  /** The shapes a map can take: an amount's circles or bars, any value's colours too (not a mix of categories). */
  const shapesOf = (spec: MapSpec): Shape[] =>
    spec.style.kind === "circles" ? ["circles", "bars"] : spec.style.kind === "categories" ? ["fill"] : SHAPES;
  /** How a map is drawn (its slot). */
  const slotOf = (spec: MapSpec): Shape => shapes.shape(spec.title, shapesOf(spec));
  // How a map's circles or bars look: its colours, or by sign; an amount's largest circle
  // at full size, else the 98th percentile.
  const styles = initShapeStyles();
  const initialStyle = (spec: MapSpec, slot: Shape): ShapeStyle => ({ colours: "map", full: spec.style.kind === "circles" && slot === "circles" ? 1 : 0.98 });
  const signed = (spec: MapSpec) => spec.style.kind === "ramp" && spec.style.scale === "diverging";
  const styleOf = (spec: MapSpec, slot: Shape) => styles.get(spec.title, initialStyle(spec, slot), signed(spec));

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
      legend.show(null);
      tooltip.hidden = true;
      current = null;
      map.setCountryFills(null);
      map.setCountrySymbols(null);
      map.setBars("country", null);
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
      legend.show(null);
      map.setCountryFills(null);
      map.setCountrySymbols(null);
      map.setBars("country", null);
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
    current = { ctx, layers: [], csv };
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

  /** The previewed or pinned tile or card. */
  const leadDriver = (): Driver | null => drivers.preview() ?? state.pinned.get(state.topic) ?? null;

  /** The driver the map follows now: previewed, pinned, or the first map on it. */
  function activeDriver(): Driver {
    return leadDriver() ?? (current ? shownLayers(current.ctx)[0].d : { id: topicDef().tiles[0].id, sub: null });
  }

  const areaOf = (d: Driver | null | undefined) => (d?.sub?.startsWith("area:") ? Number(d.sub.slice(5)) : null);

  /** The maps on the map: those checked in the legend (else the first tile's), with the previewed or pinned one in its slot. */
  function shownLayers(ctx: Ctx): Layer[] {
    const topic = topicDef();
    const known = (id: string) => topic.tiles.some((t) => t.id === id) || topic.cards.some((c) => c.id === id);
    const chosen = (state.chosen.get(state.topic) ?? []).filter(known);
    const layers = (chosen.length ? chosen : [topic.tiles[0].id]).map((id) => layerOf(ctx, { id, sub: null }));
    const lead = leadDriver();
    if (!lead) return onePerSlot(layers, SLOTS);
    const l = layerOf(ctx, lead);
    return onePerSlot([...layers.filter((m) => m.spec.title !== l.spec.title), l], SLOTS);
  }

  function layerOf(ctx: Ctx, d: Driver): Layer {
    const spec = specFor(ctx, d);
    return { d, spec, slot: slotOf(spec) };
  }

  function specFor(ctx: Ctx, d: Driver): MapSpec {
    const topic = topicDef();
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
    const layers = shownLayers(ctx);
    current.layers = layers;
    // A series hovered in the pinned card keeps the pinned row's countries picked out.
    const area = areaOf(drivers.preview()) ?? areaOf(state.pinned.get(state.topic));
    // A row of a regional chart picks out its countries.
    const picked = area === null || area === WORLD ? null : new Set(regions.find((r) => r.code === area)?.members ?? [area]);
    // Classes switched off in the legend stay off only while their map is shown.
    for (const id of state.hiddenClasses.keys()) if (!layers.some((l) => l.spec.id === id)) state.hiddenClasses.delete(id);
    for (const { spec } of layers) if (!state.hiddenClasses.has(spec.id)) state.hiddenClasses.set(spec.id, new Set(spec.hidden));
    const hiddenKey = layers.map((l) => [...state.hiddenClasses.get(l.spec.id)!].sort().join(",")).join("|");
    const key =
      `${layers.map((l) => `${l.spec.id}:${l.slot}:${Object.values(styleOf(l.spec, l.slot)).join("/")}`).join()}:${state.stretch}:${ctx.label}:${area ?? ""}:` +
      `${ctx.country?.m49 ?? ""}:${hiddenKey}:${legend.lockKey()}`;
    const theme = map.theme;
    // Countries outside the rows' countries are hidden (plain land), like a class switched
    // off in the legend. The selected country keeps its colour, in either case.
    const outside = (m49: number) => !!picked && !picked.has(m49) && m49 !== ctx.country?.m49;

    const fills = new Map<number, Color>();
    const symbols: CountrySymbol[] = [];
    const bars: Bar[] = [];
    const keys = new Map<string, LegendKey | null>();
    const sizes = new Map<string, SizesKey>();
    const css = (c: Color, alpha = 1) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${alpha})`;

    for (const { spec, slot } of layers) {
      const p = paint(spec, picked ? new Set<number>() : null, outside);
      keys.set(slot, p.key);
      if (slot === "fill") {
        for (const m49 of countries) {
          const c = p.color(m49);
          fills.set(m49, c === "off" ? theme.land : c ?? theme.noData);
        }
        continue;
      }
      // Circles (area) or bars (height) by the value, the style's at full size (locked: as
      // when the lock was put on); in the map's colours, or by sign.
      const style = styleOf(spec, slot);
      const bySign = style.colours === "sign";
      const values = countries.map((m49) => Math.abs(spec.value(m49)));
      const size = shapeSizes(values, style.full, (ref) => legend.hold(`${spec.title}:${spec.unit}:${slot}:${style.full}`, ref));
      countries.forEach((m49, i) => {
        const v = values[i];
        const center = centerOf.get(m49);
        const own = p.color(m49);
        if (!center || !(v > 0) || !own || own === "off") return;
        const c = bySign ? signColor(spec.value(m49), theme.storageRise, theme.storageFall) : own;
        if (slot === "circles") {
          // (An amount's in white, as before; others in a darker shade, as their colours can be pale.)
          const line: Color = spec.style.kind === "circles" ? [255, 255, 255, 220] : [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, 230];
          symbols.push({ id: `${m49}`, position: center, radius: size.radius(v), fill: [c[0], c[1], c[2], 170], line });
        } else bars.push({ position: center, height: size.height(v), color: [c[0], c[1], c[2], 255] });
      });
      // The key of their sizes; by sign, or an amount's (in one colour), in place of the colours'.
      const one = spec.style.kind === "circles" ? css(hexToColor(spec.style.color), slot === "circles" ? 0.6 : 1) : css(theme.border, 0.6);
      sizes.set(slot, sizeKey(slot, size, style, { one, rise: css(theme.storageRise), fall: css(theme.storageFall) }));
      if (bySign || spec.style.kind === "circles") keys.set(slot, null);
    }
    // Small circles on top of big ones.
    symbols.sort((a, b) => b.radius - a.radius);
    // Without a map in colours, the picked countries are filled.
    if (!layers.some((l) => l.slot === "fill") && picked) for (const m49 of picked) fills.set(m49, theme.selected);
    // Rings around the countries a ranking names (most are too small to see).
    for (const m49 of new Set(layers.flatMap((l) => l.spec.listed ?? []))) {
      const center = centerOf.get(m49);
      if (center) symbols.push({ id: `listed:${m49}`, position: center, radius: 7, fill: [0, 0, 0, 0], line: theme.outline });
    }
    // …and a bigger one in the marker colour around a country picked in a chart.
    if (picked && picked.size === 1) {
      const m49 = [...picked][0];
      const center = centerOf.get(m49);
      if (center) symbols.push({ id: `picked:${m49}`, position: center, radius: 12, fill: [0, 0, 0, 0], line: theme.marker });
    }
    map.setCountryFills({ key, colors: fills });
    map.setCountrySymbols(symbols.length ? { key: `${key}:${symbols.length}`, items: symbols } : null);
    map.setBars("country", bars.length ? { key, items: bars } : null);

    const latest = latestYear();
    const status = state.period.to > latest ? `AQUASTAT's latest data are for ${latest}.` : "";
    legend.show(
      layers.map(({ spec, slot }) => ({
        slot,
        id: optionId(ctx, spec),
        title: spec.title,
        note: noteOf(spec, slot),
        period: shownPeriod(ctx),
        unit: spec.unit,
        key: keys.get(slot) ?? null,
        sizes: sizes.get(slot) ?? null,
        // Once, under the last section.
        status: slot === layers.at(-1)!.slot ? status : "",
      })),
    );
    shapes.show(layers.map(({ spec, slot }) => ({ title: spec.title, slot, shapes: shapesOf(spec) })));
    showMapTooltip();
  }

  /** A map's note, for the shape it's drawn in. */
  function noteOf(spec: MapSpec, slot: Shape) {
    const note = spec.note ?? "";
    if (spec.style.kind === "circles") return slot === "bars" ? note.replace("Circle area", "Bar height") : note;
    return slot === "fill" ? note : [note, SHAPE_NOTES[slot]].filter(Boolean).join(" · ");
  }

  /**
   * A map's colour per country (null: no value; "off": its class is switched off in the
   * legend, or it's outside the picked row's countries), and the key to its colours.
   * `present`: with a row picked, collects the classes its countries fall in (the others
   * show as absent in the legend).
   */
  function paint(spec: MapSpec, present: Set<number> | null, outside: (m49: number) => boolean) {
    const style = spec.style;
    const ctx = current!.ctx;
    const off = state.hiddenClasses.get(spec.id) ?? new Set<number>();
    // The selected country keeps its colour, even in a class switched off.
    const hides = (m49: number, index: number) => off.has(index) && m49 !== ctx.country?.m49;
    const classState = (i: number) => (present && !present.has(i) ? "absent" : off.has(i) ? "off" : "on");
    let color: (m49: number) => Color | null | "off";
    let key: LegendKey | null = null;
    if (style.kind === "ramp") {
      const values = countries.map((m49) => spec.value(m49));
      let scale = rampScale(style, values, style.domain, state.stretch);
      // Locked, the colours keep their range (a fixed one stays anyway).
      const domain = style.domain || !scale.ticks.length ? scale.domain : legend.hold(`${spec.title}:${spec.unit}`, scale.domain);
      if (domain !== scale.domain) scale = rampScale(style, values, domain);
      color = (m49) => scale.color(spec.value(m49));
      // A fixed range (a share): nothing to pick.
      key = { kind: "ramp", gradient: scale.gradient, ticks: scale.ticks, fixed: !!style.domain };
    } else if (style.kind === "classes") {
      color = (m49) => {
        const v = spec.value(m49);
        if (!Number.isFinite(v)) return null;
        const index = classIndex(style.classes, v);
        present?.add(index);
        return hides(m49, index) ? "off" : hexToColor(style.classes[index].color);
      };
      key = { kind: "classes", items: style.classes.map((k, i) => ({ label: k.label, background: k.color, state: classState(i) })) };
    } else if (style.kind === "categories") {
      color = (m49) => {
        const cat = style.category(m49);
        if (!cat) return null;
        present?.add(cat.index);
        if (hides(m49, cat.index)) return "off";
        // A third (a tie of all three) is palest, all of it is the full colour.
        return mix(hexToColor(style.categories[cat.index].color), map.theme.land, 0.7 * (1 - Math.min(1, (cat.share - 1 / 3) / (2 / 3))));
      };
      key = {
        kind: "classes",
        items: style.categories.map((k, i) => ({ label: k.label, background: `linear-gradient(to right, ${k.color}55, ${k.color})`, state: classState(i) })),
      };
    } else {
      const c = hexToColor(style.color);
      color = () => c;
    }
    // The classes' states are only known once every country's colour is: work them all out now.
    const colors = new Map(countries.map((m49) => [m49, outside(m49) ? ("off" as const) : color(m49)]));
    if (key?.kind === "classes") key.items.forEach((item, i) => (item.state = classState(i)));
    return { color: (m49: number) => colors.get(m49) ?? null, key };
  }

  function showMapTooltip() {
    const m49 = state.mapHover;
    if (m49 === null || !current) return;
    const rows = current.layers.map(({ spec }) => {
      const v = spec.value(m49);
      let text = `${fmt(v)} ${esc(spec.unit)}`;
      if (spec.style.kind === "categories") {
        const cat = spec.style.category(m49);
        text = cat ? `${esc(spec.style.categories[cat.index].label)}: ${Math.round(cat.share * 100)}% of withdrawal` : "–";
      }
      return `${esc(spec.title)}: ${text}`;
    });
    tooltip.innerHTML = `<b>${esc(names.get(m49) ?? String(m49))}</b><br>${rows.join("<br>")}`;
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
    lockLegend: () => legend.lock(),
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
