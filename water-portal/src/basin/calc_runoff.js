// calc_runoff.js — JavaScript port of fao_wapor_discharge.hydrology.calc_runoff
//
// A dependency-free ES module that runs the routed linear-reservoir model on the
// same inputs as the Python function and returns the same numbers, bit for bit.
// It is meant for running the model client side (in a browser) on PCP/AETI time
// series fetched from the zonal-stats tables, instead of in BigQuery
// (sql/calc_runoff.sql).
//
// Input and output are column-oriented "long" tables, one entry per basin per
// dekad, standing in for calc_runoff's DataFrame:
//
//   const out = calcRunoff(
//     { basin: [...], start: [...], pcp: [...], aeti: [...] },
//     routes,                       // as fao_sb_ids.json: {"id": [downstream, area_km2, ...]}
//     { fValues: { 1001001: 0.2 }, spinup: 2 },
//   );
//   // out: { basin, start, pcp, aeti, q, dS }, sorted by basin, then start
//
// - basin: SDG6_SB_ID; start: start_datetime as milliseconds since the epoch (UTC);
//   pcp, aeti: mm/day, NaN (or null) where missing.
// - Output in calc_runoff's "mixed_flux" units: pcp, aeti mm/day; q, dS m³/s.
//
// Where the result could drift from Python, this follows Python's semantics rather
// than JavaScript's (sql/calc_runoff.sql does not, and differs from Python there):
//
// * max(0.0, x) is Python's max: it returns 0.0 when x is NaN (Math.max would
//   return NaN). Rows with a missing PCP or AETI therefore empty the reservoir,
//   produce Q = 0 and ΔS = NaN, exactly as in Python.
// * Upstream inflow is summed the way pandas' groupby().sum() does it: Kahan
//   compensated summation, in ascending basin-id order, skipping NaN.
// * A basin without an area in `routes` uses 1e6 m² for the m³ conversion and gets
//   NaN PCP/AETI in the output (areas.get(bid, 1e6) vs. Series.map(areas)).
//
// Math.exp may differ from np.exp in the last bit. Neither is correctly rounded and
// np.exp itself differs between platforms, so for arbitrary f values the results
// can differ in the last bits (up to ~1e-11 relative where Q is a small difference
// of large storages). For the default f = 0.1 (exponents -0.08, -0.09, -0.1,
// -0.11) Math.exp, np.exp and the correctly rounded value coincide, and the results
// are identical. examples/verify_js_runoff.py checks this against the Python code.

const TERMINAL = new Set([-888, -999]);
export const DEFAULT_F = 0.1;

/** Python's max(a, b): a unless b > a (so max(0.0, NaN) is 0.0). */
function pyMax(a, b) {
  return b > a ? b : a;
}

/** _period_days: day 1/11 -> 10; day 21 -> days in the month - 20. */
function periodDays(ms) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  if (day === 1 || day === 11) return 10;
  if (day === 21) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - 20;
  throw new Error(`Unexpected start day ${day} in ${d.toISOString()}`);
}

/** Timestamp.replace(year=y), falling back to day 28 when the date doesn't exist. */
function replaceYear(ms, year) {
  const d = new Date(ms);
  const at = (day) =>
    Date.UTC(year, d.getUTCMonth(), day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  const candidate = at(d.getUTCDate());
  return new Date(candidate).getUTCMonth() === d.getUTCMonth() ? candidate : at(28);
}

const lookup = (mapping, key) =>
  mapping instanceof Map ? mapping.get(key) : mapping[key];

/**
 * Calculate routed runoff using a linear reservoir model (see calc_runoff).
 *
 * @param {{basin: ArrayLike<number>, start: ArrayLike<number>,
 *          pcp: ArrayLike<number|null>, aeti: ArrayLike<number|null>}} data
 * @param {Record<string, Array<unknown>>} routes  basin id -> [downstream_id, area_km2, ...];
 *   -888/-999 = terminal basin.
 * @param {{fValues?: Record<number, number> | Map<number, number>, spinup?: number}} [options]
 * @returns {{basin: number[], start: number[], pcp: Float64Array, aeti: Float64Array,
 *            q: Float64Array, dS: Float64Array}}
 */
export function calcRunoff(data, routes, { fValues = {}, spinup = 2 } = {}) {
  if (!Number.isInteger(spinup) || spinup < 1) throw new Error(`spinup must be a positive integer, not ${spinup}`);

  // df.sort_values(["SDG6_SB_ID", "start_datetime"])
  const n0 = data.basin.length;
  const sorted = Array.from({ length: n0 }, (_, i) => i).sort(
    (a, b) => data.basin[a] - data.basin[b] || data.start[a] - data.start[b],
  );
  const basinIds = [...new Set(sorted.map((i) => data.basin[i]))];

  // Areas from routes (km² -> m²); a missing or null area means none.
  const areas = new Map();
  for (const [src, val] of Object.entries(routes)) {
    if (Array.isArray(val) && val.length >= 2 && val[1] !== null && val[1] !== undefined) {
      areas.set(Number(src), val[1] * 1e6);
    }
  }

  // _topo_sort: upstream basins first.
  const idSet = new Set(basinIds);
  const downstream = new Map();
  const upstreamOf = new Map(basinIds.map((b) => [b, []]));
  const inDegree = new Map(basinIds.map((b) => [b, 0]));
  for (const [src, val] of Object.entries(routes)) {
    const id = Number(src);
    if (!idSet.has(id)) continue;
    const dst = Array.isArray(val) ? val[0] : val;
    if (TERMINAL.has(dst) || !idSet.has(dst)) {
      downstream.set(id, null);
    } else {
      downstream.set(id, dst);
      upstreamOf.get(dst).push(id);
      inDegree.set(dst, inDegree.get(dst) + 1);
    }
  }
  const order = basinIds.filter((b) => inDegree.get(b) === 0);
  for (let i = 0; i < order.length; i++) {
    const ds = downstream.get(order[i]);
    if (ds !== null && ds !== undefined) {
      inDegree.set(ds, inDegree.get(ds) - 1);
      if (inDegree.get(ds) === 0) order.push(ds);
    }
  }
  if (order.length !== basinIds.length) {
    const missing = basinIds.filter((b) => !order.includes(b));
    throw new Error(`Cycle detected or disconnected basins: ${missing.join(", ")}`);
  }

  // Restrict to dates present in ALL basins (intersection of per-basin date ranges).
  let rows = sorted;
  if (basinIds.length > 1) {
    const min = new Map();
    const max = new Map();
    for (const i of sorted) {
      const b = data.basin[i];
      const t = data.start[i];
      if (!(min.get(b) <= t)) min.set(b, t);
      if (!(max.get(b) >= t)) max.set(b, t);
    }
    const commonStart = Math.max(...min.values());
    const commonEnd = Math.min(...max.values());
    rows = sorted.filter((i) => data.start[i] >= commonStart && data.start[i] <= commonEnd);
  }

  const out = {
    basin: rows.map((i) => data.basin[i]),
    start: rows.map((i) => data.start[i]),
    pcp: new Float64Array(rows.length),
    aeti: new Float64Array(rows.length),
    q: new Float64Array(rows.length),
    dS: new Float64Array(rows.length),
  };
  if (rows.length === 0) return out;

  // Per-basin views of the (sorted) rows: offset, count and row by start time.
  const groups = new Map();
  for (let r = 0; r < rows.length; r++) {
    const b = out.basin[r];
    let g = groups.get(b);
    if (!g) groups.set(b, (g = { from: r, n: 0, byStart: new Map() }));
    g.byStart.set(out.start[r], r);
    g.n++;
  }
  const periodDaysOf = Int32Array.from(out.start, periodDays);
  const qin = new Float64Array(rows.length);
  const storage = new Float64Array(rows.length);
  const q = out.q;

  // _convert_inputs_to_m3: mm/day -> m³ per period (once, before any pass).
  const pcp = Float64Array.from(rows, (i) => data.pcp[i] ?? NaN);
  const aeti = Float64Array.from(rows, (i) => data.aeti[i] ?? NaN);
  for (const b of order) {
    const g = groups.get(b);
    if (!g) continue;
    const area = areas.has(b) ? areas.get(b) : 1e6;
    for (let r = g.from; r < g.from + g.n; r++) {
      pcp[r] = (pcp[r] * periodDaysOf[r] * area) / 1e3;
      aeti[r] = (aeti[r] * periodDaysOf[r] * area) / 1e3;
    }
  }

  // Warmup cutoff: the first date's calendar day in the last year whose such date
  // is still within the data.
  let first = Infinity;
  let last = -Infinity;
  for (const t of out.start) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const firstYear = new Date(first).getUTCFullYear();
  let targetYear = new Date(last).getUTCFullYear();
  let cutoff;
  for (;;) {
    cutoff = replaceYear(first, targetYear);
    if (cutoff <= last) break;
    targetYear -= 1;
    if (targetYear < firstYear) {
      cutoff = first;
      break;
    }
  }

  // Spinup passes: each warmup pass covers the rows before the cutoff, and its final
  // storage seeds the next pass; the last pass covers all rows.
  let s0 = new Map();
  for (let pass = 0; pass < spinup; pass++) {
    const isWarmup = pass < spinup - 1;
    qin.fill(0);
    storage.fill(0);
    q.fill(0);
    const finalStorage = new Map();

    for (const b of order) {
      const g = groups.get(b);
      if (!g) continue;
      const idx = [];
      for (let r = g.from; r < g.from + g.n; r++) {
        if (!isWarmup || out.start[r] < cutoff) idx.push(r);
      }
      if (idx.length === 0) continue;

      const fValue = lookup(fValues, b);
      const f = fValue === undefined ? DEFAULT_F : fValue;
      const k = f / 10.0;

      // Qin: upstream Q per time step, summed like pandas' groupby().sum() (Kahan
      // summation over the upstream rows in frame order, i.e. ascending basin id).
      const ups = upstreamOf
        .get(b)
        .filter((u) => groups.has(u))
        .sort((x, y) => x - y)
        .map((u) => groups.get(u));
      if (ups.length) {
        for (const r of idx) {
          let sum = 0.0;
          let compensation = 0.0;
          for (const gu of ups) {
            const j = gu.byStart.get(out.start[r]);
            if (j === undefined) continue;
            const val = q[j];
            if (Number.isNaN(val)) continue;
            const y = val - compensation;
            const t = sum + y;
            compensation = t - sum - y;
            if (Number.isNaN(compensation)) compensation = 0.0;
            sum = t;
          }
          qin[r] = sum;
        }
      }

      let sPrev = s0.has(b) ? s0.get(b) : 0.0;
      for (const r of idx) {
        const balance = qin[r] + pcp[r] - aeti[r];
        const dt = periodDaysOf[r];
        const R = balance / dt;
        let sEnd;
        if (k > 0) {
          const ekdt = Math.exp(-k * dt);
          sEnd = sPrev * ekdt + (R / k) * (1.0 - ekdt);
        } else {
          sEnd = sPrev + balance;
        }
        sEnd = pyMax(0.0, sEnd);
        storage[r] = sEnd;
        q[r] = pyMax(0.0, sPrev + balance - sEnd);
        sPrev = sEnd;
      }
      finalStorage.set(b, storage[idx[idx.length - 1]]);
    }
    if (isWarmup) s0 = finalStorage;
  }

  // _to_mixed_flux: PCP, AETI m³ -> mm/day; Q, ΔS m³ -> m³/s.
  for (let r = 0; r < rows.length; r++) {
    const area = areas.has(out.basin[r]) ? areas.get(out.basin[r]) : NaN;
    const days = periodDaysOf[r];
    const periodS = days * 86400;
    const deltaS = qin[r] + pcp[r] - aeti[r] - q[r];
    out.pcp[r] = ((pcp[r] / area) * 1e3) / days;
    out.aeti[r] = ((aeti[r] / area) * 1e3) / days;
    q[r] = q[r] / periodS;
    out.dS[r] = deltaS / periodS;
  }
  return out;
}
