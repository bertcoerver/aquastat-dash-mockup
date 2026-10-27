# FAO Water Portal: multi-variable maps for the charts

Companion to [waterportal-plot-inventory.md](waterportal-plot-inventory.md). That inventory gave each chart one map, because a map could show only one variable. The water-portal app now draws several layers at once, so this file suggests, for each chart, **which variables to show together** and lists some **new charts** built on combined variables.

Chart IDs (WR1, MB6, …) are the inventory's. The app's card id is given where the app implements that chart (`src/country/cards.ts`, `src/basin/stats-cards.ts`).

> **Status (27 Oct 2026): built in `water-portal`.** All the combinations below and the 13 new charts are in the app, along with capabilities A–G. The app differs from this plan in these places:
> - **B3** (rain → flow) extends the existing hydrograph card (`Q-dekads`): the rain hangs above the discharge, instead of being a separate card.
> - **B5** (transpiration share) is computed from WaPOR's T and AETI grids over the selected basin, because there are no zonal statistics of T. Cells on sub-basin edges are left out.
> - **N5** (water per irrigated hectare) only ranks countries that irrigate at least 50,000 ha. Below that, the ratio is dominated by livestock and fish farms (Finland and Latvia topped the list).
> - **MB7, MB8, MB12, SB3** are new or reworked sub-basin cards: `aeti-sub`, `pcp-sub`, `ratio-sub`, `Q-sub`. **SB5–SB7** (global sub-basin rankings) are still not in the app.
> - **WR6/IR6:** the cropland card's main map is now cropland per person (the original chart's line). The share of cropland equipped for irrigation is no longer a map of its own.

## What a map can hold now

| View | Slots (one map each) | Notes |
|---|---|---|
| Country | **Fill** · **Circles** · **3D bars** | Fills: ramp, classes or categories. Circles and bars use the map's own colours, or green/red by sign for diverging values. Amounts are drawn as circles or bars. |
| Basin | **Fill** · **Circles** · **3D bars** · **Lines** (discharge network or particles) · **Rain** (PCP) · **Vapour** (AETI, green = transpiration) | Lines, rain and vapour only appear at sub-basin level, with a major basin selected. Storage-change circles and bars stand on the rivers. |

Marks used below:
- ✅ every layer exists today. The card only has to ask for more than one (see capability **A**).
- ➕ needs a new variable, a derived value or a capability (listed at the end).

## Recipes

Most of the suggestions follow one of these five patterns:

1. **Intensity × amount.** The fill shows a rate, share or class, and circles show a volume or area. Example: water stress classes with circles for withdrawal volume. This separates "bad but small" from "bad and big", which is the main weakness of a choropleth.
2. **Pressure × resource.** Show what is used on top of what is available, e.g. withdrawal circles over a Falkenmark fill.
3. **Level × change.** The fill shows the current value, and green/red circles or bars show the change since 2015 (Country) or the anomaly against other years (Basin).
4. **Cause × effect.** For example, a P − AETI fill under the discharge network, or an evaporative-index fill with storage change on the rivers.
5. **The water balance terms together.** P − AETI, Q and ΔS on one map, so it is clear whether they add up.

Bars tilt the map, so use them only for a third layer or a signed change, not as the main layer.

---

## 1. Country domain: existing charts

### 1.1 Water resources

| Chart (app card) | Fill | Circles | Bars | What the combination shows |
|---|---|---|---|---|
| **WR1** TRWR per capita per region (`wr-regions`) | ✅ Renewable water per person (Falkenmark) | ✅ Population | ➕ % change in TRWR per person since 2015 (signed) | Why per-capita water falls: large populations sit on the red classes, and the bars show where the decline is fastest. |
| **WR2** Least renewable water per person (`wr-lowest`) | ✅ Falkenmark, only < 500 m³ shown | ➕ Desalinated + reused water (cross-topic) | — | How the scarcest countries cope. Large non-conventional circles appear on the Gulf states and none in the Sahel. |
| **WR3** Internal vs external (`wr-origin`) | ✅ Dependency ratio | ✅ External inflow volume (`ext`) | — | Dependency that matters in volume (Egypt, Hungary, Pakistan) versus high percentages on small inflows. |
| **WR4** Surface vs groundwater (`wr-source`) | ✅ Groundwater % of TRWR | ➕ Fresh groundwater withdrawal (cross-topic) | — | Where aquifers are both a large part of the resource and heavily pumped. |
| **WR5** TRWR per capita over time (`wr-trend`) | ✅ Falkenmark | ✅ Population | — | During playback the circles grow while the colours shift towards scarcity. This is the clearest playback story in the Country view. |
| Tile: Dam capacity (`t-dam`) | ➕ Dam capacity as % of TRWR | ✅ Dam capacity | — | Storage relative to the resource. A large dam stock means more where water is scarce. |

### 1.2 Water use

| Chart (app card) | Fill | Circles | Bars | What the combination shows |
|---|---|---|---|---|
| **WU1** Freshwater withdrawal per region (`wu-volume`) | ➕ Water stress classes (cross-topic) | ✅ Freshwater withdrawal | — | Big withdrawals under high stress (India, Pakistan, Iran) versus big withdrawals with water to spare (USA, Brazil). |
| **WU2** Withdrawal per person per region (`wu-per-person`) | ✅ Withdrawal per person | ✅ Total withdrawal | — | Per person × people = total. North America is high per person, and India is a large circle at a modest rate. |
| **WU3 / WU6** By sector (`wu-sectors`) | ✅ Dominant sector (categories, paler when the share is smaller) | ✅ Total withdrawal | ➕ or pie circles | Dominance weighted by volume, so the agricultural belt from Egypt to China stands out. Pie circles (capability **C**) would show all three shares. |
| **WU4 / WU7** By source (`wu-source`, tile `t-gw`) | ✅ Groundwater % of withdrawal | ➕ Fresh groundwater withdrawal | — | The large groundwater users (India, USA, China, Pakistan, Iran) next to countries that are groundwater-reliant but small. |
| **WU5** Non-conventional water (`wu-nonconventional`) | ➕ Water stress classes | ✅ Desalinated + reused | ➕ or pies: desal vs reuse | Non-conventional water is used where stress is critical. Pies would separate desalination (Gulf) from reuse (Israel, Spain, USA). |
| **WU8** Withdrawal per person over time (`wu-trend`) | ✅ Hovered series per person (`twpc`/`awpc`/`iwpc`/`mwpc`) | ➕ That sector's volume (`aw`/`iw`/`mw`) | — | Hovering a sector maps its intensity and its volume together. |

### 1.3 Irrigation

| Chart (app card) | Fill | Circles | Bars | What the combination shows |
|---|---|---|---|---|
| **IR1** Largest full-control areas (`ir-top`) | ➕ Agriculture's contribution to water stress (cross-topic) | ✅ Full-control area, top 10 ringed | — | Which big irrigators are also the ones whose irrigation stresses their water. Alternative fill: ✅ % of cultivated area equipped. |
| **IR2** Irrigation methods (`ir-method`) | ✅ % sprinkler or drip | ➕ Full-control area | ➕ or pies by method | Large surface-irrigated areas (South Asia) next to small, modernised ones (Israel, Spain). |
| **IR3** % of cultivated area equipped (`ir-cultivated`) | ✅ % cultivated equipped | ➕ Area equipped (`aei`) | — | Intensity versus extent, time-synced. |
| **IR4** By water source (`ir-source`) | ✅ % irrigated with groundwater | ✅ Area equipped (`aei`) | — | How many hectares depend on aquifers, not just the share. |
| **IR5** Equipped area actually irrigated (`ir-actual`) | ✅ % actually irrigated | ➕ Idle equipped area (`aei − aai`) | — | The share is low in many small countries. The circles show where the idle hectares actually are. |
| **IR6** Cropland vs irrigation (`ir-cropland`) | ➕ Cropland per person (`crop / pop`, the chart's own line) | ✅ Cropland area | ✅ Area equipped (`aei`) | All three series of the original chart on one map: land per person, land, and the irrigated part of it. |

### 1.4 SDG 6.4

| Chart (app card) | Fill | Circles | Bars | What the combination shows |
|---|---|---|---|---|
| **SDG1** Water stress per region (`sdg-stress-regions`) | ✅ Water stress classes | ✅ Population | — | How many people live under high or critical stress, not just where it is. |
| **SDG2** Highest water stress (`sdg-stress-top`) | ✅ Stress ≥ 75 % only | ✅ Total withdrawal | — | Most critical countries are small in volume. A few (Pakistan, Egypt, Iran, Saudi Arabia) dominate the stressed water. |
| **SDG3** Causes of water stress (`sdg-stress-sectors`) | ✅ Dominant sector (from Water use) | — | ✅ Water stress, coloured by its classes | Sector on the ground and stress as height. Hovering a sector can switch the bars to that sector's contribution. |
| **SDG4** Water stress over time (`sdg-stress-trend`) | ✅ Water stress classes | — | ➕ Change since 2015, in percentage points (signed) | Level × change: rising stress (red bars) in countries that are already orange or red. |
| **SDG5** WUE per region (`sdg-wue-regions`) | ✅ WUE (log) | ✅ Total withdrawal | — | Where efficiency gains would move the most water: large circles on pale purple. |
| **SDG6** Agricultural WUE (no card yet; part of `sdg-wue-sectors`) | ✅ Irrigated-agriculture WUE | ➕ Agricultural withdrawal | — | The same message for agriculture. |
| **SDG7** WUE by sector (`sdg-wue-sectors`) | ✅ Hovered sector's WUE | ➕ That sector's withdrawal (`iawue → aw`, `iwue → iw`, `swue → mw`) | — | Efficiency and volume per sector. |
| **SDG8** WUE since 2015 (`sdg-wue-change`) | ✅ Water stress classes | ✅ WUE change since 2015 (green/red) | — | This is the core of SDG 6.4 on one map: whether stressed countries are becoming more efficient. Today the map shows the change alone. |

---

## 2. Basin domain: existing charts

The app has reworked these charts (topics: Rain and evaporation · Water left · Discharge), so the app card is given where it covers the chart. "World" means no basin is selected (major-basin level). "Basin" means a major basin is selected (sub-basin level, where lines, rain and vapour are available).

| Chart (app card) | Level | Layers | What the combination shows |
|---|---|---|---|
| **MB1 / MB2** Wettest and driest, P − AET (`balance-rank-ends`) | World | ✅ Fill P − AETI · ✅ Circles Q at outlets · ✅ Bars ΔS (signed) | **The water balance on one map.** Surplus basins should discharge it or store it. Where they don't, the model or the data disagree. |
| **MB3** Highest AET (`aeti-climate`, `aeti-years`) | World | ✅ Fill AETI · ➕ Circles AETI anomaly (signed) | Level × change: high-ET basins and whether this period is above normal. Needs capability **E**. |
| **MB4** Share of global precipitation volume | World | ➕ Circles PCP in km³ · ✅ Fill PCP anomaly (%) | Where the rain falls in volume, and where this period is unusually wet or dry. Needs capability **F** (km³ circles over a % fill). |
| **MB5** Global monthly cycle (`monthly`, no basin) | World | ✅ Fill P − AETI · ➕ month sync | The seasons playing across the basins. |
| **MB6** Sub-basins, P − AET (`balance-sub`) | Basin | ✅ Fill P − AETI · ✅ Lines discharge network | Where the surplus is generated and where it flows. Hovering a sub-basin already shades everything upstream. |
| **MB7** Highest-AET sub-basins (`aeti-*` with a basin) | Basin | ✅ Vapour (AETI, green = T) · ✅ Fill evaporative index · ✅ Lines network | High ET fed by the river: Gezira and the Nile delta show ratio > 100 % beside a thick line, with green vapour (crops). |
| **MB8** Share of the basin's precipitation | Basin | ✅ Rain · ✅ Fill PCP anomaly | Where it rains and whether that is more or less than usual. ➕ km³ circles once capability **F** exists. |
| **MB9** Basin monthly cycle (`monthly`) | Basin | ✅ Rain · ✅ Vapour · ✅ Fill P − AETI · ➕ month sync | **The showpiece:** the vertical water balance animated through the year, all with existing layers. |
| **MB12** P vs AET scatter (`ratio-rank-ends` / `ratio-climate`) | Basin | ✅ Fill evaporative index · ✅ Lines Q · ✅ Circles ΔS on the rivers | Where does the extra evaporation (ratio > 100 %) come from: the river (thick lines) or storage (red circles)? |
| **SB1** Sub-basin precipitation (`pcp-years`) | Basin | ✅ Rain · ✅ Fill PCP anomaly | The period's rain and how it compares with other years. |
| **SB2** Sub-basin ET (`aeti-years`) | Basin | ✅ Vapour · ✅ Fill AETI anomaly | The same for ET. The vapour's green share adds the transpiration split. |
| **SB3** Discharge (`Q-dekads`, `Q-years`, `Q-sub`) | Basin | ✅ Particles Q · ✅ Fill PCP anomaly | Flow explained by its cause: a weak flood under a dry upstream. |
| **SB4** Storage change (`dS-years`) | Basin | ✅ Circles ΔS on the rivers · ✅ Fill P − AETI anomaly | Storage falls where the surplus fell short of normal. |
| **SB5 / SB6** Global wettest and driest sub-basins | — | Not in the app (sub-basin rankings are only inside a selected basin). With capability **F** they would follow MB1/MB2's three-layer map. | |
| **SB7** Highest global sub-basin AET | — | Not in the app. | |

---

## 3. New multi-variable charts

Each new chart is designed together with its map, so that the map shows the same combination as the chart.

### Country

| # | Chart | Variables | Map | Why |
|---|---|---|---|---|
| **N1** | **Scarcity vs stress scatter:** one dot per country, x = renewable water per person (log), y = water stress (log), size = population, colour = region. Hover a dot to ring the country. | trwrpc, ws, pop | ➕ Fill with 4 categories: *scarce & stressed* · *stressed, not scarce* (over-use) · *scarce, not stressed* · *neither* (the existing `categories` style can draw it) · ✅ Circles population | Separates two kinds of problem: having little water versus using too much of it. |
| **N2** | **SDG 6.4.1 × 6.4.2 quadrant:** x = WUE (log), y = water stress, size = withdrawal, an arrow from 2015 to now. | wue, ws, tww | ✅ Fill water stress · ✅ Circles WUE change (green/red) | The SDG 6.4 target ("increase efficiency, reduce stress") as one picture. It shares its map with SDG8. |
| **N3** | **Groundwater pressure ranking:** groundwater withdrawal as % of renewable groundwater, top 15. | fgw, rgw | ➕ Fill fgw / rgw (classes as for stress: < 25 / 50 / 75 / 100 / > 100 %) · ✅ Circles groundwater withdrawal | A widely used depletion signal, derived from AQUASTAT variables the app already loads. |
| **N4** | **Water supply mix per region (100 % stacked):** surface · groundwater · desalinated · reused. | fsw, fgw, desal, reuse | ✅ Fill groundwater % · ✅ Circles non-conventional · ➕ or pies (capability **C**) | Combines WU4 and WU5 into the full supply picture. |
| **N5** | **Water per irrigated hectare:** agricultural withdrawal ÷ area actually irrigated (m³/ha), ranked, with irrigated-agriculture WUE alongside. | aw, aai, iawue | ➕ Fill m³/ha · ✅ Circles area actually irrigated | Combines the Water use, Irrigation and SDG tabs. Where a lot of water goes onto each hectare, and over how many hectares. |
| **N6** | **Storage vs resource:** dam capacity as % of TRWR (bar), per region and top countries. | dam, trwr | ➕ Fill storage ratio · ✅ Circles dam capacity | How well a country can buffer variability. Pairs with the dependency ratio for transboundary countries. |
| **N7** | **What drove the change since 2015 (diverging bars per country or region):** % change in population, withdrawal, withdrawal per person and TRWR per person. | pop, tww, twpc, trwrpc | ✅ Fill change in water stress · ✅ Bars change in withdrawal (signed) | Shows whether stress rose because of more people, more use per person, or less water. |

### Basin

| # | Chart | Variables | Map | Why |
|---|---|---|---|---|
| **B1** | **Water balance closure:** per basin (or group), P − AETI next to Q + ΔS, as a stacked bar with the residual shown. | pcp, aeti, Q, dS | ✅ Fill P − AETI · ✅ Circles Q · ✅ Bars ΔS. With a basin selected: lines instead of circles, and ΔS on the rivers. | The model's core equation, shown in both the chart and the map. It also works as a quality check (large residuals stand out). |
| **B2** | **Drought / heat quadrant:** one dot per major basin, x = PCP anomaly (%), y = AETI anomaly (%), size = basin area, colour = climate group. | pcp, aeti anomalies | ✅ Fill PCP anomaly · ➕ Circles AETI anomaly (signed) | Separates dry periods from hot (high-ET) ones, and both together. |
| **B3** | **Rain → flow response:** for the selected basin, precipitation per dekad as bars hanging from the top (a hyetograph) over the hydrograph of Q, with the other years' averages. | pcp, Q | ✅ Rain + ✅ Particles, ➕ synced to the dekad hovered | A familiar hydrology chart that connects the rain and river animations already on the map. |
| **B4** | **Upstream → downstream profile:** sub-basins along the main stem in flow order. Lines: cumulative P − AETI and Q. Bars: each sub-basin's ΔS. | balance, Q, dS | ✅ Lines network · ✅ Fill P − AETI · hovering a point highlights that sub-basin and everything upstream (exists) | Where the river gains and loses water, such as the Nile losing in the Sudd and through Egyptian irrigation. |
| **B5** | **Beneficial ET:** T ÷ AETI per sub-basin (bars), next to AETI. | T, aeti | ✅ Vapour (already green = T) · ➕ Fill T / AETI | Productive versus non-productive water use. Needs T zonal stats per sub-basin (today T is only read on the grid). |
| **B6** | **Monthly regime heatmap:** month × year grid of P − AETI for the selected basin. Click a cell to set the range. | balance | ✅ Fill P − AETI · ✅ Rain + Vapour for that month | Seasonality and inter-annual change at a glance, and a fast way to pick a period for the map. |

---

## 4. Capabilities this needs

| | Capability | Needed by | Effort |
|---|---|---|---|
| **A** | **A card's map is a set of layers.** `map()` returns `{ fill?, circles?, bars?, lines?, rain?, vapour? }` instead of one spec. Previewing or pinning puts each layer in its slot, and the reader can still uncheck or switch them. | Every ✅ above | Core change in `country-panel.ts` / `basin-stats.ts`. Everything else builds on it. |
| **B** | **Cross-topic variables (Country).** A card can use another topic's variables (e.g. `ws` in Water use, `desal` in Water resources). Load the other topic too, or add the variables to `TOPIC_VARS`. | WR2, WR4, WU1, WU5, IR1, N3–N7 | Small: one more query or a few extra variables. |
| **C** | **Pie circles:** a circle split into parts (sectors, sources, methods). | WU3, WU5, IR2, N4 (optional elsewhere) | Medium: a new circle style. Size = total and slices = shares. |
| **D** | **Derived values:** change since 2015 for any variable (signed), ratios (fgw/rgw, dam/trwr, crop/pop, aw/aai, aei − aai), quadrant categories. | WR1, SDG4, IR5, IR6, N1, N3, N5–N7 | Small: same pattern as `shareMap` / the WUE change. |
| **E** | **Value and anomaly of the same measure at once (Basin).** Today both have the same title, which is the key for the checklist and the shape. | MB3, B2 | Small: give the anomaly its own title or key. |
| **F** | **Per-map units (Basin).** `BasinCtx.units` applies to the whole view, so a km³ circle can't sit over an mm fill. | MB4, MB8, SB5/SB6 | Medium. |
| **G** | **Month and dekad sync** from a chart to the map's range. | MB5, MB9, B3, B6 | Already suggested in the inventory. |

## 5. Where to start

1. **A + B**, then the five Country combinations that only need them: **SDG8** (stress × WUE change), **WU1** (withdrawal × stress), **SDG1** (stress × population), **WR1/WR5** (Falkenmark × population, during playback) and **WR3** (dependency × inflow volume).
2. **Basin, no new data:** **MB9** (rain + vapour + P − AETI), **MB12** (evaporative index + network + ΔS) and **MB1/B1** (the water balance terms together).
3. Then **N1** and **N2**: one scatter each for the two SDG 6.4 questions, sharing their maps with SDG1 and SDG8.
