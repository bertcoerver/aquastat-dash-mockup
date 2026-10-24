/** SDG 6.4.2 water stress per country (M49) per year, from FAO AQUASTAT. */

// The query FAO's Water Portal uses; returns CSV keyed on m49 with open CORS.
const LIVE_URL =
  "https://api.data.apps.fao.org/api/v2/bigquery?sql_url=https://data.apps.fao.org/catalog/dataset/b255d767-646b-42c4-ba9c-f14afbdd9b89/resource/345ab719-3232-4b34-8ed4-ea08673550b2/download/latest_sdg64.sql";
// Snapshot of the same response, used when the live endpoint is unreachable.
const SNAPSHOT_URL = `${import.meta.env.BASE_URL}data/sdg64.csv`;

export type WaterStress = {
  /** year -> (m49 -> water stress, % of available freshwater withdrawn) */
  byYear: Map<number, Map<number, number>>;
  /** m49 -> country name as published by AQUASTAT */
  names: Map<number, string>;
  years: number[];
  source: "live" | "snapshot";
};

/** Official SDG 6.4.2 stress categories. Kept in sync with the legend in index.html. */
export const STRESS_CLASSES: { max: number; label: string; color: [number, number, number] }[] = [
  { max: 25, label: "No stress (<25%)", color: [253, 231, 199] },
  { max: 50, label: "Low (25–50%)", color: [251, 184, 122] },
  { max: 75, label: "Medium (50–75%)", color: [240, 124, 74] },
  { max: 100, label: "High (75–100%)", color: [200, 64, 47] },
  { max: Infinity, label: "Critical (>100%)", color: [127, 29, 29] },
];

export function stressColor(value: number | undefined): [number, number, number, number] {
  if (value === undefined) return [150, 160, 166, 90];
  const cls = STRESS_CLASSES.find((c) => value < c.max) ?? STRESS_CLASSES[STRESS_CLASSES.length - 1];
  return [...cls.color, 235];
}

export function stressLabel(value: number): string {
  return (STRESS_CLASSES.find((c) => value < c.max) ?? STRESS_CLASSES[4]).label.replace(/ \(.*/, "");
}

export async function loadWaterStress(): Promise<WaterStress> {
  let text: string;
  let source: WaterStress["source"] = "live";
  try {
    const res = await fetch(LIVE_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.warn("Live SDG 6.4 request failed, using snapshot:", err);
    text = await (await fetch(SNAPSHOT_URL)).text();
    source = "snapshot";
  }

  const [header, ...rows] = parseCsv(text);
  const col = (name: string) => header.indexOf(name);
  const iM49 = col("m49");
  const iArea = col("area");
  const iYear = col("year");
  const iWs = col("ws");

  const byYear = new Map<number, Map<number, number>>();
  const names = new Map<number, string>();
  for (const row of rows) {
    const ws = Number.parseFloat(row[iWs]);
    if (!Number.isFinite(ws)) continue;
    const m49 = Number(row[iM49]);
    const year = Number(row[iYear]);
    names.set(m49, row[iArea]);
    if (!byYear.has(year)) byYear.set(year, new Map());
    byYear.get(year)!.set(m49, ws);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  return { byYear, names, years, source };
}

/** Minimal RFC 4180 parser: handles quoted fields with commas and "" escapes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
