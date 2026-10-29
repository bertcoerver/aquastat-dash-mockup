/*
 * The water balance of a sub-basin network as a Sankey diagram, laid out like the
 * WaPOR Discharge app's (holoviz_utils.hydrology.prepare_sankey_data):
 *
 * - one row per level of the network: the outlet (the selected sub-basin) near the
 *   bottom, each step upstream one row higher;
 * - a Precipitation node above everything, Evapotranspiration and Discharge (what
 *   leaves the outlet) below;
 * - bands: precipitation into each sub-basin, evapotranspiration out of it, and
 *   discharge from each sub-basin to the next one down. All in m³/s, averaged over
 *   the period, and as wide as they are large;
 * - at the right end of each sub-basin a small box for its storage change
 *   (inflow − outflow): green where storage rises, red where it falls.
 *
 * Only the bands of the variable shown on the map are drawn; hovering a sub-basin
 * shows all of its own bands and its numbers (and the map outlines it).
 */
import type { Variable } from "./model";
import { STYLES, fmt } from "./variables";
import { esc } from "../lib/html";

export interface SankeyBasin {
  id: number;
  name: string;
  /** The sub-basin it drains into within the network (null: the outlet). */
  downstream: number | null;
  /** Period means in m³/s. */
  pcp: number;
  aeti: number;
  q: number;
}

export interface SankeyData {
  outlet: number;
  basins: SankeyBasin[];
  variable: Variable;
}

type Group = "PCP" | "AETI" | "Q";

interface Node {
  key: string; // "PCP", "AETI", "Q" or the basin id
  label: string;
  level: number;
  value: number; // width in m³/s
  basin?: SankeyBasin;
  qin?: number;
  x0: number;
  x1: number;
  y: number;
}

interface Flow {
  source: string;
  target: string;
  value: number;
  group: Group;
}

const GAP = 3; // px between nodes in a row (less in crowded rows)

/** `onHover` gets the sub-basin under the pointer (null: none). Returns the redraw function. */
export function initSankey(el: HTMLElement, onHover: (id: number | null) => void): (data: SankeyData | null) => void {
  let data: SankeyData | null = null;
  let hovered: string | null = null;
  const tip = document.createElement("div");
  tip.className = "sk-tip";
  tip.hidden = true;

  function draw() {
    el.innerHTML = "";
    if (!data || !data.basins.length) return;
    el.append(layout(data, el.clientWidth), tip);
  }

  function setHovered(key: string | null) {
    if (key === hovered) return;
    hovered = key;
    const svg = el.querySelector("svg");
    svg?.classList.toggle("sk-hovering", key !== null);
    for (const node of el.querySelectorAll<SVGElement>("[data-node]")) node.classList.toggle("on", node.dataset.node === key);
    for (const band of el.querySelectorAll<SVGElement>(".sk-band")) {
      band.classList.toggle("on", key !== null && (band.dataset.source === key || band.dataset.target === key));
    }
    const id = key && /^\d+$/.test(key) ? Number(key) : null;
    onHover(id);
  }

  el.addEventListener("pointermove", (e) => {
    const target = (e.target as Element).closest<SVGElement>("[data-node], .sk-band");
    if (!target || !data) {
      tip.hidden = true;
      return setHovered(null);
    }
    tip.innerHTML = target.dataset.tip!;
    tip.hidden = false;
    const box = el.getBoundingClientRect();
    const x = e.clientX - box.left;
    tip.style.left = `${Math.min(x + 12, el.clientWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = `${e.clientY - box.top + 14}px`;
    if (target.dataset.node) setHovered(target.dataset.node);
  });
  el.addEventListener("pointerleave", () => {
    tip.hidden = true;
    setHovered(null);
  });

  new ResizeObserver(draw).observe(el);

  return (next) => {
    data = next;
    hovered = null;
    onHover(null);
    draw();
  };
}

function layout({ outlet, basins, variable }: SankeyData, width: number): SVGSVGElement {
  // --- Network: levels and order --------------------------------------------------
  const byId = new Map(basins.map((b) => [b.id, b]));
  const upstreamOf = new Map<number, number[]>(basins.map((b) => [b.id, []]));
  for (const b of basins) if (b.downstream !== null && upstreamOf.has(b.downstream)) upstreamOf.get(b.downstream)!.push(b.id);
  // Depth-first from the outlet, so neighbours in a row share a branch (fewer crossings).
  const order: number[] = [];
  const level = new Map<number, number>([[outlet, 1]]);
  const visit = (id: number) => {
    order.push(id);
    for (const up of upstreamOf.get(id)!.sort((a, b) => String(a).localeCompare(String(b)))) {
      level.set(up, level.get(id)! + 1);
      visit(up);
    }
  };
  visit(outlet);
  const maxLevel = Math.max(...level.values());

  // --- Nodes and flows (m³/s) -------------------------------------------------------
  const flows: Flow[] = [];
  const nodes: Node[] = [];
  const node = (key: string, label: string, lvl: number, value: number, extra: Partial<Node> = {}) =>
    nodes.push({ key, label, level: lvl, value, x0: 0, x1: 0, y: 0, ...extra });

  let totalPcp = 0;
  let totalAeti = 0;
  for (const id of order) {
    const b = byId.get(id)!;
    totalPcp += Math.max(0, b.pcp);
    totalAeti += Math.max(0, b.aeti);
    if (b.pcp > 0) flows.push({ source: "PCP", target: String(id), value: b.pcp, group: "PCP" });
    if (b.aeti > 0) flows.push({ source: String(id), target: "AETI", value: b.aeti, group: "AETI" });
    const down = id === outlet ? "Q" : String(b.downstream);
    if (b.q > 0) flows.push({ source: String(id), target: down, value: b.q, group: "Q" });
  }
  node("PCP", "Precipitation", maxLevel + 1, totalPcp);
  for (const id of order) {
    const b = byId.get(id)!;
    const qin = upstreamOf.get(id)!.reduce((sum, up) => sum + Math.max(0, byId.get(up)!.q), 0);
    const inflow = Math.max(0, b.pcp) + qin;
    const outflow = Math.max(0, b.aeti) + Math.max(0, b.q);
    node(String(id), b.name, level.get(id)!, Math.max(inflow, outflow), { basin: b, qin });
  }
  node("AETI", "Evapotranspiration", 0, totalAeti);
  const outletQ = Math.max(0, byId.get(outlet)!.q);
  if (outletQ > 0) node("Q", "Discharge", 0, outletQ);

  // --- Positions ----------------------------------------------------------------------
  // One scale (px per m³/s) for everything, so that the widest row fits.
  const rows = new Map<number, Node[]>();
  for (const n of nodes) {
    if (!rows.has(n.level)) rows.set(n.level, []);
    rows.get(n.level)!.push(n);
  }
  const gapOf = (row: Node[]) => (row.length > 1 ? Math.min(GAP, (width * 0.25) / (row.length - 1)) : 0);
  let k = Infinity;
  for (const row of rows.values()) {
    const sum = row.reduce((s, n) => s + n.value, 0);
    if (sum > 0) k = Math.min(k, (width - 2 - gapOf(row) * (row.length - 1)) / sum);
  }
  if (!Number.isFinite(k)) k = 0;

  const levels = maxLevel + 2;
  const rowH = Math.max(18, Math.min(64, 520 / levels));
  const nodeH = Math.max(5, Math.round(rowH * 0.3));
  const top = 18;
  const height = top + (levels - 1) * rowH + nodeH + 22;
  for (const [lvl, row] of rows) {
    const gap = gapOf(row);
    let x = (width - (row.reduce((s, n) => s + n.value * k, 0) + gap * (row.length - 1))) / 2;
    for (const n of row) {
      n.x0 = x;
      n.x1 = x + n.value * k;
      n.y = top + (maxLevel + 1 - lvl) * rowH;
      x = n.x1 + gap;
    }
  }

  // --- Bands --------------------------------------------------------------------------
  // Within a node, bands are stacked from its left edge, in the order of the node at
  // their other end, so they don't cross on the way.
  const nodeOf = new Map(nodes.map((n) => [n.key, n]));
  const outAt = new Map<Flow, number>();
  const inAt = new Map<Flow, number>();
  for (const [side, at, other] of [
    ["source", outAt, "target"],
    ["target", inAt, "source"],
  ] as const) {
    const groups = new Map<string, Flow[]>();
    for (const f of flows) {
      if (!groups.has(f[side])) groups.set(f[side], []);
      groups.get(f[side])!.push(f);
    }
    for (const [key, group] of groups) {
      let x = nodeOf.get(key)!.x0;
      for (const f of group.sort((a, b) => nodeOf.get(a[other])!.x0 - nodeOf.get(b[other])!.x0)) {
        at.set(f, x);
        x += f.value * k;
      }
    }
  }

  const label = (key: string) => nodeOf.get(key)!.label;
  const unit = "m³/s";
  const bands = flows
    .map((f) => {
      const s = nodeOf.get(f.source)!;
      const t = nodeOf.get(f.target)!;
      const d = band(outAt.get(f)!, s.y + nodeH, inAt.get(f)!, t.y, f.value * k);
      const tip = `<b>${esc(label(f.source))} → ${esc(label(f.target))}</b><br>${STYLES[f.group].short}: ${fmt(f.value)} ${unit}`;
      const shown = f.group === variable ? " shown" : "";
      return `<path class="sk-band${shown}" d="${d}" fill="${STYLES[f.group].color}" data-source="${f.source}" data-target="${f.target}" data-tip="${attr(tip)}"/>`;
    })
    .join("");

  // --- Nodes and storage change ------------------------------------------------------
  const rects = nodes
    .map((n) => {
      const w = Math.max(1, n.x1 - n.x0);
      if (!n.basin) {
        const color = STYLES[n.key as Group].color;
        const tip = `<b>${n.label}</b><br>${fmt(n.value)} ${unit}`;
        const tx = Math.min(Math.max(n.x0 + w / 2, 40), width - 40);
        const ty = n.level === 0 ? n.y + nodeH + 13 : n.y - 5;
        return `<g data-node="${n.key}" data-tip="${attr(tip)}"><rect x="${n.x0}" y="${n.y}" width="${w}" height="${nodeH}" fill="${color}"/>` +
          `<text class="sk-label" x="${tx}" y="${ty}" text-anchor="middle">${n.label}</text></g>`;
      }
      const b = n.basin;
      const inflow = Math.max(0, b.pcp) + n.qin!;
      const outflow = Math.max(0, b.aeti) + Math.max(0, b.q);
      const ds = inflow - outflow;
      const tip =
        `<b>${esc(b.name)}</b> <span class="sk-id">${b.id}</span><br>` +
        `In: precipitation ${fmt(b.pcp)}, discharge from upstream ${fmt(n.qin!)}<br>` +
        `Out: evapotranspiration ${fmt(b.aeti)}, discharge ${fmt(b.q)}<br>` +
        `Storage change: ${ds >= 0 ? "+" : ""}${fmt(ds)} ${unit}`;
      const res = Math.min(w, Math.abs(ds) * k);
      const resRect = res >= 0.5 ? `<rect class="sk-res ${ds > 0 ? "up" : "down"}" x="${n.x1 - res}" y="${n.y}" width="${res}" height="${nodeH}"/>` : "";
      return `<g data-node="${n.key}" data-tip="${attr(tip)}" class="sk-basin${b.id === outlet ? " outlet" : ""}">` +
        `<rect class="sk-hit" x="${n.x0 - 1}" y="${n.y - 3}" width="${w + 2}" height="${nodeH + 6}"/>` +
        `<rect class="sk-node" x="${n.x0}" y="${n.y}" width="${w}" height="${nodeH}"/>${resRect}</g>`;
    })
    .join("");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("class", "sankey");
  svg.innerHTML =
    `<text class="sk-axis" x="0" y="${top + rowH - 4}">↑ upstream</text>` +
    `<text class="sk-axis" x="0" y="${top + maxLevel * rowH + nodeH + 12}">↓ downstream</text>` +
    `<g class="sk-bands">${bands}</g>${rects}`;
  return svg;
}

/** A band from (x0, y0) down to (x1, y1), `w` wide, easing sideways on the way. */
function band(x0: number, y0: number, x1: number, y1: number, w: number) {
  const steps = 16;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s = t * t * (3 - 2 * t);
    const x = x0 + (x1 - x0) * s;
    const y = (y0 + (y1 - y0) * t).toFixed(1);
    left.push(`${x.toFixed(1)},${y}`);
    right.push(`${(x + w).toFixed(1)},${y}`);
  }
  return `M${left.join("L")}L${right.reverse().join("L")}Z`;
}

const attr = esc;
