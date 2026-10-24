# FAO Water Portal (review) — inventory of graphs/plots

Source: https://waterportal.review.fao.org (snapshot 2026-10-24).
The site is a TerriaJS map app. Everything below was read from its catalog config
(`/init/water-portal.json`, `/init/country.json`, `/init/basin.json`, `/init/local.json`),
the click-popup templates (`/data/templates/*.tmpl.html`) and the JS bundle (`build/6.TerriaMap.js`).
It was not checked by clicking through a rendered browser session.

## How the site is organised

| Level | What it is |
|---|---|
| **Domain** (top switch) | `Country` (default) · `Basin` · `Local` |
| **Tab** (pinned group) | Country: Water resources · Water use · Irrigation · **SDG 6.4** (default tab). Basin: Major Basins · Sub-basins · Rivers (hidden). Local: Climate · Biomass Production · Infrastructure (each holding sub-layers) |
| **Map** | Each tab has one main map layer (a choropleth or raster) with a style picker, plus "compare" layers (IPC, ESA WorldCover, GLW4 livestock, WorldPop) |
| **Dashboard panel** | KPI banners + charts. Each chart is shown either in the **World** view (no selection) or the **Selected** view (a country/basin is picked), controlled by `showOnWorld` / `showOnCountry` / `showOnMajorBasinPicked` |

**Data API.** Every dashboard chart fetches `/waterportal?key=<endpoint>&…` (a relative URL; I couldn't find the backend host. That path on the review host just returns the app HTML). There are two kinds of endpoint:
- `key=snapshot&country=&year=&variables=…`: values of the named AQUASTAT variables for one country and year (used by banners and pies).
- `key=multivariateTimeseries&country=&year=&fromYear=&variables=…`: a time series of the named AQUASTAT variables for one country.
- Named aggregate keys (e.g. `trwrpcRegional`, `waterStressPerRegion`): precomputed regional or top‑N tables.

The map choropleths read BigQuery SQL views (`api.data.apps.fao.org/api/v2/bigquery?sql_url=…`) over `fao-maps.fao_aquastat_dissemination.mvw_aquastat`, pivoted to one column per indicator and joined to M49 country boundaries.

Chart components that exist in the bundle: Line, Bar (incl. horizontal / stacked / bar+line combo), Pie, Scatter, Sankey, Treemap, Heatmap. The config uses **only Line, Bar, Pie and Scatter**.

---

## 1. Country domain

Every Country tab also has the same 3 KPI banners (`snapshot`): **Total population, Urban population, Rural population** (×1000, inhab). Each tab also has a click popup card (catalogitembanner) showing the choropleth values for the clicked country.

### 1.1 Water resources tab

**Map choropleth** (`water_resources.sql`, by country × year 2001–2023): `precipitation` (mm), `total_renewable` (mm), `irwr` (mm), `dependency_ratio` (%), `trwrpc` (m³/inhab/yr). Note: volumes are converted to mm by dividing by country area.

**Extra KPI banners:** Long-term avg annual precipitation in depth (mm/yr) · in volume (10⁹ m³/yr) · Total dam capacity (km³).

| # | Chart | Type | View | What it shows | Data required |
|---|---|---|---|---|---|
| WR1 | Total renewable water resources per capita per region (2015–2023) | Grouped bar (x = region, series = year) | World | TRWR per capita for World + 6 regions, 2015 vs 2023 | `key=trwrpcRegional` → rows {type=region, year, value} in m³/inhab/yr |
| WR2 | Top countries with lowest total renewable water | Horizontal bar, sorted desc | World | Countries with the lowest TRWR per capita | `key=lowestTrwrpc` → {type=country, year, value} |
| WR3 | Renewable water resources | Pie | World + Country | Internal vs external renewable split | `snapshot`: *Total internal renewable water resources (IRWR)*, *Water resources: total external renewable* |
| WR4 | Renewable water resources by source | Pie | World + Country | Surface vs groundwater | `snapshot`: *Total renewable surface water*, *Total renewable groundwater* |
| WR5 | Total renewable water resources per capita | Bar time series | World + Country | TRWR per capita over years | `multivariateTimeseries`: *Total renewable water resources per capita* |

### 1.2 Water use tab

**Map choropleth** (`water_withdrawal.sql`): `twpc`, `awpc`, `iwpc`, `mwpc` (total, agricultural, industrial, municipal withdrawal per capita, m³/inhab/yr), `aw_pct` (agri share of total withdrawal, %).

**Extra KPI banner:** Total water withdrawal (10⁹ m³/yr).

| # | Chart | Type | View | What it shows | Data required |
|---|---|---|---|---|---|
| WU1 | Total freshwater withdrawal per region (2015 and 2023) | Horizontal grouped bar (series = year) | World | Freshwater withdrawal volume per region | `key=totalFreshwaterWithdrawalRegional&year=` → {type=region, year, value} 10⁹ m³/yr |
| WU2 | Total water withdrawal per capita per region (2015 and 2023) | Grouped bar | World | Per-capita withdrawal per region | `key=totalWaterWithdrawalRegionalPC` |
| WU3 | Proportion of freshwater withdrawal by economic sector per region ({year}) | Horizontal 100% stacked bar (x = region, series = Agriculture/Municipal/Industry) | World | Sector shares per region | `key=totalFreshwaterWithdrawalByEconomicSectorRegional&year=` → {area, type=sector, value %} |
| WU4 | Freshwater withdrawals by source per region ({year}) | Horizontal grouped bar (surface vs groundwater) | World | Source shares per region | `key=totalFreshwaterWithdrawalBySourceRegional&year=` → {area, type, value %} |
| WU5 | Use of non-conventional water per region ({year}) | Grouped bar (treated municipal wastewater vs desalinated) | World | Non-conventional water use per region | `key=nonConventionalWaterPerRegion&year=` → {area, type, value %} |
| WU6 | Water withdrawal by economic sector ({year}) | Pie | World + Country | Agri / industrial / municipal split | `snapshot`: *Agricultural water withdrawal*, *Industrial water withdrawal*, *Municipal water withdrawal* |
| WU7 | Water withdrawal by source ({year}) | Pie | World + Country | Surface vs groundwater | `snapshot`: *Fresh surface water withdrawal*, *Fresh groundwater withdrawal* |
| WU8 | Water withdrawal per capita | Grouped bar time series (from 2010) | World + Country | Total + 3 sectoral per-capita withdrawals over time | `multivariateTimeseries&fromYear=2010`: *Total water withdrawal per capita*, *Agricultural … per capita*, *Municipal … per capita (total population)*, *Industrial … per capita* |

### 1.3 Irrigation tab

**Map choropleth** (`irrigated_areas.sql`): `aeit` (area actually irrigated, 1000 ha), `pct_ci` (% of cultivated area equipped for irrigation).

**Extra KPI banner:** Total irrigated area = *Area equipped for irrigation: total* (1000 ha).

| # | Chart | Type | View | What it shows | Data required |
|---|---|---|---|---|---|
| IR1 | Top 10 countries with largest area equipped for full control irrigation ({year}) | Horizontal bar, sorted asc | World | Top‑10 countries | `key=topCountriesWithFullControlIrrigation&year=` → {area, year, value} million ha |
| IR2 | Area equipped for full control irrigation, by irrigation method, per region ({year}) | Stacked bar (series = method: surface/sprinkler/localized) | World | Irrigation method shares per region | `key=irrigationMethodByRegion&year=` → {area, type, value %} |
| IR3 | % of cultivated area equipped for irrigation per region | Multi-line (World + 6 regions, from 2015) | World | Regional trend | `key=irrigatedCultivatedAreaPercent&fromYear=2015&year=` |
| IR4 | Area equipped for irrigation by source | Pie | World + Country | Surface / groundwater / mixed | `snapshot`: *% of area equipped for irrigation by surface water*, *… by groundwater*, *… by mixed surface water and groundwater* |
| IR5 | Area equipped for irrigation: actually irrigated | Line time series | World + Country | Actually irrigated area (million ha) | `multivariateTimeseries`: *Area equipped for irrigation: actually irrigated* (×0.001) |
| IR6 | Per capita crop area vs total cropland vs total irrigated | Stacked bar + line on right axis | World + Country | Cropland & irrigated area (Mha, bars) vs cropland per person (ha, line) | `key=cropAreaPerCapitaVsTotalCroplandVsTotalIrrigated&country=&year=`. Series: *Cropland area (arable land + permanent crops)*, irrigated area, *Cropland per person* |

### 1.4 SDG 6.4 tab (default)

**Map choropleth** (`latest_sdg64.sql`): `ws` (6.4.2 water stress %), `wue` (6.4.1 WUE USD/m³), `wue_pct_ch` (% change in WUE 2015–2023) and its sectoral versions `iwue_pct_ch` / `iawue_pct_ch` / `swue_pct_ch`, sectoral water stress `ascws` / `iscws` / `mscws`. Also hidden styles `iwue`, `iawue`, `swue`.

| # | Chart | Type | View | What it shows | Data required |
|---|---|---|---|---|---|
| SDG1 | Water stress per region (2015 and {year}) | Grouped bar | World | 6.4.2 per region, two years | `key=waterStressPerRegion&year=` → {type=region, year, value %} |
| SDG2 | Countries facing critical and high levels of water stress ({year}) | Horizontal bar, sorted asc | World | Countries with highest water stress | `key=topCountriesWaterStress&year=` → {area, year, value %} |
| SDG3 | SDG 6.4.2 contribution to water stress | Grouped bar time series (from 2015) | World + Country | Agri / industrial / municipal contribution | `multivariateTimeseries`: *SDG 6.4.2. Agricultural / Industrial / Municipal Sector Contribution to Water Stress* |
| SDG4 | SDG 6.4.2 water stress trend | Line (from 2015) | World + Country | Water stress over time (also takes `region=`) | `multivariateTimeseries`: *SDG 6.4.2. Water Stress* |
| SDG5 | Water use efficiency per region (2015 and {year}) | Grouped bar | World | 6.4.1 per region | `key=waterUseEfficiencyPerRegion&year=` USD/m³ |
| SDG6 | WUE in the agricultural sector per region (2015 and {year}) | Grouped bar | World | Agricultural WUE per region | `key=waterUseEfficiencyInAgriculturePerRegion&year=` |
| SDG7 | SDG 6.4.1 water use efficiency by sector | Grouped bar time series (from 2015) | World + Country | Industrial / irrigated agri / services WUE | `multivariateTimeseries`: *SDG 6.4.1. Industrial / Irrigated Agriculture / Services Water Use Efficiency* |
| SDG8 | SDG 6.4.1 water use efficiency trend | Line (from 2015) | World + Country | Total WUE over time (also takes `region=`) | `multivariateTimeseries`: *SDG 6.4.1. Water Use Efficiency* |

---

## 2. Basin domain

Charts use a date range (`fromDate`/`toDate`) instead of a single year. Data is WaPOR/AgERA5-derived basin water balance: P, AET, P−AET, discharge Q, storage change ΔS.

**Map choropleths:** Major Basins and Sub-basins each have a Monthly and an Annual CSV layer (BigQuery: `monthly_/annual_precipitation_evapotranspiration.sql`, `subbasin-…`). Styles: `precipitation_mm_{month|year}`, `evapotranspiration_mm_{month|year}`, `mean_discharge_m3_sec`, `mean_delta_s_m3_sec`. Click popup = "Monthly/Annual Water Balance" card with the same 4 values.

### 2.1 Major Basins tab

| # | Chart | Type | View | What it shows | Data required |
|---|---|---|---|---|---|
| MB1 | Wettest Major Basins (P − AET) | Horizontal bar | World | Basins ranked by P−AET surplus | `key=wettestMajorBasins&fromDate&toDate` → {type=basin, value mm} |
| MB2 | Driest Major Basins (P − AET) | Horizontal bar | World | Basins with lowest P−AET | `key=driestMajorBasins` |
| MB3 | Highest Actual Evapotranspiration | Horizontal bar | World | Basins ranked by AET | `key=highestEvapotranspirationMajorBasins` |
| MB4 | Share of Global Precipitation Volume | Pie | World | Each major basin's share of global P volume | `key=shareOfGlobalPrecipitationVolume` |
| MB5 | Global Precipitation, Evapotranspiration and Water Balance | Multi-line by month (x = month) | World | Seasonal cycle of P, AET, P−AET (mm/month) | `key=globalSeasonalWaterCycle` → {month, series, value} |
| MB6 | {basin} – Wettest to Driest Sub-basins (P − AET) | Horizontal bar (700 px) | Basin picked | Sub-basins inside the selected major basin, ranked | `key=wettestDriestSubBasins&basinId=` |
| MB7 | {basin} – Highest AET Sub-basins | Horizontal bar | Basin picked | Sub-basins ranked by AET | `key=highestEvapotranspirationSubBasins&basinId=` |
| MB8 | {basin} – Share of Precipitation Volume | Pie | Basin picked | Sub-basin shares of the basin's P volume | `key=shareOfBasinPrecipitationVolume&basinId=` |
| MB9 | {basin} – Precipitation, ET and Water Balance | Multi-line by month | Basin picked | Basin seasonal cycle | `key=basinSeasonalWaterCycle&basinId=` |
| MB10 | {basin} – Precipitation (mm/day) | Line time series (x = date) | Basin picked | Daily/periodic P | `key=basinPrecipitation&basinId=` → {date, value} |
| MB11 | {basin} – Evapotranspiration (mm/day) | Line time series | Basin picked | AET time series | `key=basinEvapotranspiration&basinId=` |
| MB12 | {basin} – Precipitation vs Actual ET | Scatter with 1:1 reference line "AET = Precipitation" | **Hidden** (both visibility flags false) | One point per sub-basin, P (x) vs AET (y), grouped by major basin | `key=basinPrecipitationVsAet&basinId=` → {sub_basin, major_basin, precipitation_mm_year, aet_mm_year} |

### 2.2 Sub-basins tab

| # | Chart | Type | View | What it shows | Data required |
|---|---|---|---|---|---|
| SB1 | {sub-basin} – Precipitation (mm/day) | Line time series | Sub-basin picked | P time series | `key=basinPrecipitation&basinId=` → {date, value} |
| SB2 | {sub-basin} – Evapotranspiration (mm/day) | Line time series | Sub-basin picked | AET time series | `key=basinEvapotranspiration&basinId=` |
| SB3 | {sub-basin} – Discharge (m³/s) | Line time series | Sub-basin picked | Discharge Q | `key=basinQDischarge&basinId=` |
| SB4 | {sub-basin} – Storage Change ΔS (m³/s) | Line time series | Sub-basin picked | ΔS | `key=basinDeltaS&basinId=` |
| SB5 | Wettest Sub-basins (P − AET) | Horizontal bar | World | Global sub-basin ranking | `key=globalWettestSubBasins` |
| SB6 | Driest Sub-basins (P − AET) | Horizontal bar | World | Global sub-basin ranking | `key=globalDriestSubBasins` |
| SB7 | Highest Actual Evapotranspiration | Horizontal bar (has help text defining AET) | World | Global sub-basin ranking | `key=globalHighestAetSubBasins` |
| SB8 | Precipitation vs Actual ET | Scatter + 1:1 line | **Hidden** (flags false) | All sub-basins P vs AET | `key=globalPrecipitationVsAet` |

Also hard-coded in the JS (not in the config): when a **Sub-basin boundary** (`__BOUNDARY__Sub_Basins`) is clicked, a popup shows the `subbasin.tmpl.html` card plus two line charts (P and ET, mm/day, `basinPrecipitation` / `basinEvapotranspiration`).

### 2.3 Rivers tab (hidden)

No charts. WMS river network layer plus a click card (`rivers.tmpl.html`) with these attributes: length, upstream/downstream distance, catchment and upland area, mean discharge (`dis_av_cms`) and monthly discharge (`dis_m3_pmn`), flow order, river class, endorheic flag.

---

## 3. Local domain (raster layers)

There are no configured charts here. Each sub-layer has a WMTS raster map and a click card (`value.tmpl.html` → layer name, value, unit).

| Tab | Sub-layer | Time steps | Raster source |
|---|---|---|---|
| Climate | Precipitation | Daily / Dekadal / Monthly | C3S AgERA5 (`AGERA5-PF`, `-D`, `-M`) |
| Climate | Actual ET | Dekadal / Monthly / Annual | WaPOR v3 L1-AETI |
| Climate | Reference ET | Dekadal / Monthly / Annual | WaPOR v3 L1-RET |
| Biomass Production | Net Primary Production | Dekadal / Monthly | WaPOR v3 L1-NPP |
| Biomass Production | Total Biomass Production | Annual | WaPOR v3 L1-TBP |
| Biomass Production | Gross biomass water productivity | Annual | WaPOR v3 L1-GBWP |
| Infrastructure | Share of irrigated land | Annual | GAEZ v5 LR-IRR |
| Infrastructure | Dams | point CSV | `/data/Dams/AQUASTAT_DAMS_corrected.csv`; card shows name, river, basin, height, capacity, area, purposes (irrigation, hydro, water supply, flood control…), year in operation |

**On-demand analysis charts (openEO, sign-in required):** only **Precipitation** has `analysis` configured.
- *Precipitation Timeseries* (`time-series`)
- *Precipitation Cumulative Timeseries* (`cumulative-time-series`)

Both run openEO `load_collection` → `zonal_stats` (mean, sum, min, max) on `fao-gismgr:WATER:raster:mapsets:WS-SURPLUS-YEARLY-AVG-G` over a user-drawn area. The result is drawn as a Line chart, or as Bar or Pie depending on the result shape. Note that the collection ID is a water-surplus mapset, not AgERA5 precipitation, which looks like a config error.

---

## Summary counts

| Domain / tab | Charts | Of which World-only | KPI banners |
|---|---|---|---|
| Country · Water resources | 5 | 2 | 6 |
| Country · Water use | 8 | 5 | 4 |
| Country · Irrigation | 6 | 3 | 4 |
| Country · SDG 6.4 | 8 | 4 | 3 |
| Basin · Major Basins | 12 (1 hidden) | 5 | – |
| Basin · Sub-basins | 8 (1 hidden) + 2 in popup | 3 | – |
| Basin · Rivers | 0 | – | – |
| Local (all) | 0 configured; 2 openEO analysis types | – | – |
| **Total** | **47 configured** (45 visible) | | 17 |
