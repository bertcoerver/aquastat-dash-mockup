/*
 * Where WaPOR has level 2 (100 m) data: Africa, the Near East, Pakistan, Afghanistan,
 * Sri Lanka and Colombia. Each L2 raster spans 60° N to 60° S, but has nodata outside
 * these countries (tiles of it, not sparse ones), so the map and the Local panel only
 * read it here.
 *
 * In 1° cells: those where any of a few L2 rasters (variables and dates from 2018 to
 * 2025) has a pixel with data, from their coarsest overviews. They hardly differ (a
 * few cells along coasts). A cell may be only partly covered (along a border): the
 * pixels L2 has no value for are filled from L1 (see wapor.ts).
 *
 * As rows, "lat=lon:n,…": the cells from `lat` down to lat − 1, `n` of them from `lon`
 * eastwards.
 */
const ROWS =
  "40=43:6 39=44:6,55:3 38=6:6,38:1,40:21,74:2 37=0:12,35:27,71:6 36=-7:19,35:27,71:7 " +
  "35=-7:19,35:27,69:9 34=-17:1,-9:22,35:27,69:6 33=-18:2,-10:26,19:7,34:27,69:7 32=-10:28,19:43,66:10 " +
  "31=-17:2,-10:72,66:9 30=-14:1,-11:85 29=-19:68,50:23 28=-19:4,-14:64,51:21 27=-15:67,53:18 " +
  "26=-15:50,36:17,54:17 25=-16:52,37:21,61:1,66:6 24=-17:54,38:22,67:2 23=-17:54,38:22 22=-18:78 " +
  "21=-18:56,39:21 20=-17:55,40:18 19=-17:56,40:18 18=-26:2,-17:57,41:16 17=-26:4,-17:73 " +
  "16=-25:3,-18:71 15=-25:2,-18:69 14=-82:1,-17:66 13=-82:1,-73:2,-17:63,50:1,52:3 12=-76:5,-17:61,46:6 " +
  "11=-76:4,-17:69 10=-77:5,-15:66,79:3 9=-78:6,-14:65,79:3 8=-78:8,-14:64,79:3 7=-78:11,-12:62,79:3 " +
  "6=-78:11,-11:13,4:46,80:1 5=-78:11,-10:5,-3:2,5:44 4=-79:12,8:40 3=-79:12,9:38 2=-80:14,7:1,9:37 " +
  "1=-79:10,6:1,9:35 0=-76:7,6:1,8:35 -1=-75:6,8:35 -2=-74:5,9:33 -3=-71:2,10:31 -4=-71:2,11:29,55:1 " +
  "-5=11:29 -6=12:28 -7=12:28,56:1 -8=12:28 -9=12:28,46:2 -10=13:28,47:1,51:1 -11=13:28,43:1,49:1 " +
  "-12=12:29,43:3,48:2 -13=12:29,45:1,47:4 -14=12:29,47:4 -15=11:30,45:6 -16=11:30,44:7 -17=11:29,43:7 " +
  "-18=11:27,43:7 -19=12:24,44:6,57:1 -20=12:24,43:6,55:1,57:1 -21=13:23,39:1,43:6,55:1 " +
  "-22=14:22,40:1,43:6 -23=14:22,43:5 -24=14:22,43:5 -25=14:21,43:5 -26=14:20 -27=15:18 -28=15:18 " +
  "-29=16:16 -30=17:15 -31=17:14 -32=17:13 -33=17:12 -34=18:8";

const cells = new Set<number>();
for (const row of ROWS.split(" ")) {
  const [lat, runs] = row.split("=");
  for (const run of runs.split(",")) {
    const [lon, n] = run.split(":").map(Number);
    for (let i = 0; i < n; i++) cells.add(cell(lon + i, +lat - 1));
  }
}

/** The cell with its south-west corner at (lon, lat), whole degrees. */
function cell(lon: number, lat: number) {
  return (lat + 90) * 360 + ((((lon + 180) % 360) + 360) % 360);
}

/** Whether L2 may have data at a point. */
export const inL2 = (lon: number, lat: number) => cells.has(cell(Math.floor(lon), Math.floor(lat)));

/** Whether L2 may have data in a lon/lat box (west may be below -180, east above 180). */
export function boxInL2(west: number, south: number, east: number, north: number) {
  if (east - west >= 360) [west, east] = [-180, 180];
  for (let lat = Math.max(-60, Math.floor(south)); lat < Math.min(60, Math.ceil(north)); lat++) {
    for (let lon = Math.floor(west); lon < Math.ceil(east); lon++) if (cells.has(cell(lon, lat))) return true;
  }
  return false;
}
