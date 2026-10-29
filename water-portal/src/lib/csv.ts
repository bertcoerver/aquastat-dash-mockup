/** A value as a CSV cell: numbers as they are (nothing for NaN), text quoted where it has to be. */
const cell = (v: string | number) =>
  typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** Rows as CSV text. */
export const csvText = (rows: (string | number)[][]) => rows.map((r) => r.map(cell).join(",")).join("\n");

/** Have the browser save rows as a CSV file called `name`. */
export function downloadCsv(name: string, rows: (string | number)[][]) {
  const a = document.createElement("a");
  const url = (a.href = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv" })));
  a.download = name;
  a.click();
  // (Not at once: a browser may not have started the download yet.)
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
