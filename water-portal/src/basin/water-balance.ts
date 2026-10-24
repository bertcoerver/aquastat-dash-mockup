/*
 * Basin view: the water balance of the selected sub-basin and everything upstream of
 * it, after FAO's WaPOR Discharge app. Selecting a sub-basin runs the model (model.ts)
 * for that network; then
 *
 * - the map colours each sub-basin of the network by the chosen variable (PCP, AETI,
 *   Q or ΔS), averaged over the date range in the top bar, with a legend that also
 *   switches the variable;
 * - a panel on the right shows the selected sub-basin's numbers for the period, its
 *   time series (drag on it to change the period) and the network's water balance as
 *   a Sankey diagram (hover a sub-basin there to outline it on the map);
 * - hovering a sub-basin of the network on the map shows its value.
 *
 * The markup lives in index.html.
 */
import type { WaterMap } from "../map/map";
import type { SubBasin } from "../map/sub-basin-network";
import type { Color } from "../map/theme";
import type { Selection } from "../selection";
import { dkM, dkY, endDay, fmtEnd, fmtStart, startDay } from "../toolbar/dekads";
import type { DekadRange, View } from "../toolbar/range-rules";
import { VARIABLES, coveredRange, periodMeans, runNetwork, type Means, type NetworkResult, type Variable } from "./model";
import { initSankey, type SankeyData } from "./sankey";
import { initTimeseries } from "./timeseries";
import { STYLES, colorScale, fmt } from "./variables";

interface Options {
  map: WaterMap;
  subBasins: SubBasin[];
  upstreamOf: (id: number) => Set<number>;
  /** Change the top bar's date range (from dragging on the time series). */
  setRange: (range: DekadRange) => void;
}

export interface WaterBalance {
  setView(view: View): void;
  setRange(range: DekadRange): void;
  setSelection(selection: Selection): void;
  /** The sub-basin under the pointer on the map (null: none). */
  hover(subBasinId: number | null): void;
  /** A statistics chart drives the map (basin-stats.ts): hide the legend and the map tooltip. */
  setMapOverride(override: boolean): void;
}

type Status = { kind: "idle" } | { kind: "loading"; since: number } | { kind: "error"; message: string } | { kind: "ready"; result: NetworkResult };

const $ = (id: string) => document.getElementById(id)!;

export function initWaterBalance({ map, subBasins, upstreamOf, setRange }: Options): WaterBalance {
  const byId = new Map(subBasins.map((b) => [b.id, b]));
  const state = {
    view: "country" as View,
    range: { start: 0, end: 0 } as DekadRange,
    selection: null as Selection | null,
    selected: null as number | null, // the selected sub-basin (the network's outlet)
    variable: "Q" as Variable,
    status: { kind: "idle" } as Status,
    sankeyHover: null as number | null,
    mapHover: null as number | null,
    override: false,
  };
  // What the last render computed, for tooltips and downloads.
  let current: { result: NetworkResult; range: DekadRange; means: Means } | null = null;

  const panel = $("wb-panel");
  const legend = $("wb-legend");
  const tooltip = $("wb-tooltip");
  const updateTimeseries = initTimeseries($("wb-overview"), $("wb-zoom"), (range) => setRange(range));
  const updateSankey = initSankey($("wb-sankey"), (id) => {
    state.sankeyHover = id;
    showOutlines();
  });

  // --- Variable switches: in the legend and as the panel's number tiles -----------------
  $("wb-legend-vars").innerHTML = VARIABLES.map(
    (v) => `<button role="radio" data-var="${v}" title="${STYLES[v].label}">${STYLES[v].short}</button>`,
  ).join("");
  for (const container of [$("wb-legend-vars"), $("wb-stats")]) {
    container.addEventListener("click", (e) => {
      const button = (e.target as Element).closest<HTMLElement>("[data-var]");
      if (!button) return;
      state.variable = button.dataset.var as Variable;
      render();
    });
  }

  // Collapse the panel to its title.
  const collapse = $("wb-collapse");
  collapse.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    collapse.setAttribute("aria-expanded", String(!collapsed));
    collapse.textContent = collapsed ? "+" : "–";
  });

  for (const button of panel.querySelectorAll<HTMLButtonElement>("[data-csv]")) {
    button.addEventListener("click", () => download(button.dataset.csv as "map" | "timeseries" | "flows"));
  }

  // The tooltip follows the pointer over the map.
  const mapEl = map.map.getContainer();
  mapEl.addEventListener("pointermove", (e) => {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  mapEl.addEventListener("pointerleave", () => (tooltip.hidden = true));

  // --- Loading the model -------------------------------------------------------------
  function load(id: number) {
    const outlet = byId.get(id);
    if (!outlet) {
      state.status = { kind: "error", message: "This sub-basin isn't in the sub-basin list." };
      return render();
    }
    const upstream = [...upstreamOf(id)].map((u) => byId.get(u)!).filter(Boolean);
    state.status = { kind: "loading", since: performance.now() };
    render();
    runNetwork(outlet, upstream).then(
      (result) => {
        if (state.selected !== id) return;
        state.status = { kind: "ready", result };
        render();
      },
      (err: Error) => {
        if (state.selected !== id) return;
        state.status = { kind: "error", message: err.message };
        render();
      },
    );
  }

  // While loading, the elapsed time ticks along.
  setInterval(() => {
    if (state.view === "basin" && state.status.kind === "loading") renderMessage();
  }, 1000);

  /** Load (or forget) the network when the selected sub-basin changes in the Basin view. */
  function sync() {
    const id = state.view === "basin" ? (state.selection?.subBasin?.id ?? null) : null;
    if (id === state.selected) return;
    state.selected = id;
    state.sankeyHover = null;
    if (id === null) {
      state.status = { kind: "idle" };
      render();
    } else {
      load(id);
    }
  }

  // --- Rendering ---------------------------------------------------------------------
  // Range changes come in quickly while dragging: redraw once per frame, and the
  // Sankey diagram (the slowest part) only once the range rests for a moment.
  let frame = 0;
  let sankeyTimer = 0;
  let sankeyKey = "";

  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  function draw() {
    const basinView = state.view === "basin";
    panel.hidden = !basinView;
    legend.hidden = true;
    current = null;
    if (!basinView) {
      tooltip.hidden = true;
      map.setSubBasinFills(null);
      map.setOutlinedSubBasins([]);
      return;
    }

    renderMessage();
    showOutlines();

    const status = state.status;
    if (status.kind !== "ready") {
      $("wb-results").hidden = true;
      $("wb-subtitle").textContent = subtitle(null);
      // While the model runs, shade the network the way hovering does.
      if (status.kind === "loading" && state.selected !== null) {
        const colors = new Map<number, Color>([...upstreamOf(state.selected)].map((id) => [id, map.theme.upstream]));
        colors.set(state.selected, map.theme.hovered);
        map.setSubBasinFills({ key: `loading:${state.selected}`, colors });
      } else {
        map.setSubBasinFills(null);
      }
      updateSankey(null);
      sankeyKey = "";
      return;
    }

    const { result } = status;
    const range = coveredRange(result, state.range);
    $("wb-subtitle").textContent = subtitle(result);
    $("wb-results").hidden = false;
    const style = STYLES[state.variable];
    const outletSeries = result.series.get(result.outlet);

    // Time series (also when the period has no output: drag on it to pick one that has).
    updateTimeseries(
      outletSeries
        ? { dekads: result.dekads, values: outletSeries[state.variable], range, color: style.color, unit: style.unit }
        : null,
    );
    $("wb-ts-caption").textContent =
      `${style.label} at ${name}, per dekad. The dashed line is its mean over the whole record ` +
      `(${fmtStart(result.dekads[0])} – ${fmtEnd(result.dekads[result.dekads.length - 1])}). ` +
      "Drag across the upper chart to choose the period, or drag the band to move it.";

    if (!range) {
      map.setSubBasinFills(null);
      renderStats(null);
      $("wb-map-caption").textContent = "";
      $("wb-sankey-caption").textContent = "";
      updateSankey(null);
      sankeyKey = "";
      return;
    }

    const means = periodMeans(result, range);
    current = { result, range, means };
    const period = `${fmtStart(range.start)} – ${fmtEnd(range.end)}`;

    // Map and legend.
    const scale = colorScale(state.variable, [...means.values()].map((m) => m[state.variable]));
    const colors = new Map<number, Color>();
    for (const [id, m] of means) {
      const c = scale.color(m[state.variable]);
      if (c) colors.set(id, c);
    }
    map.setSubBasinFills({ key: `${result.outlet}:${state.variable}:${range.start}-${range.end}`, colors });
    legend.hidden = state.override;
    for (const b of legend.querySelectorAll<HTMLElement>("[data-var]")) b.setAttribute("aria-checked", String(b.dataset.var === state.variable));
    $("wb-legend-title").innerHTML = `${style.label}<small>${style.scale === "log" ? "Log scale · " : ""}Mean per sub-basin</small>`;
    $("wb-legend-period").textContent = period;
    $("wb-legend-unit").textContent = style.unit;
    $("wb-legend-ramp").style.background = scale.gradient;
    $("wb-legend-ticks").innerHTML = scale.ticks.map((t) => `<span style="left:${t.at * 100}%">${fmt(t.value)}</span>`).join("");
    $("wb-legend-status").textContent = range.start !== state.range.start || range.end !== state.range.end
      ? `Model output covers only ${period} of the selected range.`
      : "";

    $("wb-map-caption").textContent =
      `The map shows ${style.label.toLowerCase()} (${style.unit}) averaged over ${period} for ${name}` +
      `${result.series.size > 1 ? ` and the ${result.series.size - 1} sub-basins upstream of it` : ""}.`;
    renderStats(means.get(result.outlet) ?? null);
    showHoverTooltip();

    // Sankey: rebuilt once the range rests.
    $("wb-sankey-caption").textContent =
      `Where the water of the network goes, in m³/s averaged over ${period}. Bands show ` +
      `${style.short === "ΔS" ? "no flows for ΔS" : style.label.toLowerCase()}; the small boxes at the right ` +
      "of each sub-basin are its storage change (green: rising, red: falling). Hover a sub-basin to see all " +
      "its flows and outline it on the map.";
    const key = `${result.outlet}:${state.variable}:${range.start}-${range.end}`;
    if (key !== sankeyKey) {
      sankeyKey = key;
      clearTimeout(sankeyTimer);
      sankeyTimer = window.setTimeout(() => updateSankey(sankeyData(result, means, state.variable)), 150);
    }
  }

  function subtitle(result: NetworkResult | null) {
    const sb = state.selection?.subBasin;
    if (!sb) return state.selection?.majorBasin ? "Major basin" : "";
    const upstream = result ? result.series.size - 1 : upstreamOf(sb.id).size;
    const major = state.selection?.majorBasin?.name;
    return `${major ? `${major} · ` : ""}${upstream ? `${upstream} sub-basin${upstream === 1 ? "" : "s"} upstream` : "No sub-basins upstream"}`;
  }

  function renderMessage() {
    const status = state.status;
    const message = $("wb-message");
    let text = "";
    if (!state.selection?.subBasin) {
      text = state.selection?.majorBasin
        ? "Pick one of its sub-basins (above, or click it on the map) to model the water balance of that sub-basin and everything upstream of it."
        : "Click a sub-basin on the map, or pick one above, to model the water balance of that sub-basin and everything upstream of it.";
    } else if (status.kind === "loading") {
      const n = upstreamOf(state.selection.subBasin.id).size + 1;
      const s = Math.round((performance.now() - status.since) / 1000);
      text = `Running the model for ${n} sub-basin${n === 1 ? "" : "s"}… ${s} s (large networks take up to half a minute)`;
    } else if (status.kind === "error") {
      text = status.message;
    } else if (status.kind === "ready" && !coveredRange(status.result, state.range)) {
      const { dekads } = status.result;
      text = dekads.length
        ? `There is no model output for the selected period. It runs from ${fmtStart(dekads[0])} to ${fmtEnd(dekads[dekads.length - 1])}.`
        : "The model returned no output for this sub-basin.";
    }
    message.textContent = text;
    message.hidden = !text;
    message.classList.toggle("error", status.kind === "error");
  }

  function renderStats(m: Record<Variable, number> | null) {
    $("wb-stats").innerHTML = VARIABLES.map((v) => {
      const s = STYLES[v];
      const value = m ? m[v] : NaN;
      return `<button role="radio" data-var="${v}" aria-checked="${v === state.variable}" style="--var-color:${s.color}">` +
        `<span class="wb-stat-label">${s.label}</span>` +
        `<span class="wb-stat-value">${v === "dS" && value > 0 ? "+" : ""}${fmt(value)}</span>` +
        `<span class="wb-stat-unit">${s.unit}</span></button>`;
    }).join("");
  }

  function showOutlines() {
    const ids = [state.selected, state.sankeyHover].filter((id): id is number => id !== null);
    map.setOutlinedSubBasins(state.status.kind === "ready" ? [...new Set(ids)] : []);
  }

  function showHoverTooltip() {
    const id = state.mapHover;
    const m = id !== null ? current?.means.get(id) : undefined;
    if (!m || id === null || state.override) {
      tooltip.hidden = true;
      return;
    }
    const s = STYLES[state.variable];
    tooltip.innerHTML = `<b>${byId.get(id)?.name ?? id}</b><br>${s.short}: ${fmt(m[state.variable])} ${s.unit}`;
    tooltip.hidden = false;
  }

  // --- Downloads -------------------------------------------------------------------------
  function download(what: "map" | "timeseries" | "flows") {
    if (!current) return;
    const { result, range, means } = current;
    const outletName = byId.get(result.outlet)?.name ?? String(result.outlet);
    const period = [isoStart(range.start), isoEnd(range.end)];
    let rows: (string | number)[][];
    if (what === "map") {
      rows = [["sub_basin_id", "name", "period_start", "period_end", "PCP_mm_day", "AETI_mm_day", "Q_m3s", "dS_m3s"]];
      for (const [id, m] of means) rows.push([id, byId.get(id)?.name ?? "", ...period, m.PCP, m.AETI, m.Q, m.dS]);
    } else if (what === "timeseries") {
      const s = result.series.get(result.outlet)!;
      rows = [["sub_basin_id", "name", "dekad_start", "dekad_end", "PCP_mm_day", "AETI_mm_day", "Q_m3s", "dS_m3s"]];
      result.dekads.forEach((dk, i) => rows.push([result.outlet, outletName, isoStart(dk), isoEnd(dk), s.PCP[i], s.AETI[i], s.Q[i], s.dS[i]]));
    } else {
      rows = [["source", "target", "flow", "period_start", "period_end", "value_m3s"]];
      for (const b of sankeyData(result, means, state.variable).basins) {
        const down = b.downstream === null ? "Discharge (outlet)" : byId.get(b.downstream)?.name ?? String(b.downstream);
        rows.push(["Precipitation", b.name, "PCP", ...period, b.pcp]);
        rows.push([b.name, "Evapotranspiration", "AETI", ...period, b.aeti]);
        rows.push([b.name, down, "Q", ...period, b.q]);
      }
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${what === "flows" ? "water_balance" : what}_${result.outlet}_${period[0]}_${period[1]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** The Sankey diagram's input: period means in m³/s. */
  function sankeyData(result: NetworkResult, means: Means, variable: Variable): SankeyData {
    // mm/day over the area (km²) -> m³/s
    const toFlow = (mmDay: number, area: number) => (mmDay * area * 1e6) / 1e3 / 86400;
    const basins = [...means].map(([id, m]) => {
      const b = byId.get(id)!;
      const area = b.area ?? 1; // the model's own fallback (1 km²)
      return {
        id,
        name: b.name,
        downstream: id === result.outlet ? null : b.downstream,
        pcp: toFlow(m.PCP, area) || 0,
        aeti: toFlow(m.AETI, area) || 0,
        q: m.Q || 0,
      };
    });
    return { outlet: result.outlet, basins, variable };
  }

  return {
    setView(view) {
      state.view = view;
      sync();
      render();
    },
    setRange(range) {
      state.range = range;
      render();
    },
    setSelection(selection) {
      state.selection = selection;
      sync();
      render();
    },
    hover(id) {
      state.mapHover = id;
      showHoverTooltip();
    },
    setMapOverride(override) {
      if (override === state.override) return;
      state.override = override;
      render();
    },
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const isoStart = (dk: number) => `${dkY(dk)}-${pad(dkM(dk) + 1)}-${pad(startDay(dk))}`;
const isoEnd = (dk: number) => `${dkY(dk)}-${pad(dkM(dk) + 1)}-${pad(endDay(dk))}`;
const csvCell = (v: string | number) =>
  typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
