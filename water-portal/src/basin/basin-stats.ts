/*
 * Basin view: the statistics in the water balance panel, after the Country panel
 * (country/country-panel.ts): one tab per topic (stats-cards.ts), each with number
 * tiles and chart cards, about the selected major basin or, with none selected, the
 * World. All over the top bar's date range, compared with the same days in the other
 * years of the record.
 *
 * Every tile and card has a map: hovering previews it, clicking pins it
 * (map-drivers.ts); unpinned, the map shows the one picked in the legend, else the
 * topic's first tile. Unless a sub-basin is selected and the water balance model is
 * shown (water-balance.ts, MODEL_SHOWN): then it shows the model's, which this hands
 * the map back to. Within a card, hovering a row picks out its basins on the map (a
 * group's, a basin, a sub-basin outlined), hovering a series in a legend maps that
 * series, and clicking a year on a chart of the same days every year selects that year.
 * Hovering a basin on the map shows its value.
 *
 * The legend's title is a menu of the topic's maps. Its unit is a menu too, as the WaPOR
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
import { DEFAULT_STRETCH, fmtStop, initRampMenu } from "../panels/ramp-menu";
import { slideSelection } from "../panels/segmented";
import { initTitleMenu, type MenuOption } from "../panels/title-menu";
import type { Selection } from "../selection";
import type { MajorBasin } from "../toolbar/place-picker";
import { WAPOR_MIN_YEAR, fmtEnd, fmtStart, mk } from "../toolbar/dekads";
import { basinLastDekad, type DekadRange, type View } from "../toolbar/range-rules";
import { inGroup, setBasinGroups, type BasinGroups } from "./groups";
import { loadMajorFluxes, loadSubBasinFluxes, type FluxSeries } from "./model";
import { MODEL_SHOWN } from "./water-balance";
import { initRiverMap } from "./river-map";
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
  type SameDays,
  type TopicDef,
} from "./stats-cards";
import { loadMonthly, loadPeriod, loadWindows, type Monthly, type PeriodStats, type WindowRates } from "./stats-data";
import { fmt, rampScale } from "./variables";

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

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; stats: PeriodStats };
type RatesStatus = { key: string; rates: WindowRates | null; error: string | null };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LOAD_DELAY = 400; // ms: wait for the range to rest (dragging the slider passes many)
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
    topic: TOPICS[0].id,
    status: { kind: "idle" } as Status,
    rates: { key: "", rates: null, error: null } as RatesStatus,
    monthly: null as Monthly | null,
    monthlyKey: "",
    /** Pins and the legend's picks, per topic and scope ("rain:world", "rain:major"). */
    pinned: new Map<string, Driver>(),
    chosen: new Map<string, Driver>(),
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
  const legend = $("bs-legend");
  const tooltip = $("bs-tooltip");
  let current: { ctx: BasinCtx; spec: BasinMapSpec | null; csv: Map<string, (string | number)[][]> } | null = null;
  // Discharge maps of a basin's sub-basins: along its rivers, or (the legend's switch) as fills.
  const riverMap = initRiverMap({ map, subBasins, legend, ramp: $("bs-legend-ramp"), onChange: () => drawMap(), onHover: () => showMapTooltip() });

  const topicDef = (): TopicDef => TOPICS.find((t) => t.id === state.topic)!;
  const scope = () => `${state.topic}:${state.selection?.majorBasin ? "major" : "world"}`;

  // --- Topic tabs ------------------------------------------------------------------------
  const topicsEl = $("bs-topics");
  topicsEl.innerHTML = TOPICS.map((t) => `<button role="tab" data-topic="${t.id}">${t.label}</button>`).join("");
  slideSelection(topicsEl);
  topicsEl.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-topic]");
    if (!button) return;
    state.topic = button.dataset.topic!;
    drivers.clearPreview();
    render();
  });

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

  // The legend's title: the topic's maps, each once, in the order of the tiles and cards.
  const variable = initTitleMenu(
    $("bs-variable") as HTMLButtonElement,
    () => {
      if (!current) return { options: [], current: null };
      const ctx = current.ctx;
      const topic = topicDef();
      const options: MenuOption[] = [];
      const seen = new Set<string>();
      for (const [id, spec] of [
        ...topic.tiles.map((t) => [t.id, tileMap(ctx, t)] as const),
        ...topic.cards.map((c) => [c.id, c.map(ctx, null)] as const),
      ]) {
        if (seen.has(spec.title)) continue;
        seen.add(spec.title);
        options.push({ id, label: spec.title });
      }
      return { options, current: options.find((o) => o.label === current!.spec?.title)?.id ?? null };
    },
    (id) => {
      const d = { id, sub: null };
      // With a sub-basin selected the map defaults to the model's, so the pick is a pin.
      if (followsModel()) state.pinned.set(scope(), d);
      else {
        state.chosen.set(scope(), d);
        state.pinned.delete(scope());
      }
      drivers.clearPreview();
      drawMap();
      markAll();
    },
  );

  // The unit, from a menu (not for maps in % or m³/s).
  const unitButton = $("bs-unit") as HTMLButtonElement;
  const unitMenu = initTitleMenu(
    unitButton,
    () => ({
      options: current?.spec?.units ? BASIN_UNITS.map((u, i) => ({ id: String(i), label: basinUnit(u) })) : [],
      current: String(BASIN_UNITS.indexOf(state.units)),
    }),
    (id) => {
      const picked = BASIN_UNITS[Number(id)];
      if (picked === state.units) return;
      state.units = picked;
      render();
    },
  );
  function showUnit(spec: BasinMapSpec) {
    unitMenu.setLabel(spec.unit);
    // Nothing to pick from: plain text.
    unitButton.disabled = !spec.units;
    unitButton.title = spec.units ? `Values ${describeBasinUnits(state.units)}.` : "";
  }

  // How much of the basins' values the colours span: a menu on the ramp.
  initRampMenu($("bs-legend-ramp") as HTMLButtonElement, "the basins' values", state.stretch, (cut) => {
    state.stretch = cut;
    drawMap();
  });

  // The map tooltip follows the pointer (to its right).
  const mapEl = map.map.getContainer();
  mapEl.addEventListener("pointermove", (e) => {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  mapEl.addEventListener("pointerleave", () => (tooltip.hidden = true));

  // --- Loading -------------------------------------------------------------------------------
  let loadTimer = 0;
  let wanted = "";
  function load() {
    const range = state.range;
    if (state.view !== "basin" || !range) return;
    const key = `${range.start}-${range.end}`;
    if (key === wanted) return; // loading or loaded
    clearTimeout(loadTimer);
    wanted = key;
    state.status = { kind: "loading" };
    render();
    loadTimer = window.setTimeout(() => {
      loadPeriod(range).then(
        (stats) => {
          if (wanted !== key) return;
          state.status = { kind: "ready", stats };
          render();
        },
        (err: Error) => {
          if (wanted !== key) return;
          state.status = { kind: "error", message: err.message };
          wanted = "";
          render();
        },
      );
    }, LOAD_DELAY);
  }

  /** PCP and AETI over the other years' ranges (with the period's), once the period is in. */
  function loadRatesFor(windows: SameDays) {
    const key = windows.ranges.map((r) => `${r.start}-${r.end}`).join(",");
    if (key === state.rates.key) return;
    state.rates = { key, rates: null, error: null };
    if (windows.ranges.length < 2) return;
    loadWindows(windows.ranges).then(
      (rates) => {
        if (state.rates.key !== key) return;
        state.rates = { key, rates, error: null };
        render();
      },
      (err: Error) => {
        if (state.rates.key !== key) return;
        // Tried again when the range changes.
        state.rates = { key, rates: null, error: err.message };
        render();
      },
    );
  }

  /** The monthly cycle for the selected major basin (or all basins), once the period is in. */
  function loadMonthlyFor(stats: PeriodStats) {
    const major = state.selection?.majorBasin?.id ?? null;
    const key = stats.covered ? `${stats.covered.start}-${stats.covered.end}:${major}` : "";
    if (key === state.monthlyKey) return;
    state.monthlyKey = key;
    state.monthly = null;
    if (!stats.covered) return;
    loadMonthly(stats.covered, major).then(
      (monthly) => {
        if (state.monthlyKey !== key) return;
        state.monthly = monthly;
        render();
      },
      () => {
        if (state.monthlyKey === key) state.monthly = { months: [], pcp: [], aeti: [] };
        render();
      },
    );
  }

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
    for (const b of topicsEl.querySelectorAll<HTMLElement>("[data-topic]")) {
      b.setAttribute("aria-selected", String(b.dataset.topic === state.topic));
    }

    const status = state.status;
    const major = state.selection?.majorBasin ?? null;
    $("bs-heading").textContent = major ? `${majorNames.get(major.id) ?? major.name}: basin statistics` : "Basins of the world";
    if (status.kind !== "ready" || !status.stats.covered) {
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

    const stats = status.stats;
    const covered = stats.covered!;
    const topic = topicDef();
    if (topic.cards.some((c) => c.id === "monthly")) loadMonthlyFor(stats);
    const windows = sameDays(covered, FIRST_DK, basinLastDekad());
    const windowsKey = windows.ranges.map((r) => `${r.start}-${r.end}`).join(",");
    // PCP and AETI in the other years, for the topics that show them.
    if (topic.id !== "discharge") loadRatesFor(windows);
    const rates = state.rates.key === windowsKey ? state.rates : { rates: null, error: null };
    // The model's output, for the topics that show it.
    const usesFlux = topic.id !== "rain";
    const majorFlux: FluxStatus = usesFlux ? fluxes("majors", loadMajorFluxes) : { kind: "loading" };
    const subFlux: FluxStatus | null = usesFlux && major ? fluxes(String(major.id), () => loadSubBasinFluxes(major.id)) : null;

    const ctx: BasinCtx = {
      period: `${fmtStart(covered.start)} – ${fmtEnd(covered.end)}`,
      covered,
      days: stats.days,
      stats,
      windows,
      rates: rates.rates,
      ratesError: rates.error,
      flux: { majors: majorFlux, sub: subFlux },
      monthly: state.monthly,
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
    current = { ctx, spec: null, csv };
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
    legend.hidden = true;
    tooltip.hidden = true;
    map.setBasinStatFills(null);
    riverMap.draw(null);
    setMapOverride(false);
  }

  /** Whether the map defaults to the water balance model's. */
  function followsModel() {
    return MODEL_SHOWN && !!state.selection?.subBasin;
  }

  const isDriver = (d: Driver | null | undefined): d is Driver =>
    !!d && (topicDef().tiles.some((t) => t.id === d.id) || topicDef().cards.some((c) => c.id === d.id));

  /** The tile or card the map follows: previewed, pinned, picked in the legend, or the first tile. */
  function activeDriver(): Driver | null {
    const d = drivers.preview() ?? state.pinned.get(scope()) ?? null;
    if (isDriver(d)) return d;
    if (followsModel() || !current) return null;
    const chosen = state.chosen.get(scope());
    return isDriver(chosen) ? chosen : { id: topicDef().tiles[0].id, sub: null };
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
    const d = activeDriver();
    if (!d) {
      current.spec = null;
      legend.hidden = true;
      map.setBasinStatFills(null);
      riverMap.draw(null);
      setMapOverride(false);
      return;
    }
    const { ctx } = current;
    const spec = specFor(ctx, d);
    current.spec = spec;

    // The area under the pointer in a chart (or the one the card is pinned on): a group
    // or a major basin keeps its colours and fades the rest; a sub-basin is outlined.
    const picked = parseArea(d.sub);
    const ids = spec.level === "major" ? ctx.majors : [...(spec.only ?? ctx.stats.sub.keys())];
    const theme = map.theme;
    // Or the discharge along the rivers, coloured over the rivers' values.
    const rivers = spec.status ? null : riverMap.prepare(spec.rivers, ctx.major?.id ?? null, spec.value, `${spec.id}:${ctx.period}`);
    const values = rivers ? rivers.values : ids.map((id) => spec.value(id));
    const scale = rampScale(rivers ? { ...spec, ramp: theme.discharge } : spec, values, undefined, state.stretch);
    const majorOf = (id: number) => (spec.level === "major" ? id : ctx.stats.sub.get(id)?.majorBasin ?? NaN);
    const shown = (id: number) => {
      if (picked?.kind === "major") return majorOf(id) === picked.id;
      if (picked?.kind === "group") return inGroup(majorOf(id), picked.id);
      return !spec.listed || spec.listed.has(id);
    };
    const colors = new Map<number, Color>();
    if (rivers) {
      // Plain land under the rivers; the other major basins greyed.
      for (const id of ctx.majors) colors.set(id, id === ctx.major?.id ? theme.land : theme.noData);
    } else {
      ids.forEach((id, i) => {
        const c = scale.color(values[i]) ?? (spec.level === "major" ? theme.noData : null);
        if (c) colors.set(id, shown(id) ? c : mixColor(c, theme.land, 0.78));
      });
    }
    const outlined = picked?.kind === "sub" ? [picked.id] : [];
    const status = rivers?.status || spec.status;
    const period = status ? "" : ctx.period;
    map.setBasinStatFills({
      level: rivers ? "major" : spec.level,
      key: `${spec.id}:${rivers ? "rivers" : ""}:${state.stretch}:${period}:${d.sub ?? ""}:${outlined.join()}`,
      colors,
      outlined,
    });
    riverMap.draw(rivers ? scale : null);
    setMapOverride(true);

    // Legend
    legend.hidden = false;
    variable.setLabel(spec.title);
    const note = rivers ? spec.note.replace(/per sub-basin$/, "along the rivers") : spec.note;
    $("bs-legend-note").textContent = `${note}${spec.scale === "log" ? " · Log scale" : ""}`;
    // Without values (the model's output, still loading), no colour ramp: only the status.
    const empty = !scale.ticks.length;
    $("bs-legend-period").parentElement!.hidden = empty;
    $("bs-legend-ramp").hidden = empty;
    $("bs-legend-ticks").hidden = empty;
    $("bs-legend-status").textContent = status ?? "";
    $("bs-legend-period").textContent = period;
    showUnit(spec);
    $("bs-legend-ramp").style.background = scale.gradient;
    const span = Math.max(...scale.ticks.map((t) => t.value)) - Math.min(...scale.ticks.map((t) => t.value));
    $("bs-legend-ticks").innerHTML = scale.ticks.map((t) => `<span style="left:${t.at * 100}%">${fmtStop(t.value, span)}</span>`).join("");
    showMapTooltip();
  }

  function showMapTooltip() {
    const place = state.hover;
    const spec = current?.spec;
    const river = spec?.rivers ? riverMap.hovered() : null;
    if (spec && river && Number.isFinite(river.q)) {
      const name = subNames.get(river.subBasin) ?? String(river.subBasin);
      tooltip.innerHTML = `<b>${esc(name)}</b><br>${esc(spec.title)} in the river: ${fmt(river.q)} ${esc(spec.unit)}`;
      tooltip.hidden = false;
      return;
    }
    if (!place || !spec) return void (tooltip.hidden = true);
    const target = spec.level === "major" ? place.majorBasin : place.subBasin;
    if (!target || (spec.only && !spec.only.has(target.id))) return void (tooltip.hidden = true);
    const name = (spec.level === "major" ? majorNames : subNames).get(target.id) ?? target.name;
    tooltip.innerHTML = `<b>${esc(name)}</b><br>${esc(spec.title)}: ${fmt(spec.value(target.id))} ${esc(spec.unit)}`;
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
      load();
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
