/*
 * Basin view: statistics charts in the water balance panel, below the model's results
 * (stats-cards.ts): the world's major basins when nothing is selected, the selected
 * major basin's sub-basins otherwise. All over the top bar's date range.
 *
 * Each card has a map: hovering previews it, clicking pins it (map-drivers.ts).
 * Without a pin the map shows the first card's map, or the one picked in the legend,
 * unless a sub-basin is selected and the water balance model is shown (water-balance.ts,
 * MODEL_SHOWN): then it shows the model's, which this hands the map back to.
 *
 * The legend's title is a menu of the charts' maps and of the water balance model's
 * discharge (Q) and storage change (ΔS), precomputed (model.ts): per major basin when
 * none is selected, per sub-basin of the selected one. Hovering a basin in a chart
 * picks it out on the map; hovering a basin on the map shows its value.
 *
 * The legend's unit is a menu too, as the WaPOR legend's: per day, month or year, or in
 * total over the period; per m² or over the basin. The map and the charts
 * follow it (the model's maps keep their own, m³/s). And the ramp is a menu of how much
 * of the basins' values the colours span (panels/ramp-menu.ts).
 */
import type { WaterMap } from "../map/map";
import type { Place } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import { mixColor, type Color } from "../map/theme";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import { DEFAULT_STRETCH, fmtStop, initRampMenu } from "../panels/ramp-menu";
import { initTitleMenu, type MenuOption } from "../panels/title-menu";
import type { Selection } from "../selection";
import type { MajorBasin } from "../toolbar/place-picker";
import { fmtEnd, fmtStart } from "../toolbar/dekads";
import { coveredRange, fluxMeans, loadMajorFluxes, loadSubBasinFluxes, type Flux, type FluxSeries } from "./model";
import type { DekadRange, View } from "../toolbar/range-rules";
import { MODEL_SHOWN } from "./water-balance";
import {
  BASIN_UNITS,
  MAJOR_CARDS,
  WORLD_CARDS,
  aggregate,
  basinUnit,
  describeBasinUnits,
  type BasinAgg,
  type BasinCard,
  type BasinCtx,
  type BasinMapSpec,
  type BasinUnits,
} from "./stats-cards";
import { loadMonthly, loadPeriod, type Monthly, type PeriodStats } from "./stats-data";
import { STYLES, fmt, rampScale } from "./variables";

interface Options {
  map: WaterMap;
  majorBasins: MajorBasin[];
  subBasins: SubBasin[];
  /** The water balance panel: it shows the model's map unless a chart takes over. */
  setMapOverride(override: boolean): void;
}

export interface BasinStats {
  setView(view: View): void;
  setRange(range: DekadRange): void;
  setSelection(selection: Selection): void;
  /** What is under the pointer on the map (null: nothing). */
  hover(place: Place | null): void;
}

type FluxStatus = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; result: FluxSeries };

/** The model's maps in the legend's menu: id -> variable. */
const MODEL_MAPS: Record<string, Flux> = { "model:Q": "Q", "model:dS": "dS" };

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; stats: PeriodStats };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LOAD_DELAY = 400; // ms: wait for the range to rest (dragging the slider passes many)

export function initBasinStats({ map, majorBasins, subBasins, setMapOverride }: Options): BasinStats {
  const majorNames = new Map(majorBasins.map((b) => [b.id, b.name]));
  const subNames = new Map(subBasins.map((b) => [b.id, b.name]));
  const state = {
    view: "country" as View,
    range: null as DekadRange | null,
    selection: null as Selection | null,
    status: { kind: "idle" } as Status,
    monthly: null as Monthly | null,
    monthlyKey: "",
    /** Pins: one for the world's cards, one for a basin's. */
    pinned: new Map<"world" | "major", Driver>(),
    /** The map picked in the legend, shown instead of the first card's. */
    chosen: new Map<"world" | "major", Driver>(),
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
  const legend = $("bs-legend");
  const tooltip = $("bs-tooltip");
  let current: { ctx: BasinCtx; cards: BasinCard[]; spec: BasinMapSpec | null; csv: Map<string, (string | number)[][]> } | null = null;

  const scope = () => (state.selection?.majorBasin ? "major" : "world");
  const drivers = initDrivers(section, {
    enabled: () => state.view === "basin",
    pinned: () => state.pinned.get(scope()) ?? null,
    setPinned(d) {
      if (d) state.pinned.set(scope(), d);
      else state.pinned.delete(scope());
    },
    onChange() {
      drawMap();
      markAll();
    },
    onCsv: download,
    tooltip,
  });

  // The legend's title: the charts' maps, one entry per variable.
  const variable = initTitleMenu(
    $("bs-variable") as HTMLButtonElement,
    () => {
      if (!current) return { options: [], current: null };
      const options: MenuOption[] = [];
      const seen = new Set<string>();
      for (const card of current.cards) {
        const spec = card.map(current.ctx, null);
        if (seen.has(spec.title)) continue;
        seen.add(spec.title);
        options.push({ id: card.id, label: spec.title });
      }
      for (const [id, v] of Object.entries(MODEL_MAPS)) options.push({ id, label: STYLES[v].label });
      return { options, current: options.find((o) => o.label === current!.spec?.title)?.id ?? null };
    },
    (id) => {
      const d = { id, sub: null };
      // With a sub-basin selected the map defaults to the model's, so the pick is a pin.
      if (followsModel()) state.pinned.set(scope(), d);
      else if (id in MODEL_MAPS) {
        // For the world too, so it shows once a basin is picked.
        for (const s of ["world", "major"] as const) {
          state.chosen.set(s, d);
          state.pinned.delete(s);
        }
      } else {
        state.chosen.set(scope(), d);
        state.pinned.delete(scope());
      }
      drivers.clearPreview();
      drawMap();
      markAll();
    },
  );

  // The unit, from a menu (not for the model's maps: they have their own).
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
    // Nothing to pick from (the model's maps): plain text.
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
          aggregates = null;
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

  // Major basin totals, per period.
  let aggregates: Map<number, BasinAgg> | null = null;
  function majors(stats: PeriodStats) {
    if (!aggregates) {
      const members = new Map<number, number[]>();
      for (const [id, s] of stats.sub) {
        if (!members.has(s.majorBasin)) members.set(s.majorBasin, []);
        members.get(s.majorBasin)!.push(id);
      }
      aggregates = new Map([...members].map(([mb, ids]) => [mb, aggregate(stats, ids)]));
    }
    return aggregates;
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
    if (status.kind !== "ready" || !status.stats.covered) {
      message.hidden = false;
      message.classList.toggle("error", status.kind === "error");
      message.textContent =
        status.kind === "error"
          ? status.message
          : status.kind === "ready"
            ? "There are no WaPOR data for the selected period (they run from 2018 to the end of 2025)."
            : "Loading basin statistics…";
      $("bs-heading").textContent = major ? `${major.name}: basin statistics` : "Basin statistics";
      cardsEl.innerHTML = "";
      return clear();
    }

    const stats = status.stats;
    const covered = stats.covered!;
    loadMonthlyFor(stats);
    const sub = state.selection?.subBasin ?? null;
    const ctx: BasinCtx = {
      period: `${fmtStart(covered.start)} – ${fmtEnd(covered.end)}`,
      stats,
      majors: majors(stats),
      major: major && { id: major.id, name: majorNames.get(major.id) ?? major.name },
      sub: sub && { id: sub.id, name: subNames.get(sub.id) ?? sub.name },
      monthly: state.monthly,
      majorName: (id) => majorNames.get(id) ?? String(id),
      subName: (id) => subNames.get(id) ?? String(id),
      width: Math.max(240, cardsEl.clientWidth - 22),
      units: state.units,
    };
    const partly = state.range && (covered.start !== state.range.start || covered.end !== state.range.end);
    message.hidden = !partly;
    message.classList.remove("error");
    message.textContent = partly ? `WaPOR data cover only ${ctx.period} of the selected range.` : "";
    $("bs-heading").textContent = ctx.major ? `${ctx.major.name}: basin statistics` : "Basins of the world";

    const cards = ctx.major ? MAJOR_CARDS : WORLD_CARDS;
    const csv = new Map<string, (string | number)[][]>();
    cardsEl.innerHTML = cards
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
      `<p class="wb-about">Precipitation and actual evapotranspiration: WaPOR v3 L1, dekadal means per sub-basin, ` +
      (state.units.per === "total" ? "totalled over the period" : `averaged over the period, per ${state.units.per}`) +
      `. Major basins: ${state.units.basin ? "summed" : "area-weighted"} over their sub-basins.</p>`;
    current = { ctx, cards, spec: null, csv };
    markAll();
    drawMap();
  }

  function clear() {
    current = null;
    legend.hidden = true;
    tooltip.hidden = true;
    map.setBasinStatFills(null);
    setMapOverride(false);
  }

  /**
   * The card the map follows: previewed, pinned, or by default the one picked in the
   * legend, else the first (none with a sub-basin selected).
   */
  function activeDriver(): Driver | null {
    const has = (d: Driver | null | undefined): d is Driver =>
      !!d && (d.id in MODEL_MAPS || !!current?.cards.some((c) => c.id === d.id));
    const d = drivers.preview() ?? state.pinned.get(scope()) ?? null;
    if (has(d)) return d;
    if (followsModel() || !current) return null;
    const chosen = state.chosen.get(scope());
    return has(chosen) ? chosen : { id: current.cards[0].id, sub: null };
  }

  /** Whether the map defaults to the water balance model's. */
  function followsModel() {
    return MODEL_SHOWN && !!state.selection?.subBasin;
  }

  function forgetFailedFluxes() {
    for (const [key, status] of state.fluxes) if (status.kind === "error") state.fluxes.delete(key);
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
      setMapOverride(false);
      return;
    }
    const { ctx, cards } = current;
    const model = d.id in MODEL_MAPS ? modelSpec(MODEL_MAPS[d.id], ctx) : null;
    const spec = model ? model.spec : cards.find((c) => c.id === d.id)!.map(ctx, d.sub);
    const period = model ? model.period : ctx.period;
    current.spec = spec;

    // A basin under the pointer in a chart: "major:<id>" or "sub:<id>".
    const [kind, idText] = d.sub?.split(":") ?? [];
    const picked = idText ? Number(idText) : null;
    const ids = spec.level === "major" ? [...ctx.majors.keys()] : [...(spec.only ?? ctx.stats.sub.keys())];
    const values = ids.map((id) => spec.value(id));
    const scale = rampScale(spec, values, undefined, state.stretch);
    const theme = map.theme;
    const colors = new Map<number, Color>();
    ids.forEach((id, i) => {
      const c = scale.color(values[i]) ?? (spec.level === "major" ? theme.noData : null);
      if (!c) return;
      const subOf = spec.level === "sub" && kind === "major" ? ctx.stats.sub.get(id)?.majorBasin : id;
      const faded = picked !== null && subOf !== picked;
      colors.set(id, faded ? mixColor(c, theme.land, 0.78) : c);
    });
    const outlined = kind === "sub" && picked !== null ? [picked] : [];
    map.setBasinStatFills({ level: spec.level, key: `${spec.id}:${state.stretch}:${period}:${model?.status ?? ""}:${d.sub ?? ""}:${outlined.join()}`, colors, outlined });
    setMapOverride(true);

    // Legend
    legend.hidden = false;
    variable.setLabel(spec.title);
    $("bs-legend-note").textContent = `${spec.note}${spec.scale === "log" ? " · Log scale" : ""}`;
    // Without values (the model, before it has run), no colour ramp: only the status.
    const empty = !scale.ticks.length;
    $("bs-legend-period").parentElement!.hidden = empty;
    $("bs-legend-ramp").hidden = empty;
    $("bs-legend-ticks").hidden = empty;
    $("bs-legend-status").textContent = model?.status ?? "";
    $("bs-legend-period").textContent = period;
    showUnit(spec);
    $("bs-legend-ramp").style.background = scale.gradient;
    const span = Math.max(...scale.ticks.map((t) => t.value)) - Math.min(...scale.ticks.map((t) => t.value));
    $("bs-legend-ticks").innerHTML = scale.ticks.map((t) => `<span style="left:${t.at * 100}%">${fmtStop(t.value, span)}</span>`).join("");
    showMapTooltip();
  }

  /**
   * The model's map of `v`, averaged over the part of the range it covers: per major
   * basin (Q at its outlets, ΔS summed over its sub-basins), or with a major basin
   * selected, per sub-basin of it. Until the output is in, no values and a status line.
   */
  function modelSpec(v: Flux, ctx: BasinCtx): { spec: BasinMapSpec; period: string; status: string } {
    const style = STYLES[v];
    const major = ctx.major;
    const spec: BasinMapSpec = {
      id: `model:${v}:${major?.id ?? "world"}`,
      title: style.label,
      unit: style.unit,
      units: false,
      note: major ? "Mean per sub-basin" : v === "Q" ? "Mean outflow per major basin" : "Mean per major basin",
      level: major ? "sub" : "major",
      value: () => NaN,
      ramp: style.ramp,
      scale: style.scale,
      only: new Set(),
    };
    const none = (status: string) => ({ spec, period: "", status });
    const status = major ? fluxes(String(major.id), () => loadSubBasinFluxes(major.id)) : fluxes("majors", loadMajorFluxes);
    if (status.kind === "loading") return none("Loading discharge and storage change…");
    if (status.kind === "error") return none(status.message);
    const { result } = status;
    const range = state.range && coveredRange(result, state.range);
    if (!range) {
      const { dekads } = result;
      return none(dekads.length
        ? `There is no model output for the selected period. It runs from ${fmtStart(dekads[0])} to ${fmtEnd(dekads[dekads.length - 1])}.`
        : "There is no model output for this basin.");
    }
    const means = fluxMeans(result, range, v);
    const period = `${fmtStart(range.start)} – ${fmtEnd(range.end)}`;
    spec.value = (id) => means.get(id) ?? NaN;
    spec.only = major ? new Set(subBasins.filter((b) => b.majorBasin === major.id).map((b) => b.id)) : null;
    const partly = range.start !== state.range!.start || range.end !== state.range!.end;
    return { spec, period, status: partly ? `Model output covers only ${period} of the selected range.` : "" };
  }

  function showMapTooltip() {
    const place = state.hover;
    const spec = current?.spec;
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
