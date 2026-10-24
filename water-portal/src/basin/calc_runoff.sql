-- calc_runoff.sql — BigQuery replica of fao_wapor_discharge.hydrology.calc_runoff
--
-- Solves ONE outlet network per call. The clamped linear-reservoir recurrence
-- (max(0, ...) on storage and outflow) has no closed form expressible with
-- window functions, and downstream inflow at timestep t depends on upstream
-- outflow at the same t, so the model is ported verbatim into a JavaScript
-- temp UDF that runs once over the whole network's timeseries.
--
-- Placeholders (substitute before running; the FAO proxy takes raw SQL text):
--   {{ROUTES_TABLE}}   fully-qualified routes table, schema as produced by
--                      sql/stage_routes_table.py:
--                      FAO_SB_ID INT64, downstream_id INT64, area_km2 FLOAT64,
--                      name STRING, OUTLET_SB_ID INT64, f_value FLOAT64
--   {{OUTLET_SB_ID}}   outlet id selecting the network (integer literal)
--   {{SPINUP}}         number of model passes (calc_runoff default: 2)
--
-- Output columns per basin per dekad, in calc_runoff's "mixed_flux" units:
--   PCP, AETI mm/day; Q, delta_S m3/s; S (end-of-period storage) m3.
--
-- Caveats:
-- * Results are identical to the Python function to float64 precision;
--   Math.exp vs numpy.exp may differ in the last ULP, so expect agreement to
--   ~1e-12 relative rather than guaranteed bit-for-bit equality.
-- * JS UDFs cap output at ~5 MB per row; very large networks (thousands of
--   basin-dekad rows in one network) may need the output struct trimmed.
-- * INT64 is not a legal JS-UDF type, so ids travel as FLOAT64 (exact for
--   these id magnitudes) and are cast back outside the UDF.

CREATE TEMP FUNCTION solve_network(
  data ARRAY<STRUCT<basin FLOAT64, dt TIMESTAMP, pcp FLOAT64, aeti FLOAT64>>,
  routes ARRAY<STRUCT<basin FLOAT64, downstream FLOAT64, area_km2 FLOAT64, f FLOAT64>>,
  spinup FLOAT64
)
RETURNS ARRAY<STRUCT<
  basin FLOAT64, dt TIMESTAMP,
  pcp FLOAT64, aeti FLOAT64, q FLOAT64, delta_s FLOAT64, s FLOAT64
>>
LANGUAGE js AS r"""
'use strict';
// Line-by-line port of fao_wapor_discharge.hydrology (_run_model + _to_mixed_flux).
var TERMINAL = new Set([-888, -999]);
var DEFAULT_F = 0.1;

if (!data || data.length === 0) return [];

// _period_days: day 1/11 -> 10; day 21 -> days-in-month - 20.
function periodDays(d) {
  var day = d.getUTCDate();
  if (day === 1 || day === 11) return 10;
  if (day === 21) {
    var dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return dim - 20;
  }
  throw new Error('Unexpected start day ' + day + ' in ' + d.toISOString());
}

// df.sort_values(["SDG6_SB_ID", "start_datetime"])
var rows = data.slice().sort(function (a, b) {
  return (a.basin - b.basin) || (a.dt - b.dt);
});

// Routes: areas (km2 -> m2), f per basin, raw downstream links.
var areas = {};
var fMap = {};
var downstreamRaw = {};
for (var ri = 0; ri < routes.length; ri++) {
  var r = routes[ri];
  if (r.area_km2 !== null && r.area_km2 !== undefined) areas[r.basin] = r.area_km2 * 1e6;
  if (r.f !== null && r.f !== undefined) fMap[r.basin] = r.f;
  downstreamRaw[r.basin] = (r.downstream === null || r.downstream === undefined)
    ? -999 : r.downstream;
}

// _topo_sort restricted to basins present in the data (Kahn's algorithm).
var idSet = new Set();
var basinIds = [];
for (var i = 0; i < rows.length; i++) {
  if (!idSet.has(rows[i].basin)) { idSet.add(rows[i].basin); basinIds.push(rows[i].basin); }
}
var upstreamOf = {}, inDegree = {}, downstream = {};
basinIds.forEach(function (b) { upstreamOf[b] = []; inDegree[b] = 0; });
Object.keys(downstreamRaw).forEach(function (srcStr) {
  var src = Number(srcStr);
  if (!idSet.has(src)) return;
  var dst = downstreamRaw[srcStr];
  if (TERMINAL.has(dst) || !idSet.has(dst)) {
    downstream[src] = null;
  } else {
    downstream[src] = dst;
    upstreamOf[dst].push(src);
    inDegree[dst] += 1;
  }
});
var queue = basinIds.filter(function (b) { return inDegree[b] === 0; });
var order = [];
var qhead = 0;
while (qhead < queue.length) {
  var bid = queue[qhead++];
  order.push(bid);
  var ds = downstream[bid];
  if (ds !== null && ds !== undefined) {
    inDegree[ds] -= 1;
    if (inDegree[ds] === 0) queue.push(ds);
  }
}
if (order.length !== basinIds.length) {
  throw new Error('Cycle detected or disconnected basins');
}

// Restrict to dates present in ALL basins (intersection of per-basin ranges).
var work = rows;
if (basinIds.length > 1) {
  var mins = {}, maxs = {};
  for (var i = 0; i < rows.length; i++) {
    var b = rows[i].basin, t = rows[i].dt.getTime();
    if (!(b in mins) || t < mins[b]) mins[b] = t;
    if (!(b in maxs) || t > maxs[b]) maxs[b] = t;
  }
  var commonStart = -Infinity, commonEnd = Infinity;
  basinIds.forEach(function (b) {
    if (mins[b] > commonStart) commonStart = mins[b];
    if (maxs[b] < commonEnd) commonEnd = maxs[b];
  });
  work = rows.filter(function (r) {
    var t = r.dt.getTime();
    return t >= commonStart && t <= commonEnd;
  });
}

// Per-basin column store (work is already sorted by basin, then dt).
var perBasin = {};
basinIds.forEach(function (b) {
  perBasin[b] = { dt: [], epoch: [], pd: [], pcp: [], aeti: [], byEpoch: new Map() };
});
for (var i = 0; i < work.length; i++) {
  var g = perBasin[work[i].basin];
  var ep = work[i].dt.getTime();
  g.byEpoch.set(ep, g.dt.length);
  g.dt.push(work[i].dt);
  g.epoch.push(ep);
  g.pd.push(periodDays(work[i].dt));
  g.pcp.push(work[i].pcp);
  g.aeti.push(work[i].aeti);
}
basinIds.forEach(function (b) {
  var g = perBasin[b];
  g.n = g.dt.length;
  g.q = new Float64Array(g.n);
  g.s = new Float64Array(g.n);
  g.qin = new Float64Array(g.n);
});

// _convert_inputs_to_m3: mm/day -> m3 per period (once, before any pass).
basinIds.forEach(function (b) {
  var g = perBasin[b];
  var area = (b in areas) ? areas[b] : 1e6;
  for (var t = 0; t < g.n; t++) {
    g.pcp[t] = g.pcp[t] * g.pd[t] * area / 1e3;
    g.aeti[t] = g.aeti[t] * g.pd[t] * area / 1e3;
  }
});

// Warmup cutoff: first date's calendar day in the latest year <= last date
// (Feb-29 -> Feb-28 fallback, mirroring datetime.replace's ValueError path).
var firstMs = Infinity, lastMs = -Infinity;
for (var i = 0; i < work.length; i++) {
  var t = work[i].dt.getTime();
  if (t < firstMs) firstMs = t;
  if (t > lastMs) lastMs = t;
}
var first = new Date(firstMs);
function replaceYear(d, y) {
  var m = d.getUTCMonth(), day = d.getUTCDate();
  var cand = new Date(Date.UTC(y, m, day, d.getUTCHours(), d.getUTCMinutes(),
                               d.getUTCSeconds(), d.getUTCMilliseconds()));
  if (cand.getUTCMonth() !== m) {
    cand = new Date(Date.UTC(y, m, 28, d.getUTCHours(), d.getUTCMinutes(),
                             d.getUTCSeconds(), d.getUTCMilliseconds()));
  }
  return cand;
}
var targetYear = new Date(lastMs).getUTCFullYear();
var cutoffMs;
while (true) {
  var c = replaceYear(first, targetYear).getTime();
  if (c <= lastMs) { cutoffMs = c; break; }
  targetYear -= 1;
  if (targetYear < first.getUTCFullYear()) { cutoffMs = firstMs; break; }
}

// Spinup passes: warmup passes on rows < cutoff seed the next pass's storage.
var spin = Math.trunc(spinup);
var s0 = {};
for (var p = 0; p < spin; p++) {
  var isWarmup = p < spin - 1;
  basinIds.forEach(function (b) {
    perBasin[b].q.fill(0); perBasin[b].s.fill(0); perBasin[b].qin.fill(0);
  });
  var finalStorage = {};
  for (var oi = 0; oi < order.length; oi++) {
    var bid = order[oi];
    var g = perBasin[bid];
    var idx = [];
    for (var t = 0; t < g.n; t++) {
      if (!isWarmup || g.epoch[t] < cutoffMs) idx.push(t);
    }
    if (idx.length === 0) continue;

    var f = (bid in fMap) ? fMap[bid] : DEFAULT_F;
    var k = f / 10.0;
    // Ascending-id order matches pandas' groupby summation row order.
    var ups = upstreamOf[bid].slice().sort(function (a, b) { return a - b; });

    var sPrev = (bid in s0) ? s0[bid] : 0.0;
    var lastT = -1;
    for (var ii = 0; ii < idx.length; ii++) {
      var t = idx[ii];
      var qin = 0.0;
      for (var ui = 0; ui < ups.length; ui++) {
        var gu = perBasin[ups[ui]];
        var j = gu.byEpoch.get(g.epoch[t]);
        if (j !== undefined) qin += gu.q[j];
      }
      var balance = qin + g.pcp[t] - g.aeti[t];
      var dt = g.pd[t];
      var R = balance / dt;
      var sEnd;
      if (k > 0) {
        var ekdt = Math.exp(-k * dt);
        sEnd = sPrev * ekdt + (R / k) * (1.0 - ekdt);
      } else {
        sEnd = sPrev + balance;
      }
      sEnd = Math.max(0.0, sEnd);
      g.s[t] = sEnd;
      g.q[t] = Math.max(0.0, sPrev + balance - sEnd);
      g.qin[t] = qin;
      sPrev = sEnd;
      lastT = t;
    }
    finalStorage[bid] = g.s[lastT];
  }
  if (isWarmup) s0 = finalStorage;
}

// _to_mixed_flux: PCP/AETI back to mm/day; Q, dS to m3/s; S stays in m3.
var out = [];
basinIds.forEach(function (b) {
  var g = perBasin[b];
  var area = (b in areas) ? areas[b] : 1e6;
  for (var t = 0; t < g.n; t++) {
    var pd = g.pd[t];
    var periodS = pd * 86400;
    out.push({
      basin: b,
      dt: g.dt[t],
      pcp: g.pcp[t] / area * 1e3 / pd,
      aeti: g.aeti[t] / area * 1e3 / pd,
      q: g.q[t] / periodS,
      delta_s: (g.qin[t] + g.pcp[t] - g.aeti[t] - g.q[t]) / periodS,
      s: g.s[t],
    });
  }
});
return out;
""";

WITH net_routes AS (
  -- ROUTES_SOURCE_BEGIN (examples/verify_sql_runoff.py swaps this block for an
  -- inline literal when no routes table has been staged yet)
  SELECT
    CAST(FAO_SB_ID AS FLOAT64) AS basin,
    CAST(downstream_id AS FLOAT64) AS downstream,
    CAST(area_km2 AS FLOAT64) AS area_km2,
    CAST(f_value AS FLOAT64) AS f
  FROM `{{ROUTES_TABLE}}`
  WHERE OUTLET_SB_ID = {{OUTLET_SB_ID}}
  -- ROUTES_SOURCE_END
),

-- Inner join of the two zonal-stats tables, mirroring pipeline._combine.
ts AS (
  SELECT
    CAST(p.FAO_SB_ID AS FLOAT64) AS basin,
    p.start_datetime AS dt,
    p.mean AS pcp,
    a.mean AS aeti
  FROM `fao-maps-review.zonal_stats_openEO.L1-PCP-D_HYDRO_SUB_BASIN_V2` AS p
  JOIN `fao-maps-review.zonal_stats_openEO.L1-AETI-D_HYDRO_SUB_BASIN_V2` AS a
    ON a.FAO_SB_ID = p.FAO_SB_ID AND a.start_datetime = p.start_datetime
  WHERE CAST(p.FAO_SB_ID AS FLOAT64) IN (SELECT basin FROM net_routes)
)

SELECT
  CAST(res.basin AS INT64) AS FAO_SB_ID,
  {{OUTLET_SB_ID}} AS OUTLET_SB_ID,
  res.dt AS start_datetime,
  res.pcp AS PCP,
  res.aeti AS AETI,
  res.q AS Q,
  res.delta_s AS delta_S,
  res.s AS S
FROM UNNEST(solve_network(
  (SELECT ARRAY_AGG(STRUCT(basin, dt, pcp, aeti) ORDER BY basin, dt) FROM ts),
  (SELECT ARRAY_AGG(STRUCT(basin, downstream, area_km2, f) ORDER BY basin) FROM net_routes),
  {{SPINUP}}
)) AS res
ORDER BY FAO_SB_ID, start_datetime
