/*
 * Basin view: the statistics in the water balance panel, after the Country panel
 * (country/country-panel.ts): the topics' number tiles and chart cards
 * (stats-cards.ts), all in one column, about the selected major basin or, with none
 * selected, the World. All over the top bar's date range, compared with the same days in the other
 * years of the record.
 *
 * Every tile and card has a map: hovering previews it, clicking pins it
 * (map-drivers.ts); unpinned, the map shows the one picked in the legend, else the
 * first tile. Unless a sub-basin is selected and the water balance model is
 * shown (water-balance.ts, MODEL_SHOWN): then it shows the model's, which this hands
 * the map back to. Within a card, hovering a row picks out its basins on the map (a
 * group's, a basin, a sub-basin outlined), hovering a series in a legend maps that
 * series, and clicking a year on a chart of the same days every year selects that year.
 * Hovering a basin on the map shows its value.
 *
 * The legend's title is a menu of all the maps. Its unit is a menu too, as the WaPOR
 * legend's: per day, month or year, or in total over the period; per m² or over the
 * basin. The map and the charts follow it (the model's discharge and storage change keep
 * theirs, m³/s). And the ramp is a menu of how much of the basins' values the colours
 * span (panels/ramp-menu.ts).
 */
import type { WaterMap } from "../map/map";
import { flyTo, type Extent } from "../map/fly-to";
import type { Place } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import { mixColor, type Color } from "../map/theme";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import { SLOT_HINTS, initLayerLegend, onePerSlot, toggled, type LegendKey, type LegendLayer } from "../panels/legend";
import { DEFAULT_STRETCH } from "../panels/ramp-menu";
import type { Selection } from "../selection";
import type { MajorBasin } from "../toolbar/place-picker";
import { WAPOR_MIN_YEAR, fmtEnd, fmtStart, mk } from "../toolbar/dekads";
import { basinLastDekad, type DekadRange, type View } from "../toolbar/range-rules";
import { inGroup, setBasinGroups, type BasinGroups } from "./groups";
import { loadMajorFluxes, loadSubBasinFluxes, type FluxSeries } from "./model";
import { MODEL_SHOWN } from "./water-balance";
import { SCHEME_SLOT, initSchemeMap } from "./scheme-map";
import {
  BASIN_UNITS,
  TOPICS,
  basinUnit,
  describeBasinUnits,
  parseArea,
  sameDays,
  tileMap,
  tileValue,
  windowLabel,
  type BasinCtx,
  type BasinMapSpec,
  type BasinTile,
  type BasinUnits,
  type FluxStatus,
  type TopicDef,
} from "./stats-cards";
import { loadSeries, monthlyStats, periodStats, windowRates, type Monthly, type PeriodStats, type WaporSeries, type WindowRates } from "./stats-data";
import { fmt, rampScale, type ColorScale } from "./variables";

interface Options {
  map: WaterMap;
  majorBasins: MajorBasin[];
  subBasins: SubBasin[];
  /** The major basins' groups (by climate, by where the water goes). */
  groups: BasinGroups;
  /** The water balance panel: it shows the model's map unless a chart takes over. */
  setMapOverride(override: boolean): void;
  /** Select a range in the top bar (from clicking a year on a chart). */
  setRange(range: DekadRange): void;
}

export interface BasinStats {
  setView(view: View): void;
  setRange(range: DekadRange): void;
  setSelection(selection: Selection): void;
  /** What is under the pointer on the map (null: nothing). */
  hover(place: Place | null): void;
}

/** How the maps are drawn, in the legend's order: fills, the scheme's discharge lines, its storage change dots. */
const SLOTS = ["fill", "lines", "dots"];

/** A map on the map: its tile or card, and how it's drawn (the legend's slot). */
interface Layer {
  d: Driver;
  spec: BasinMapSpec;
  slot: string;
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; series: WaporSeries };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The first dekad of the WaPOR record. */
const FIRST_DK = mk(WAPOR_MIN_YEAR, 0, 0);

export function initBasinStats({ map, majorBasins, subBasins, groups, setMapOverride, setRange }: Options): BasinStats {
  setBasinGroups(groups);
  const majorNames = new Map(majorBasins.map((b) => [b.id, b.name]));
  const subNames = new Map(subBasins.map((b) => [b.id, b.name]));
  const majorIds = majorBasins.map((b) => b.id);
  const majorBoxes = new Map(majorBasins.map((b) => [b.id, b.bbox]));
  const subBoxes = new Map(subBasins.map((b) => [b.id, b.bbox]));
  const state = {
    view: "country" as View,
    range: null as DekadRange | null,
    selection: null as Selection | null,
    /** The WaPOR series, loaded once: every range is summed from them. */
    status: { kind: "idle" } as Status,
    /** Pins and the legend's picks, per scope ("world", "major"). */
    pinned: new Map<string, Driver>(),
    /** The maps checked in the legend, oldest first (none: the first tile's). */
    chosen: new Map<string, string[]>(),
    hover: null as Place | null,
    /** The model's output: "majors" (per major basin) or a major basin's id (its sub-basins). */
    fluxes: new Map<string, FluxStatus>(),
    /** Totals in mm by default, as before there was a choice. */
    units: BASIN_UNITS[3] as BasinUnits,
    /** How much of the basins' values the colours span (% cut at either end). */
    stretch: DEFAULT_STRETCH,
  };
  const section = $("bs-section");
  const cardsEl = $("bs-cards");
  const tilesEl = $("bs-stats");
  const tooltip = $("bs-tooltip");
  let current: { ctx: BasinCtx; layers: Layer[]; csv: Map<string, (string | number)[][]> } | null = null;

  // The legend's title: a checklist of all the maps, each once, in the order of the tiles
  // and cards; each one on the map has a section (panels/legend.ts). Checking one unpins
  // the chart that was pinned (its map stays checked).
  const legend = initLayerLegend($("bs-legend"), {
    slots: SLOTS,
    options() {
      if (!current) return { options: [], current: [] };
      const ctx = current.ctx;
      const options = menuMaps(ctx).map(({ id, spec }) => ({ id, label: spec.title, hint: SLOT_HINTS[slotOf(spec, ctx)] }));
      return { options, current: current.layers.map((l) => optionId(ctx, l.spec)) };
    },
    onToggle(id) {
      if (!current) return;
      const ids = toggled(current.layers.map((l) => optionId(current!.ctx, l.spec)), id);
      state.chosen.set(scope(), ids);
      // With a sub-basin selected the map defaults to the model's, so a pick is a pin.
      if (followsModel() && ids.includes(id)) state.pinned.set(scope(), { id, sub: null });
      else state.pinned.delete(scope());
      drivers.clearPreview();
      drawMap();
      markAll();
    },
    // How much of the basins' values the colours span: a menu on the ramp.
    ramp: {
      of: "the basins' values",
      initial: state.stretch,
      onPick(cut) {
        state.stretch = cut;
        drawMap();
      },
    },
    // The unit (not for maps in % or m³/s).
    units: {
      options: () => ({ options: BASIN_UNITS.map((u, i) => ({ id: String(i), label: basinUnit(u) })), current: String(BASIN_UNITS.indexOf(state.units)) }),
      onPick(id) {
        const picked = BASIN_UNITS[Number(id)];
        if (picked === state.units) return;
        state.units = picked;
        render();
      },
      title: () => `Values ${describeBasinUnits(state.units)}.`,
    },
  });
  // Discharge and storage change maps of a basin's sub-basins: as the water balance scheme
  // (a network of lines, dots), or (each one's switch in the legend) as fills. Switched,
  // the map takes its new slot from the one there.
  const schemeMap = initSchemeMap({
    map,
    subBasins,
    legend,
    onChange(kind) {
      const ctx = current?.ctx;
      const ids = state.chosen.get(scope());
      const moved = ctx && kind && ids?.find((id) => specFor(ctx, { id, sub: null }).scheme === kind);
      if (moved) state.chosen.set(scope(), [...ids!.filter((id) => id !== moved), moved]);
      drawMap();
    },
    onHover: () => showMapTooltip(),
  });

  // All the topics' tiles and cards together, in one column.
  const allTopics: TopicDef = {
    id: "all",
    label: "All",
    tiles: TOPICS.flatMap((t) => t.tiles),
    cards: TOPICS.flatMap((t) => t.cards),
    about: TOPICS.map((t) => t.about).join(" "),
  };
  const topicDef = (): TopicDef => allTopics;
  const scope = () => (state.selection?.majorBasin ? "major" : "world");

  const drivers = initDrivers(section, {
    enabled: () => state.view === "basin",
    pinned: () => state.pinned.get(scope()) ?? null,
    setPinned(d) {
      if (d) state.pinned.set(scope(), d);
      else state.pinned.delete(scope());
      if (d) flyToRow(d.sub);
    },
    onChange() {
      drawMap();
      markAll();
    },
    // A year on a chart of the same days every year: the index of its range.
    onX(w) {
      const r = current?.ctx.windows.ranges[w];
      if (r) setRange(r);
    },
    onCsv: download,
    tooltip,
  });

  /** All the maps, each once (several charts can share one), in the order of the tiles and cards. */
  function menuMaps(ctx: BasinCtx): { id: string; spec: BasinMapSpec }[] {
    const topic = topicDef();
    const seen = new Set<string>();
    return [
      ...topic.tiles.map((t) => ({ id: t.id, spec: tileMap(ctx, t) })),
      ...topic.cards.map((c) => ({ id: c.id, spec: c.map(ctx, null) })),
    ].filter(({ spec }) => !seen.has(spec.title) && !!seen.add(spec.title));
  }
  /** The checklist's option for a map (by its title, as charts share maps). */
  const optionId = (ctx: BasinCtx, spec: BasinMapSpec) => menuMaps(ctx).find((m) => m.spec.title === spec.title)?.id ?? spec.id;

  /** How a map is drawn: as the scheme's lines or dots, or as fills. */
  function slotOf(spec: BasinMapSpec, ctx: BasinCtx): string {
    return spec.scheme && schemeMap.isScheme(spec.scheme, ctx.major?.id ?? null) ? SCHEME_SLOT[spec.scheme] : "fill";
  }

  // The map tooltip follows the pointer (to its right).
  const mapEl = map.map.getContainer();
  mapEl.addEventListener("pointermove", (e) => {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  mapEl.addEventListener("pointerleave", () => (tooltip.hidden = true));

  // --- Loading -------------------------------------------------------------------------------
  function load() {
    if (state.view !== "basin" || state.status.kind !== "idle") return;
    state.status = { kind: "loading" };
    loadSeries().then(
      (series) => {
        state.status = { kind: "ready", series };
        render();
      },
      (err: Error) => {
        state.status = { kind: "error", message: err.message };
        render();
      },
    );
  }

  /** The last result, kept while its key stays the same (draw also runs on loads, selections, resizes). */
  function memo<T>() {
    let last: { key: string; value: T } | null = null;
    return (key: string, compute: () => T) => (last?.key === key ? last.value : (last = { key, value: compute() }).value);
  }
  const periodFor = memo<PeriodStats>();
  const ratesFor = memo<WindowRates | null>();
  const monthlyFor = memo<Monthly>();

  /**
   * The model's output for `key` (see state.fluxes), loading it the first time it's asked
   * for. A failed load is tried again after the selection or view changes.
   */
  function fluxes(key: string, load: () => Promise<FluxSeries>): FluxStatus {
    let status = state.fluxes.get(key);
    if (!status) {
      state.fluxes.set(key, (status = { kind: "loading" }));
      load().then(
        (result) => state.fluxes.set(key, { kind: "ready", result }),
        (err: Error) => state.fluxes.set(key, { kind: "error", message: err.message }),
      ).then(render);
    }
    return status;
  }

  function forgetFailedFluxes() {
    for (const [key, status] of state.fluxes) if (status.kind === "error") state.fluxes.delete(key);
  }

  // --- Rendering -------------------------------------------------------------------------------
  let frame = 0;
  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  function draw() {
    const shown = state.view === "basin";
    section.hidden = !shown;
    const message = $("bs-message");
    if (!shown) return clear();

    const status = state.status;
    const major = state.selection?.majorBasin ?? null;
    $("bs-heading").textContent = major ? `${majorNames.get(major.id) ?? major.name}: basin statistics` : "Basins of the world";
    const range = state.range;
    const stats = status.kind === "ready" && range ? periodFor(`${range.start}-${range.end}`, () => periodStats(status.series, range)) : null;
    if (!stats?.covered) {
      message.hidden = false;
      message.classList.toggle("error", status.kind === "error");
      message.textContent =
        status.kind === "error"
          ? status.message
          : status.kind === "ready"
            ? "There are no WaPOR data for the selected period (they run from 2018 to the end of 2025)."
            : "Loading basin statistics…";
      tilesEl.innerHTML = "";
      cardsEl.innerHTML = "";
      return clear();
    }

    const covered = stats.covered;
    const topic = topicDef();
    const windows = sameDays(covered, FIRST_DK, basinLastDekad());
    // PCP and AETI in the other years, and per month.
    const { series } = status as { series: WaporSeries };
    const rates = ratesFor(windows.ranges.map((r) => `${r.start}-${r.end}`).join(","), () =>
      windows.ranges.length < 2 ? null : windowRates(series, windows.ranges),
    );
    const monthly = topic.cards.some((c) => c.id === "monthly")
      ? monthlyFor(`${covered.start}-${covered.end}:${major?.id ?? "all"}`, () => monthlyStats(series, covered, major?.id ?? null))
      : null;
    // The model's output.
    const majorFlux: FluxStatus = fluxes("majors", loadMajorFluxes);
    const subFlux: FluxStatus | null = major ? fluxes(String(major.id), () => loadSubBasinFluxes(major.id)) : null;

    const ctx: BasinCtx = {
      period: `${fmtStart(covered.start)} – ${fmtEnd(covered.end)}`,
      covered,
      days: stats.days,
      stats,
      windows,
      rates,
      ratesError: null,
      flux: { majors: majorFlux, sub: subFlux },
      monthly,
      major: major && { id: major.id, name: majorNames.get(major.id) ?? major.name },
      majors: majorIds,
      majorName: (id) => majorNames.get(id) ?? String(id),
      subName: (id) => subNames.get(id) ?? String(id),
      width: Math.max(240, cardsEl.clientWidth - 22),
      units: state.units,
      cache: new Map(),
    };
    const partly = state.range && (covered.start !== state.range.start || covered.end !== state.range.end);
    message.hidden = !partly;
    message.classList.remove("error");
    message.textContent = partly ? `WaPOR data cover only ${ctx.period} of the selected range.` : "";

    tilesEl.innerHTML = topic.tiles.map((t) => tileHtml(t, ctx)).join("");
    const csv = new Map<string, (string | number)[][]>();
    const otherYears = windows.ranges.filter((_, w) => w !== windows.current).map(windowLabel);
    cardsEl.innerHTML = topic.cards
      .map((card) => {
        const out = card.render(ctx);
        csv.set(card.id, out.csv);
        return `<section class="cp-card" data-driver="${card.id}" tabindex="0" aria-label="${esc(card.title(ctx))}">` +
          `<h3><span>${esc(card.title(ctx))}</span><span class="cp-card-actions">` +
          (out.csv.length > 1 ? `<button class="wb-csv" data-csv="${card.id}">CSV</button>` : "") +
          `<button class="cp-unpin" data-unpin title="Remove pin" aria-label="Remove pin">×</button>` +
          `</span></h3><p>${esc(card.caption(ctx))}</p>${out.html}</section>`;
      })
      .join("") +
      `<p class="wb-about">${esc(topic.about)} ` +
      (otherYears.length ? `Other years: the same days in ${otherYears.join(", ")}.` : "") + `</p>`;
    current = { ctx, layers: [], csv };
    markAll();
    drawMap();
  }

  function tileHtml(t: BasinTile, ctx: BasinCtx) {
    const { value, unit, change, changeUnit } = tileValue(ctx, t);
    const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
    const vs = Number.isFinite(change) ? `${sign}${fmt(Math.abs(change))}${changeUnit === "%" ? "%" : ` ${changeUnit}`}` : "";
    return `<button data-driver="${t.id}" style="--var-color:${t.color}" title="Show on the map${vs ? ` (${vs} against the other years' average)` : ""}">` +
      `<span class="wb-stat-label">${esc(t.label)}</span>` +
      `<span class="wb-stat-value">${fmt(value)}</span>` +
      `<span class="wb-stat-unit">${esc(unit)}${vs ? ` · ${esc(vs)}` : ""}</span></button>`;
  }

  /**
   * Pinning a row of a group, a major basin or a sub-basin flies there, keeping the
   * selected basin in view where both fit (see flyTo). Not for the World.
   */
  function flyToRow(sub: string | null) {
    const area = parseArea(sub);
    if (!area || area.kind === "world") return;
    const box = (boxes: Map<number, Extent["box"]>, id: number): Extent[] => (boxes.has(id) ? [{ box: boxes.get(id)! }] : []);
    const own =
      area.kind === "sub" ? box(subBoxes, area.id)
      : area.kind === "major" ? box(majorBoxes, area.id)
      : majorIds.filter((id) => inGroup(id, area.id)).flatMap((id) => box(majorBoxes, id));
    const sel = state.selection?.majorBasin?.id;
    // A sub-basin is one of the selected basin's: fly to it alone.
    const inOwn = area.kind === "sub" || (sel !== undefined && (area.kind === "group" ? inGroup(sel, area.id) : sel === area.id));
    flyTo(map, own, sel === undefined || inOwn ? null : box(majorBoxes, sel)[0] ?? null);
  }

  function clear() {
    current = null;
    legend.show(null);
    tooltip.hidden = true;
    map.setBasinStatFills(null);
    schemeMap.showSwitches([], null);
    schemeMap.draw(null, []);
    setMapOverride(false);
  }

  /** Whether the map defaults to the water balance model's. */
  function followsModel() {
    return MODEL_SHOWN && !!state.selection?.subBasin;
  }

  const isDriver = (d: Driver | null | undefined): d is Driver =>
    !!d && (topicDef().tiles.some((t) => t.id === d.id) || topicDef().cards.some((c) => c.id === d.id));

  /** The previewed or pinned tile or card. */
  function leadDriver(): Driver | null {
    const d = drivers.preview() ?? state.pinned.get(scope()) ?? null;
    return isDriver(d) ? d : null;
  }

  /** The tile or card the map follows: previewed, pinned, or the first map on it. */
  function activeDriver(): Driver | null {
    return leadDriver() ?? (current ? shownLayers(current.ctx)[0]?.d ?? null : null);
  }

  /**
   * The maps on the map: those checked in the legend (else the first tile's), with the
   * previewed or pinned one in its slot. None while the map is the model's.
   */
  function shownLayers(ctx: BasinCtx): Layer[] {
    const lead = leadDriver();
    if (!lead && followsModel()) return [];
    const chosen = (state.chosen.get(scope()) ?? []).filter((id) => isDriver({ id, sub: null }));
    const layers = (chosen.length ? chosen : [topicDef().tiles[0].id]).map((id) => layerOf(ctx, { id, sub: null }));
    if (!lead) return onePerSlot(layers, SLOTS);
    const l = layerOf(ctx, lead);
    return onePerSlot([...layers.filter((m) => m.spec.title !== l.spec.title), l], SLOTS);
  }

  function layerOf(ctx: BasinCtx, d: Driver): Layer {
    const spec = specFor(ctx, d);
    return { d, spec, slot: slotOf(spec, ctx) };
  }

  function specFor(ctx: BasinCtx, d: Driver): BasinMapSpec {
    const topic = topicDef();
    const tile = topic.tiles.find((t) => t.id === d.id);
    if (tile) return tileMap(ctx, tile);
    return (topic.cards.find((c) => c.id === d.id) ?? topic.cards[0]).map(ctx, d.sub);
  }

  function markAll() {
    markDrivers(section, activeDriver(), drivers.preview(), state.pinned.get(scope()) ?? null);
  }

  function drawMap() {
    if (!current) return;
    const { ctx } = current;
    const layers = shownLayers(ctx);
    current.layers = layers;
    if (!layers.length) {
      legend.show(null);
      map.setBasinStatFills(null);
      schemeMap.showSwitches([], null);
      schemeMap.draw(null, []);
      setMapOverride(false);
      return;
    }
    const major = ctx.major?.id ?? null;
    const theme = map.theme;
    const fill = layers.find((l) => l.slot === "fill")?.spec;
    // The others as the water balance scheme: lines or dots, sized rather than coloured.
    const sized = layers.filter((l) => l.slot !== "fill");
    const keys = schemeMap.draw(
      major,
      sized.filter((l) => !l.spec.status).map((l) => ({ kind: l.spec.scheme!, value: l.spec.value, key: `${l.spec.id}:${ctx.period}` })),
    );
    schemeMap.showSwitches(layers.filter((l) => l.spec.scheme).map((l) => ({ kind: l.spec.scheme!, slot: l.slot })), major);

    // The area under the pointer in a chart (or the one the card is pinned on): a group
    // or a major basin keeps its colours and fades the rest; a sub-basin is outlined.
    const sub = leadDriver()?.sub ?? null;
    const picked = parseArea(sub);
    const colors = new Map<number, Color>();
    let scale: ColorScale | null = null;
    if (fill) {
      const ids = fill.level === "major" ? ctx.majors : [...(fill.only ?? ctx.stats.sub.keys())];
      const values = ids.map((id) => fill.value(id));
      scale = rampScale(fill, values, undefined, state.stretch);
      const majorOf = (id: number) => (fill.level === "major" ? id : ctx.stats.sub.get(id)?.majorBasin ?? NaN);
      const shown = (id: number) => {
        if (picked?.kind === "major") return majorOf(id) === picked.id;
        if (picked?.kind === "group") return inGroup(majorOf(id), picked.id);
        return !fill.listed || fill.listed.has(id);
      };
      ids.forEach((id, i) => {
        const c = scale!.color(values[i]) ?? (fill.level === "major" ? theme.noData : null);
        if (c) colors.set(id, shown(id) ? c : mixColor(c, theme.land, 0.78));
      });
    } else {
      // Plain land under the scheme; the other major basins greyed.
      for (const id of ctx.majors) colors.set(id, id === major ? theme.land : theme.noData);
    }
    const outlined = picked?.kind === "sub" ? [picked.id] : [];
    map.setBasinStatFills({
      level: fill?.level ?? "major",
      key: `${fill?.id ?? ""}:${sized.map((l) => l.spec.id).join()}:${state.stretch}:${fill?.status ? "" : ctx.period}:${sub ?? ""}:${outlined.join()}`,
      colors,
      outlined,
    });
    setMapOverride(true);

    // Without values (the model's output, still loading), no key: only the status.
    legend.show(
      layers.map(({ spec, slot }): LegendLayer => {
        const common = { slot, id: optionId(ctx, spec), title: spec.title, unit: spec.unit, units: spec.units };
        if (slot === "fill") {
          const key: LegendKey | null = scale?.ticks.length ? { kind: "ramp", gradient: scale.gradient, ticks: scale.ticks } : null;
          const note = `${spec.note}${spec.scale === "log" ? " · Log scale" : ""}`;
          return { ...common, note, period: key ? ctx.period : "", key, status: spec.status };
        }
        // The scheme has a key of sizes instead.
        const drawn = keys.get(spec.scheme!);
        const status = spec.status || drawn?.status || "";
        const key = status ? null : drawn?.key ?? null;
        const note = spec.note.replace(/per sub-basin$/, spec.scheme === "Q" ? "along the rivers" : "per sub-basin, on its river");
        return { ...common, note, period: key ? ctx.period : "", key, status };
      }),
    );
    showMapTooltip();
  }

  function showMapTooltip() {
    const layers = current?.layers ?? [];
    const item = schemeMap.hovered();
    const sized = item && layers.find((l) => l.slot !== "fill" && l.spec.scheme === item.kind);
    if (item && sized && Number.isFinite(item.value)) {
      const name = subNames.get(item.subBasin) ?? String(item.subBasin);
      const what = item.kind === "Q" ? `${sized.spec.title} in the river` : sized.spec.title;
      tooltip.innerHTML = `<b>${esc(name)}</b><br>${esc(what)}: ${fmt(item.value)} ${esc(sized.spec.unit)}`;
      tooltip.hidden = false;
      return;
    }
    const place = state.hover;
    if (!place) return void (tooltip.hidden = true);
    // Each map's value there, under the basin's name.
    let name = "";
    const rows = layers.flatMap(({ spec }) => {
      const target = spec.level === "major" ? place.majorBasin : place.subBasin;
      if (!target || (spec.only && !spec.only.has(target.id))) return [];
      name ||= (spec.level === "major" ? majorNames : subNames).get(target.id) ?? target.name;
      return [`${esc(spec.title)}: ${fmt(spec.value(target.id))} ${esc(spec.unit)}`];
    });
    if (!rows.length) return void (tooltip.hidden = true);
    tooltip.innerHTML = `<b>${esc(name)}</b><br>${rows.join("<br>")}`;
    tooltip.hidden = false;
  }

  function download(id: string) {
    const rows = current?.csv.get(id);
    if (!rows || !current) return;
    const csvText = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csvText], { type: "text/csv" }));
    a.download = `${id}_${current.ctx.major?.id ?? "world"}_${current.ctx.period.replace(/ /g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  new ResizeObserver(() => {
    if (state.view === "basin") render();
  }).observe(cardsEl);

  return {
    setView(view) {
      state.view = view;
      forgetFailedFluxes();
      load();
      render();
    },
    setRange(range) {
      state.range = range;
      render();
    },
    setSelection(selection) {
      const majorBefore = state.selection?.majorBasin?.id;
      state.selection = selection;
      forgetFailedFluxes();
      if (selection.majorBasin?.id !== majorBefore) drivers.clearPreview();
      render();
    },
    hover(place) {
      state.hover = place;
      if (state.view === "basin") showMapTooltip();
    },
  };
}

const csvCell = (v: string | number) =>
  typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
