/*
 * Basin view: a discharge map of the selected major basin drawn along its rivers rather
 * than as sub-basin fills. Each river arc gets its share of the model's discharge
 * (rivers.ts) and is drawn with a width and a colour that both follow it: the width
 * (square root) sets the big rivers apart, the colour (log scale, as the fills) the small
 * ones. The land is left plain, the other major basins greyed.
 *
 * basin-stats.ts asks for it for the maps that allow it (BasinMapSpec.rivers: discharge
 * per sub-basin), and a switch in the legend goes back to the sub-basin fills. The
 * legend's ramp narrows to the left as the rivers do, so it reads as a key to both.
 */
import type { RiverArc } from "../map/layers/river-flows";
import type { WaterMap } from "../map/map";
import type { SubBasin } from "../map/sub-basin-network";
import { slideSelection } from "../panels/segmented";
import { RIVER_MAX_WIDTH, loadRivers, riverDischarge, riverWidth, type RiverNetwork } from "./rivers";
import type { ColorScale } from "./variables";

interface Options {
  map: WaterMap;
  subBasins: SubBasin[];
  /** The legend (#bs-legend): the switch goes under its title. */
  legend: HTMLElement;
  /** The legend's colour ramp, shaped like the rivers while they show. */
  ramp: HTMLElement;
  /** Draw the map again: the rivers loaded, or the switch moved. */
  onChange(): void;
  /** The river under the pointer changed (see hovered). */
  onHover(): void;
}

export interface RiverMap {
  /**
   * Whether a map with these rivers (`allowed`: BasinMapSpec.rivers) of major basin
   * `major` is drawn as rivers, and if so its discharge along them, from `value` per
   * sub-basin (`key` names that, for the cache): the values for the colour scale, empty
   * until the rivers are in, and why (the status). Null: draw the fills. Shows the
   * legend's switch when there's a choice.
   */
  prepare(allowed: boolean | undefined, major: number | null, value: (id: number) => number, key: string): { values: number[]; status: string } | null;
  /** Draw the rivers last prepared with `scale` (null: none), and shape the legend's ramp. */
  draw(scale: ColorScale | null): void;
  /** The river under the pointer: its sub-basin and discharge (null: none). */
  hovered(): { subBasin: number; q: number } | null;
}

type NetStatus = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; net: RiverNetwork | null };

/** The colour scale spans at most this ratio of the basin's largest discharge to its smallest. */
const FLOOR = 1e4;
/** Points along the legend's wedge. */
const WEDGE_STEPS = 24;

export function initRiverMap({ map, subBasins, legend, ramp, onChange, onHover }: Options): RiverMap {
  const nets = new Map<number, NetStatus>();
  let mode: "rivers" | "fills" = "rivers";
  let prepared: { key: string; net: RiverNetwork; q: Float32Array } | null = null;
  let drawn: { key: string; scale: ColorScale } | null = null;
  let hover: number | null = null;
  let lastMajor: number | null = null;

  // --- The switch, under the legend's title ----------------------------------------------
  const toggle = document.createElement("div");
  toggle.className = "wb-vars";
  toggle.setAttribute("role", "radiogroup");
  toggle.setAttribute("aria-label", "Discharge shown");
  toggle.style.margin = "8px 0 2px";
  toggle.hidden = true;
  toggle.innerHTML =
    '<button type="button" role="radio" data-mode="rivers" title="Discharge along the rivers">Rivers</button>' +
    '<button type="button" role="radio" data-mode="fills" title="Discharge out of each sub-basin">Sub-basins</button>';
  legend.querySelector(".legend-title")!.after(toggle);
  slideSelection(toggle);
  const showMode = () => {
    for (const b of toggle.querySelectorAll<HTMLElement>("[data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  };
  showMode();
  toggle.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("[data-mode]");
    if (!button || button.dataset.mode === mode) return;
    mode = button.dataset.mode as typeof mode;
    showMode();
    onChange();
  });

  function network(major: number): NetStatus {
    let status = nets.get(major);
    if (!status) {
      nets.set(major, (status = { kind: "loading" }));
      loadRivers(major).then(
        (net) => nets.set(major, { kind: "ready", net }),
        (err: Error) => nets.set(major, { kind: "error", message: err.message }),
      ).then(onChange);
    }
    return status;
  }

  function off() {
    prepared = null;
    if (hover !== null) {
      hover = null;
      onHover();
    }
    return null;
  }

  return {
    prepare(allowed, major, value, key) {
      toggle.hidden = !allowed || major === null;
      if (!allowed || major === null || mode !== "rivers") return off();
      // A failed load is tried again once another basin has been picked.
      if (major !== lastMajor) for (const [id, s] of nets) if (s.kind === "error") nets.delete(id);
      lastMajor = major;
      const status = network(major);
      if (status.kind === "error") {
        prepared = null;
        return { values: [], status: status.message };
      }
      if (status.kind === "loading") {
        prepared = null;
        return { values: [], status: "Loading the rivers…" };
      }
      if (!status.net) {
        prepared = null;
        return { values: [], status: "This basin has no rivers in the river network." };
      }
      const k = `${major}:${key}`;
      if (prepared?.key !== k) {
        const q = new Map<number, number>();
        for (const id of new Set(status.net.subBasin)) q.set(id, value(id));
        prepared = { key: k, net: status.net, q: riverDischarge(status.net, q, subBasins) };
      }
      const values = Array.from(prepared.q).filter(Number.isFinite);
      // Down to a 10,000th of the largest: smaller streams all take the lowest colour.
      const floor = Math.max(0, ...values) / FLOOR;
      return { values: values.map((v) => Math.max(v, floor)), status: "" };
    },

    draw(scale) {
      const shaped = !!(prepared && scale?.ticks.length);
      ramp.style.height = shaped ? `${RIVER_MAX_WIDTH}px` : "";
      ramp.style.clipPath = shaped ? wedge(scale!) : "";
      if (!prepared || !scale) {
        drawn = null;
        map.setRiverFlows(null);
        return;
      }
      const key = `${prepared.key}:${scale.domain.join()}:${scale.gradient}`;
      if (drawn?.key === key) return;
      drawn = { key, scale };
      const { net, q } = prepared;
      const max = scale.domain[1];
      const arcs: (RiverArc & { q: number })[] = [];
      const replaced = new Set<number>();
      for (let i = 0; i < net.n; i++) {
        const color = scale.color(q[i]);
        if (!color) continue;
        replaced.add(net.subBasin[i]);
        arcs.push({ id: i, q: q[i], path: net.coords.subarray(net.starts[i] * 2, net.starts[i + 1] * 2), color, width: riverWidth(q[i], max) });
      }
      arcs.sort((a, b) => a.q - b.q);
      map.setRiverFlows({
        key,
        arcs,
        subBasins: replaced,
        onHover(id) {
          if (id === hover) return;
          hover = id;
          onHover();
        },
      });
    },

    hovered() {
      if (hover === null || !prepared) return null;
      return { subBasin: prepared.net.subBasin[hover], q: prepared.q[hover] };
    },
  };
}

/**
 * The legend's ramp cut to the rivers' widths along it (a CSS clip-path), centred, so
 * the thin end is the small rivers' colour and the thick end the big ones'.
 */
function wedge(scale: ColorScale) {
  const [lo, hi] = scale.domain;
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i <= WEDGE_STEPS; i++) {
    const t = i / WEDGE_STEPS;
    // The ramp's position t is on its log scale (variables.ts).
    const q = lo > 0 ? lo * (hi / lo) ** t : lo + (hi - lo) * t;
    const half = riverWidth(q, hi) / 2;
    const x = `${(t * 100).toFixed(2)}%`;
    top.push(`${x} ${(RIVER_MAX_WIDTH / 2 - half).toFixed(2)}px`);
    bottom.unshift(`${x} ${(RIVER_MAX_WIDTH / 2 + half).toFixed(2)}px`);
  }
  return `polygon(${[...top, ...bottom].join(", ")})`;
}
