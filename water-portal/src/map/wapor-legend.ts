/*
 * The legend for the WaPOR raster (Local view): period, colour ramp and whether the
 * raster is loading or not published yet. The markup lives in index.html.
 */
import type { WaporPeriod } from "./layers/wapor";

export type WaporStatus = "checking" | "loading" | "ready" | "missing";

const STATUS_TEXT: Record<WaporStatus, string> = {
  checking: "Looking for the map…",
  loading: "Loading…",
  ready: "",
  missing: "Not published yet for this period.",
};

const $ = (id: string) => document.getElementById(id)!;

/** Returns a function that shows the legend for a period (null hides it). */
export function initWaporLegend() {
  const legend = $("wapor-legend");

  return (period: WaporPeriod | null, status: WaporStatus = "ready") => {
    legend.hidden = !period;
    if (!period) return;
    legend.dataset.status = status;
    $("wapor-period").textContent = period.label;
    $("wapor-unit").textContent = period.unit;
    $("wapor-status").textContent = STATUS_TEXT[status];

    // Stops sit where their value falls between the first and the last.
    const { quantities: q, colors } = period.ramp;
    const at = (v: number) => ((v - q[0]) / (q[4] - q[0])) * 100;
    $("wapor-ramp").style.background =
      `linear-gradient(to right, ${colors.map((c, i) => `${c} ${at(q[i])}%`).join(", ")})`;
    $("wapor-ticks").innerHTML = q
      .map((v) => `<span style="left:${at(v)}%">${+(v * period.scale).toFixed(1)}</span>`)
      .join("");
  };
}
