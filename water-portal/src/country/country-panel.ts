/*
 * Country view: AQUASTAT statistics for the selected country (or the World), after the
 * Country tabs of FAO's Water Portal. A panel on the right, styled like the Basin
 * view's, has one tab per topic (SDG 6.4, water resources, water use, irrigation),
 * each with number tiles and chart cards (cards.ts).
 *
 * Every tile and card has a map that goes with it: hovering previews it, clicking pins
 * it (map-drivers.ts); unpinned, the map shows the topic's first tile. Many bring more
 * maps along (cards.ts, `also`), shown with theirs, each in a shape of its own: those
 * take the places of the maps checked in the legend while shown. The legend lists the
 * maps of all the topics, so maps of different topics can be shown together. Within a card,
 * hovering a row picks out that area's countries on the map, hovering a series in a
 * legend maps that series, and clicking a year on a line chart sets the year in the
 * top bar. For a range of years, every value is the mean of its yearly values. Clicking a row of a region (or country) also flies the map there, keeping
 * the selected country in view where both fit (see flyToArea).
 * Hovering a country on the map shows its values (panels/map-tip.ts), each in its colour there. A switch in a map's legend section draws
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
import { cssRgb as css, mixColor as mix, type Color } from "../map/theme";
import type { Selection } from "../selection";
import { fmt, hexToColor, rampScale } from "../basin/variables";
import { initLayerLegend, onePerSlot, toggled, type LegendKey, type SizesKey } from "../panels/legend";
import { DEFAULT_STRETCH } from "../panels/ramp-menu";
import { dkY } from "../toolbar/dekads";
import type { DekadRange, View } from "../toolbar/range-rules";
import { TOPICS, type Card, type Ctx, type MapClass, type MapSpec, type Region, type Tile, type TopicDef } from "./cards";
import { WORLD, latestYear, loadTopic, periodLabel, type Topic } from "./data";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import { slideSelection } from "../panels/segmented";
import { SHAPE_NOTES, SHAPES, freeShape, initShapePicks, shapeOptions, shapeSizes, switchShape, type MapShapes, type Shape } from "../panels/shape-switch";
import { iconSvg } from "../panels/shape-icons";
import { describeStyle, initShapeStyles, signColor, sizeKey, type ShapeStyle } from "../panels/shape-style";
import type { Bar } from "../map/layers/bars";
import type { CountrySymbol } from "../map/layers/countries";
import { showMapTip, type MapTipRow } from "../panels/map-tip";
import { esc } from "../lib/html";
import { byId as $ } from "../lib/dom";
import { downloadCsv } from "../lib/csv";
import { perFrame } from "../lib/schedule";

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
  /** Fly to a region's countries (or a country). */
  showArea(area: number): void;
  /** Lock the legend's ranges (when a range starts playing, so the years compare). */
  lockLegend(): void;
  /** Let the legend's ranges fit the values again (when it stops). */
  unlockLegend(): void;
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

/** The period as the subtitle and the map legend show it: "2023", or "2019–2023 average". */
const shownPeriod = (ctx: Ctx) => (ctx.period.from < ctx.period.to ? `${ctx.label} average` : ctx.label);
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
    period: { from: 0, to: 0 },
    selection: null as Selection | null,
    topic: "sdg" as Topic,
    status: new Map<Topic, Status>(),
    pinned: new Map<Topic, Driver>(),
    /** The pinned chart's maps unchecked in the legend since it was pinned (by title), per topic. */
    dropped: new Map<Topic, Set<string>>(),
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
  /** Each map's colour per country as drawn (CSS; null: none), by its slot, for the tooltip. */
  let tipColors = new Map<Shape, (m49: number) => string | null>();

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

  /** Load a topic's data: the tab's, or that of a map of another topic on the map. */
  function load(topic = state.topic) {
    const kind = state.status.get(topic)?.kind;
    if (kind === "ready" || kind === "loading") return;
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
      state.dropped.delete(state.topic);
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
  // Its title is a checklist of all the topics' maps, each once (several charts can share one),
  // under their topics, in the order of the tiles and cards, with the icons of how each can be drawn; each one
  // on the map has a section (panels/legend.ts). A map not on the map is offered in a free
  // slot, if there is one. A pinned chart stays pinned: its maps can be unchecked, and
  // a map checked in a slot it uses takes that slot.
  const legend = initLayerLegend($("cp-legend"), {
    slots: SLOTS,
    onOrder: (slots) => map.setLayerOrder("country", slots),
    options() {
      if (!current) return { options: [], current: [] };
      const ctx = current.ctx;
      const on = current.layers.map((l) => optionId(ctx, l.spec));
      const taken = new Set<string>(current.layers.map((l) => l.slot));
      const options = menuMaps(ctx).map(({ id, spec, group }) => {
        const m = shapesOf(spec);
        const icons = m.options.map((o) => ({ id: o.id, html: iconSvg(o.icon), label: o.label, title: o.title }));
        // (On the map, as drawn: a chart's map can be moved out of another's shape.)
        const drawn = current!.layers.find((l) => optionId(ctx, l.spec) === id)?.slot;
        return { id, label: spec.title, group, icons, icon: drawn ?? freeShape(m, taken) };
      });
      return { options, current: on };
    },
    onToggle(id) {
      if (!current) return;
      const ctx = current.ctx;
      const spec = menuMaps(ctx).find((m) => m.id === id)?.spec;
      // Checked, it's drawn as it was offered.
      if (spec && !current.layers.some((l) => optionId(ctx, l.spec) === id)) {
        const m = shapesOf(spec);
        m.set(freeShape(m, new Set(current.layers.map((l) => l.slot))));
      }
      toggle(id);
    },
    // An icon: the map switches (the one in the slot it takes moving out of the way), or
    // is added so. Switched, it goes last in the checklist, so it takes its new slot from
    // the map there; the checked maps it covered stay off (not shown again in the slot it left).
    onShape(id, shape) {
      if (!current) return;
      const ctx = current.ctx;
      const spec = menuMaps(ctx).find((m) => m.id === id)?.spec;
      if (!spec) return;
      switchShape(current.layers.map((l) => shapesOf(l.spec)), shapesOf(spec), shape);
      if (!current.layers.some((l) => optionId(ctx, l.spec) === id)) return toggle(id);
      const shown = new Set(current.layers.map((l) => l.spec.title));
      const ids = (state.chosen.get(state.topic) ?? []).filter((i) => shown.has(specFor(ctx, { id: i, sub: null }).title));
      const moved = ids.find((i) => specFor(ctx, { id: i, sub: null }).title === spec.title);
      state.chosen.set(state.topic, moved ? [...ids.filter((i) => i !== moved), moved] : ids);
      drawMap();
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

  /**
   * All the topics' maps, each once (under the first topic that has it), in the order of
   * the tiles and cards, each followed by those it brings along (id "<driver>~<index>").
   */
  const menuMapsOf = new WeakMap<Ctx, { id: string; spec: MapSpec; group: string }[]>(); // (once per draw)
  function menuMaps(ctx: Ctx): { id: string; spec: MapSpec; group: string }[] {
    let maps = menuMapsOf.get(ctx);
    if (maps) return maps;
    const seen = new Set<string>();
    const withAlso = (id: string, spec: MapSpec, also: MapSpec[] | undefined, group: string) => [
      { id, spec, group },
      ...(also ?? []).map((a, i) => ({ id: `${id}~${i}`, spec: a, group })),
    ];
    maps = TOPICS.flatMap((topic) => [
      ...topic.tiles.flatMap((t) => withAlso(t.id, t.map(ctx), t.also?.(ctx), topic.label)),
      ...topic.cards.flatMap((c) => withAlso(c.id, c.map(ctx, null), c.also?.(ctx, null), topic.label)),
    ]).filter(({ spec }) => !seen.has(spec.title) && !!seen.add(spec.title));
    menuMapsOf.set(ctx, maps);
    return maps;
  }
  /** The checklist's option for a map (by its title, as charts share maps). */
  const optionId = (ctx: Ctx, spec: MapSpec) => menuMaps(ctx).find((m) => m.spec.title === spec.title)?.id ?? spec.id;
  /** Check or uncheck a map. */
  function toggle(id: string) {
    if (!current) return;
    const ctx = current.ctx;
    const pin = state.pinned.get(state.topic);
    const lead = pin ? leadLayers(ctx, pin) : [];
    const dropped = state.dropped.get(state.topic) ?? new Set<string>();
    const own = lead.find((l) => optionId(ctx, l.spec) === id);
    if (own) {
      // One of the pinned chart's maps.
      if (!dropped.delete(own.spec.title)) dropped.add(own.spec.title);
    } else {
      const titles = new Set(lead.map((l) => l.spec.title));
      const ids = toggled(current.layers.filter((l) => !titles.has(l.spec.title)).map((l) => optionId(ctx, l.spec)), id);
      state.chosen.set(state.topic, ids);
      // Checked in a slot the pinned chart's maps use, it takes that slot.
      if (ids.includes(id)) {
        const slot = layerOf(ctx, { id, sub: null }).slot;
        for (const l of lead) if (l.slot === slot) dropped.add(l.spec.title);
      }
    }
    if (pin) state.dropped.set(state.topic, dropped);
    drivers.clearPreview();
    drawMap();
    markAll();
  }
  // Each map's shape (colours, circles, bars): its icons in the legend.
  const shapes = initShapePicks();
  /** The shapes a map can take: an amount's circles or bars, any value's colours too (not a mix of categories). */
  const shapesFor = (spec: MapSpec): Shape[] =>
    spec.style.kind === "circles" ? ["circles", "bars"] : spec.style.kind === "categories" ? ["fill"] : spec.style.kind === "pies" ? ["circles"] : SHAPES;
  /** How a map is drawn (its slot): as switched in the legend, else as it says. */
  const slotOf = (spec: MapSpec): Shape => shapes.shape(spec.title, shapesFor(spec), spec.shape && shapesFor(spec).includes(spec.shape) ? spec.shape : undefined);
  /** How a map can be drawn, and is. */
  const shapesOf = (spec: MapSpec): MapShapes => ({
    title: spec.title,
    options: shapeOptions(shapesFor(spec)),
    current: slotOf(spec),
    set: (id) => shapes.set(spec.title, id as Shape),
  });
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
  mapEl.addEventListener("pointerleave", () => showMapTip(tooltip, null));

  // --- Rendering -------------------------------------------------------------------------------
  const render = perFrame(draw);

  const topicDef = (): TopicDef => TOPICS.find((t) => t.id === state.topic)!;
  /** A map's tile or card, and which of the maps it brings along it is ("<driver>~<index>"; null: its own). */
  const parseId = (id: string) => {
    const [base, k] = id.split("~");
    return { base, also: k === undefined ? null : Number(k) };
  };
  /** The topic a tile or card is in: the tab's, else the first other that has it (undefined: none). */
  const topicOf = (id: string): TopicDef | undefined => {
    const { base } = parseId(id);
    return [topicDef(), ...TOPICS].find((t) => t.tiles.some((m) => m.id === base) || t.cards.some((c) => c.id === base));
  };

  function context(): Ctx | null {
    const latest = latestYear();
    if (!latest) return null;
    const c = state.selection?.country ?? null;
    const country = c && regionOf.has(c.m49) ? { m49: c.m49, name: names.get(c.m49) ?? c.name } : null;
    const picked = state.selection?.region;
    const region = country ? regions.find((r) => r.code === regionOf.get(country.m49)) ?? null : picked ? regions.find((r) => r.code === picked.code) ?? null : null;
    const to = Math.min(state.period.to, latest);
    const period = { from: Math.min(state.period.from, to), to };
    return {
      period,
      label: periodLabel(period),
      country,
      region,
      selected: country ? { code: country.m49, name: country.name } : region && { code: region.code, name: region.name },
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
      showMapTip(tooltip, null);
      current = null;
      map.setCountryFills(null);
      map.setSymbols("country", null);
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
      map.setSymbols("country", null);
      map.setBars("country", null);
      current = null;
      return;
    }

    $("cp-subtitle").textContent = [
      // (The title names the region too.)
      sel && !ctx.country ? "Not reported by AQUASTAT" : ctx.country ? "" : ctx.region ? `${ctx.region.members.length} countries` : "All countries",
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

  /** The driver the map follows now: previewed, pinned, or the first map on it (its tile or card). */
  function activeDriver(): Driver | null {
    const d = leadDriver() ?? (current ? shownLayers(current.ctx)[0]?.d ?? null : { id: topicDef().tiles[0].id, sub: null });
    return d && { ...d, id: parseId(d.id).base };
  }

  const areaOf = (d: Driver | null | undefined) => (d?.sub?.startsWith("area:") ? Number(d.sub.slice(5)) : null);

  /** The maps on the map: those checked in the legend (else the first tile's), with the previewed or pinned one in its slot. */
  function shownLayers(ctx: Ctx): Layer[] {
    const topic = topicDef();
    const known = (id: string) => !!topicOf(id);
    const kept = state.chosen.get(state.topic);
    const chosen = (kept ?? []).filter(known);
    const lead = leadDriver();
    // (The first tile's only alone: under a chart's map, it would show when that one changes
    // slot. None if all were unchecked.)
    const first = kept?.length === 0 || lead ? [] : [topic.tiles[0].id];
    const layers = (chosen.length ? chosen : first).map((id) => layerOf(ctx, { id, sub: null }));
    if (!lead) return onePerSlot(layers, SLOTS);
    const set = leadLayers(ctx, lead);
    const titles = new Set(set.map((l) => l.spec.title));
    // (Less those unchecked since it was pinned, also as its rows are previewed.)
    const pin = state.pinned.get(state.topic);
    const dropped = pin && parseId(pin.id).base === parseId(lead.id).base ? state.dropped.get(state.topic) : undefined;
    const left = set.filter((l) => !dropped?.has(l.spec.title));
    return onePerSlot([...layers.filter((m) => !titles.has(m.spec.title)), ...left], SLOTS);
  }

  /**
   * A tile's or card's map and those it brings along, each in a shape of its own: one
   * that would be drawn as another of them is moves to a free shape it can take (none:
   * it's left out).
   */
  function leadLayers(ctx: Ctx, lead: Driver): Layer[] {
    const own = layerOf(ctx, lead);
    const { base } = parseId(lead.id);
    const topic = topicOf(base) ?? topicDef();
    const also = topic.tiles.find((t) => t.id === base)?.also?.(ctx) ?? topic.cards.find((c) => c.id === base)?.also?.(ctx, lead.sub) ?? [];
    const taken = new Set<Shape>([own.slot]);
    const out: Layer[] = [];
    also.forEach((spec, i) => {
      const want = slotOf(spec);
      const slot = taken.has(want) ? shapesFor(spec).find((s) => !taken.has(s)) : want;
      if (!slot) return;
      taken.add(slot);
      out.push({ d: { id: `${base}~${i}`, sub: lead.sub }, spec, slot });
    });
    return [...out, own];
  }

  function layerOf(ctx: Ctx, d: Driver): Layer {
    const spec = specFor(ctx, d);
    return { d, spec, slot: slotOf(spec) };
  }

  function specFor(ctx: Ctx, d: Driver): MapSpec {
    const { base, also } = parseId(d.id);
    const topic = topicOf(base) ?? topicDef();
    const tile = topic.tiles.find((t) => t.id === base);
    if (tile) return (also !== null ? tile.also?.(ctx)[also] : undefined) ?? tile.map(ctx);
    const card = topic.cards.find((c) => c.id === base) ?? topic.cards[0];
    return (also !== null ? card.also?.(ctx, d.sub)[also] : undefined) ?? card.map(ctx, d.sub);
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
    // A map of another topic needs its data (drawn again once loaded).
    for (const { d } of layers) load(topicOf(d.id)?.id);
    // A series hovered in the pinned card keeps the pinned row's countries picked out.
    const area = areaOf(drivers.preview()) ?? areaOf(state.pinned.get(state.topic));
    // A row of a regional chart picks out its countries; else a region selected on its own does.
    const pickedArea = area ?? (ctx.country ? null : ctx.region?.code ?? null);
    const picked = pickedArea === null || pickedArea === WORLD ? null : new Set(regions.find((r) => r.code === pickedArea)?.members ?? [pickedArea]);
    // Classes switched off in the legend stay off only while their map is shown.
    for (const id of state.hiddenClasses.keys()) if (!layers.some((l) => l.spec.id === id)) state.hiddenClasses.delete(id);
    for (const { spec } of layers) if (!state.hiddenClasses.has(spec.id)) state.hiddenClasses.set(spec.id, new Set(spec.hidden));
    const hiddenKey = layers.map((l) => [...state.hiddenClasses.get(l.spec.id)!].sort().join(",")).join("|");
    const key =
      `${layers.map((l) => `${l.spec.id}:${l.slot}:${Object.values(styleOf(l.spec, l.slot)).join("/")}`).join()}:${state.stretch}:${ctx.label}:${pickedArea ?? ""}:` +
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
    tipColors = new Map();

    for (const { spec, slot } of layers) {
      const p = paint(spec, picked ? new Set<number>() : null, outside);
      keys.set(slot, p.key);
      if (slot === "fill") {
        tipColors.set(slot, (m49) => {
          const c = p.color(m49);
          return c && c !== "off" ? css(c) : null;
        });
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
      // Pies: their parts (those switched off in the legend left out), and their whole.
      const pies = spec.style.kind === "pies" ? spec.style : null;
      const off = state.hiddenClasses.get(spec.id);
      const partsOf = (m49: number) => pies?.amounts(m49)?.map((v, i) => (off?.has(i) ? 0 : v)) ?? null;
      const own = specValues(ctx, spec);
      const values = countries.map((m49, i) => (pies ? partsOf(m49)?.reduce((s, v) => s + v, 0) ?? NaN : Math.abs(own[i])));
      const size = shapeSizes(values, style.full, (ref) => legend.hold(`${spec.title}:${spec.unit}:${slot}:${style.full}`, ref));
      // (A pie's swatch is a pie of its parts.)
      tipColors.set(slot, (m49) => {
        const own = p.color(m49);
        if (!own || own === "off") return null;
        const parts = partsOf(m49);
        if (pies && parts) {
          const total = parts.reduce((t, v) => t + v, 0) || 1;
          let at = 0;
          return `conic-gradient(${parts.map((v, i) => `${pies.parts[i].color} ${(at / total) * 360}deg ${((at += v) / total) * 360}deg`).join(", ")})`;
        }
        return css(bySign ? signColor(spec.value(m49), theme.storageRise, theme.storageFall) : own);
      });
      countries.forEach((m49, i) => {
        const v = values[i];
        const center = centerOf.get(m49);
        const own = p.color(m49);
        if (!center || !(v > 0) || !own || own === "off") return;
        const c = bySign ? signColor(spec.value(m49), theme.storageRise, theme.storageFall) : own;
        if (pies) {
          symbols.push({ id: `${m49}`, position: center, radius: size.radius(v), fill: [c[0], c[1], c[2], 200], line: [255, 255, 255, 220], ...pieOf(partsOf(m49)!, pies.parts) });
        } else if (slot === "circles") {
          // (An amount's in white, as before; others in a darker shade, as their colours can be pale.)
          const line: Color = spec.style.kind === "circles" ? [255, 255, 255, 220] : [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6, 230];
          symbols.push({ id: `${m49}`, position: center, radius: size.radius(v), fill: [c[0], c[1], c[2], 170], line });
        } else bars.push({ position: center, height: size.height(v), color: [c[0], c[1], c[2], 255] });
      });
      // The key of their sizes, in their colours, in place of a ramp (classes keep theirs, and grey sizes).
      const colorAt = (v: number) => (bySign ? signColor(v, theme.storageRise, theme.storageFall) : p.colorOf?.(v)) ?? null;
      const tint = (c: Color | null) => (c ? css(c, slot === "circles" ? 0.7 : 1) : css(theme.border, 0.6));
      sizes.set(slot, sizeKey(slot, size, (v) => tint(pies ? null : colorAt(v)), signed(spec)));
      if (p.colorOf && !pies) keys.set(slot, null);
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
    map.setSymbols("country", symbols.length ? { key: `${key}:${symbols.length}`, items: symbols } : null);
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
    showMapTooltip();
  }

  /** A map's note, for the shape it's drawn in. */
  function noteOf(spec: MapSpec, slot: Shape) {
    const note = spec.note ?? "";
    if (spec.style.kind === "circles" || spec.style.kind === "pies") return slot === "bars" ? note.replace("Circle area", "Bar height") : note;
    return slot === "fill" ? note : [note, SHAPE_NOTES[slot]].filter(Boolean).join(" · ");
  }

  /**
   * A map's colour per country (null: no value; "off": its class is switched off in the
   * legend, or it's outside the picked row's countries), and the key to its colours.
   * `present`: with a row picked, collects the classes its countries fall in (the others
   * show as absent in the legend).
   */
  /** A map's values, one per country (as `countries` are), kept for the context: the maps are painted again at every hover. */
  const valuesOf = new WeakMap<Ctx, Map<string, number[]>>();
  function specValues(ctx: Ctx, spec: MapSpec): number[] {
    let byMap = valuesOf.get(ctx);
    if (!byMap) valuesOf.set(ctx, (byMap = new Map()));
    let values = byMap.get(spec.id);
    if (!values) byMap.set(spec.id, (values = countries.map((m49) => spec.value(m49))));
    return values;
  }
  const countryIndex = new Map(countries.map((m49, i) => [m49, i]));

  function paint(spec: MapSpec, present: Set<number> | null, outside: (m49: number) => boolean) {
    const style = spec.style;
    const ctx = current!.ctx;
    const off = state.hiddenClasses.get(spec.id) ?? new Set<number>();
    // The selected country keeps its colour, even in a class switched off.
    const hides = (m49: number, index: number) => off.has(index) && m49 !== ctx.country?.m49;
    const classState = (i: number) => (present && !present.has(i) ? "absent" : off.has(i) ? "off" : "on");
    let color: (m49: number) => Color | null | "off";
    let key: LegendKey | null = null;
    // A value's colour (not for classes: their key stays, a menu of which are shown).
    let colorOf: ((v: number) => Color | null) | null = null;
    if (style.kind === "ramp") {
      const values = specValues(ctx, spec);
      const valueOf = (m49: number) => {
        const i = countryIndex.get(m49);
        return i === undefined ? spec.value(m49) : values[i];
      };
      let scale = rampScale(style, values, style.domain, state.stretch);
      // Locked, the colours keep their range (a fixed one stays anyway).
      const domain = style.domain || !scale.ticks.length ? scale.domain : legend.hold(`${spec.title}:${spec.unit}`, scale.domain);
      if (domain !== scale.domain) scale = rampScale(style, values, domain);
      color = (m49) => scale.color(valueOf(m49));
      colorOf = (v) => scale.color(v);
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
    } else if (style.kind === "pies") {
      // (Their first part's colour stands for them; the key lists the parts, which switch on and off.)
      const c = hexToColor(style.parts[0].color);
      color = (m49) => (Number.isFinite(spec.value(m49)) ? c : null);
      key = { kind: "classes", items: style.parts.map((k, i) => ({ label: k.label, background: k.color, state: off.has(i) ? "off" : "on" })) };
    } else {
      const c = hexToColor(style.color);
      color = () => c;
      colorOf = () => c;
    }
    // The classes' states are only known once every country's colour is: work them all out now.
    const colors = new Map(countries.map((m49) => [m49, outside(m49) ? ("off" as const) : color(m49)]));
    if (key?.kind === "classes" && style.kind !== "pies") key.items.forEach((item, i) => (item.state = classState(i)));
    return { color: (m49: number) => colors.get(m49) ?? null, key, colorOf };
  }

  /**
   * The country under the pointer: a row per map with a value there (none: no tooltip),
   * in its colour.
   */
  function showMapTooltip() {
    const m49 = state.mapHover;
    if (m49 === null || !current) return;
    const rows = current.layers.flatMap(({ spec, slot }): MapTipRow[] => {
      const v = spec.value(m49);
      const color = tipColors.get(slot)?.(m49) ?? null;
      const style = spec.style;
      if (style.kind === "categories") {
        const cat = style.category(m49);
        if (!cat) return [];
        const share = `${Math.round(cat.share * 100)}%`;
        return [{ color, value: style.categories[cat.index].label, unit: style.of ? `${share} ${style.of}` : "", label: spec.title }];
      }
      if (!Number.isFinite(v)) return [];
      return [{ color, value: fmt(v), unit: spec.unit, label: spec.title }];
    });
    const region = regions.find((r) => r.code === regionOf.get(m49));
    showMapTip(tooltip, { title: names.get(m49) ?? String(m49), source: [region?.name, shownPeriod(current.ctx)].filter(Boolean).join(" · "), rows });
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
    downloadCsv(`${id}_${current.ctx.selected?.code ?? "world"}_${current.ctx.period.from}-${current.ctx.period.to}.csv`, rows);
  }

  new ResizeObserver(() => {
    if (state.view === "country") render();
  }).observe(cardsEl);

  return {
    lockLegend: () => legend.lock(),
    unlockLegend: () => legend.unlock(),
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
      if (m49 === null) showMapTip(tooltip, null);
      else showMapTooltip();
    },
    showArea: (area) => flyToArea(area),
  };
}


/** A pie's cuts (where its first three slices end, 0–1) and its four slices' colours, for the circles layer. */
function pieOf(amounts: number[], parts: { color: string }[]) {
  const total = amounts.reduce((s, v) => s + v, 0) || 1;
  const cuts: number[] = [];
  let at = 0;
  for (let i = 0; i < 3; i++) cuts.push((at += (amounts[i] ?? 0) / total));
  const colors = [0, 1, 2, 3].flatMap((i) => {
    const [r, g, b] = hexToColor(parts[Math.min(i, parts.length - 1)].color);
    return [r, g, b, 225];
  });
  return { pie: cuts, pieColors: colors };
}
