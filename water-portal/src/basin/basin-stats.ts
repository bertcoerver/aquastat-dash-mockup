/*
 * Basin view: statistics charts in the water balance panel, below the model's results
 * (stats-cards.ts): the world's major basins and sub-basins when nothing is selected,
 * the selected major basin's sub-basins otherwise. All over the top bar's date range.
 *
 * Each card has a map: hovering previews it, clicking pins it (map-drivers.ts).
 * Without a pin the map shows the first card's map, unless a sub-basin is selected:
 * then it shows the water balance model's (water-balance.ts), which this hands the
 * map back to. Hovering a basin in a chart picks it out on the map; hovering a basin
 * on the map shows its value.
 */
import type { WaterMap } from "../map/map";
import type { Place } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import { mixColor, type Color } from "../map/theme";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import type { Selection } from "../selection";
import type { MajorBasin } from "../toolbar/place-picker";
import { fmtEnd, fmtStart } from "../toolbar/dekads";
import type { DekadRange, View } from "../toolbar/range-rules";
import { MAJOR_CARDS, WORLD_CARDS, aggregate, type BasinAgg, type BasinCard, type BasinCtx, type BasinMapSpec } from "./stats-cards";
import { loadMonthly, loadPeriod, type Monthly, type PeriodStats } from "./stats-data";
import { fmt, rampScale } from "./variables";

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
    hover: null as Place | null,
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
          `<span class="cp-pin" aria-hidden="true">Pinned</span>` +
          (out.csv.length > 1 ? `<button class="wb-csv" data-csv="${card.id}">CSV</button>` : "") +
          `</span></h3><p>${esc(card.caption(ctx))}</p>${out.html}</section>`;
      })
      .join("") +
      `<p class="wb-about">Precipitation and actual evapotranspiration: WaPOR v3 L1, dekadal means per sub-basin, ` +
      `totalled over the period. Major basins: area-weighted over their sub-basins.</p>`;
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

  /** The card the map follows: previewed, pinned, or by default the first (none with a sub-basin selected). */
  function activeDriver(): Driver | null {
    const d = drivers.preview() ?? state.pinned.get(scope()) ?? null;
    if (d && current?.cards.some((c) => c.id === d.id)) return d;
    if (state.selection?.subBasin || !current) return null;
    return { id: current.cards[0].id, sub: null };
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
    const card = cards.find((c) => c.id === d.id)!;
    const spec = card.map(ctx, d.sub);
    current.spec = spec;

    // A basin under the pointer in a chart: "major:<id>" or "sub:<id>".
    const [kind, idText] = d.sub?.split(":") ?? [];
    const picked = idText ? Number(idText) : null;
    const ids = spec.level === "major" ? [...ctx.majors.keys()] : [...(spec.only ?? ctx.stats.sub.keys())];
    const values = ids.map((id) => spec.value(id));
    const scale = rampScale(spec, values);
    const theme = map.theme;
    const colors = new Map<number, Color>();
    ids.forEach((id, i) => {
      const c = scale.color(values[i]) ?? (spec.level === "major" ? theme.noData : null);
      if (!c) return;
      const subOf = spec.level === "sub" && kind === "major" ? ctx.stats.sub.get(id)?.majorBasin : id;
      const faded = picked !== null && subOf !== picked;
      colors.set(id, faded ? mixColor(c, theme.land, 0.78) : c);
    });
    const outlined = [...(spec.listed ?? []), ...(kind === "sub" && picked !== null ? [picked] : [])];
    map.setBasinStatFills({ level: spec.level, key: `${spec.id}:${ctx.period}:${d.sub ?? ""}:${outlined.join()}`, colors, outlined });
    setMapOverride(true);

    // Legend
    legend.hidden = false;
    $("bs-legend-title").innerHTML = `${esc(spec.title)}<small>${esc(spec.note)}${spec.scale === "log" ? " · Log scale" : ""}</small>`;
    $("bs-legend-period").textContent = ctx.period;
    $("bs-legend-unit").textContent = spec.unit;
    $("bs-legend-ramp").style.background = scale.gradient;
    $("bs-legend-ticks").innerHTML = scale.ticks.map((t) => `<span style="left:${t.at * 100}%">${fmt(t.value)}</span>`).join("");
    showMapTooltip();
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
