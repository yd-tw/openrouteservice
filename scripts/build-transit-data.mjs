// One-shot preprocessor for Taipei MRT data.
//
// Inputs (project root):
//   - 臺北捷運車站出入口座標.csv    (Big5, WGS84 lng/lat)
//   - TpeMRTRoutes_TWD97_臺北都會區大眾捷運系統路網圖-121208.json (EPSG:3826)
//
// Output:
//   - src/data/transit.json
//
// Run:  node scripts/build-transit-data.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import iconv from "iconv-lite";
import proj4 from "proj4";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CSV_PATH = path.join(ROOT, "臺北捷運車站出入口座標.csv");
const ROUTES_PATH = path.join(
  ROOT,
  "TpeMRTRoutes_TWD97_臺北都會區大眾捷運系統路網圖-121208.json",
);
const OUT_PATH = path.join(ROOT, "src", "data", "transit.json");

const TWD97_TM2 =
  "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs";

// Stations within this distance from a line segment are considered "on the line".
const SNAP_THRESHOLD_M = 250;

// ---------- helpers ----------

function toLngLat([x, y]) {
  return proj4(TWD97_TM2, "WGS84", [x, y]);
}

// Equirectangular approximation, fine for short distances within Taipei.
function haversineM(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Project point P onto segment AB. Returns { t, distM, point } where t is
// parameter [0,1] along AB and distM is perpendicular distance.
function projectOnSegment(p, a, b) {
  // Use a local meter-ish frame around A for the projection math.
  const lat0 = (a[1] * Math.PI) / 180;
  const mPerLng = 111_320 * Math.cos(lat0);
  const mPerLat = 110_540;
  const ax = 0;
  const ay = 0;
  const bx = (b[0] - a[0]) * mPerLng;
  const by = (b[1] - a[1]) * mPerLat;
  const px = (p[0] - a[0]) * mPerLng;
  const py = (p[1] - a[1]) * mPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = (px * dx + py * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const distM = Math.hypot(px - cx, py - cy);
  const point = [a[0] + (cx / mPerLng), a[1] + (cy / mPerLat)];
  return { t, distM, point };
}

// For a polyline (array of [lng,lat]), find best projection of `p` and
// return the cumulative along-line distance to that projection.
function projectOnPolyline(p, line) {
  let best = { distM: Infinity, along: 0, point: p };
  let cum = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = haversineM(a, b);
    const proj = projectOnSegment(p, a, b);
    if (proj.distM < best.distM) {
      best = { distM: proj.distM, along: cum + proj.t * segLen, point: proj.point };
    }
    cum += segLen;
  }
  return { ...best, totalLength: cum };
}

// Slice polyline between two along-line distances.
function slicePolyline(line, fromAlong, toAlong) {
  if (fromAlong > toAlong) {
    const sliced = slicePolyline(line, toAlong, fromAlong);
    sliced.reverse();
    return sliced;
  }
  const out = [];
  let cum = 0;
  let started = false;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = haversineM(a, b);
    const segEnd = cum + segLen;
    if (!started && fromAlong <= segEnd) {
      const t = (fromAlong - cum) / (segLen || 1);
      const startPt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(startPt);
      started = true;
    }
    if (started) {
      if (toAlong <= segEnd) {
        const t = (toAlong - cum) / (segLen || 1);
        const endPt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        out.push(endPt);
        return out;
      } else {
        out.push(b);
      }
    }
    cum = segEnd;
  }
  return out;
}

// ---------- 1. parse entrances CSV ----------

const csvBuf = fs.readFileSync(CSV_PATH);
const csvText = iconv.decode(csvBuf, "Big5");
const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
lines.shift(); // header

const stationMap = new Map(); // stationName -> { entrances:[], lngSum, latSum, n }

for (const line of lines) {
  const cols = line.split(",");
  if (cols.length < 5) continue;
  const [, name, code, lngStr, latStr, accessibleStr] = cols;
  const lng = Number(lngStr);
  const lat = Number(latStr);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

  // "中山國中站出口" / "大安站出口5" -> "中山國中站" / "大安站"
  const m = name.match(/^(.+?站)出口/);
  if (!m) continue;
  const stationName = m[1];

  let s = stationMap.get(stationName);
  if (!s) {
    s = { name: stationName, entrances: [], lngSum: 0, latSum: 0, n: 0 };
    stationMap.set(stationName, s);
  }
  s.entrances.push({
    name,
    code: code === "0" ? null : code,
    lng,
    lat,
    accessible: accessibleStr?.trim() === "是",
  });
  s.lngSum += lng;
  s.latSum += lat;
  s.n += 1;
}

const stations = Array.from(stationMap.values()).map((s) => ({
  name: s.name,
  center: [s.lngSum / s.n, s.latSum / s.n],
  entrances: s.entrances,
}));

console.log(`Parsed ${stations.length} stations from CSV`);

// ---------- 2. parse routes JSON ----------

const routesRaw = JSON.parse(fs.readFileSync(ROUTES_PATH, "utf8"));

// Flatten each Feature into one or more LineStrings, all in WGS84.
// Each entry: { line: RouteName, coords: [[lng,lat], ...] }
const lineSegments = [];
for (const feat of routesRaw.features) {
  const routeName = feat.properties?.RouteName ?? `unknown-${feat.id}`;
  const g = feat.geometry;
  const polylines = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
  for (const poly of polylines) {
    const wgs = poly.map(toLngLat);
    if (wgs.length >= 2) lineSegments.push({ line: routeName, coords: wgs });
  }
}

console.log(`Flattened ${lineSegments.length} polylines across routes`);

// ---------- 3. snap stations onto each line segment, build edges ----------

const edges = [];
const onLineCount = new Map(); // station -> set of line names matched

for (const seg of lineSegments) {
  // Project every station onto this polyline; keep those within threshold.
  const matches = [];
  for (const st of stations) {
    const proj = projectOnPolyline(st.center, seg.coords);
    if (proj.distM <= SNAP_THRESHOLD_M) {
      matches.push({ station: st, along: proj.along, distM: proj.distM });
    }
  }
  if (matches.length < 2) continue;

  matches.sort((a, b) => a.along - b.along);

  // Dedupe (same station projected twice on a complex polyline)
  const dedup = [];
  for (const m of matches) {
    const last = dedup[dedup.length - 1];
    if (last && last.station.name === m.station.name) {
      // keep the one with smaller perpendicular distance
      if (m.distM < last.distM) dedup[dedup.length - 1] = m;
      continue;
    }
    dedup.push(m);
  }
  if (dedup.length < 2) continue;

  for (let i = 0; i < dedup.length - 1; i++) {
    const a = dedup[i];
    const b = dedup[i + 1];
    const sliceCoords = slicePolyline(seg.coords, a.along, b.along);
    let dist = 0;
    for (let j = 0; j < sliceCoords.length - 1; j++) {
      dist += haversineM(sliceCoords[j], sliceCoords[j + 1]);
    }
    if (sliceCoords.length < 2 || dist < 50) continue; // too short, likely same platform
    edges.push({
      line: seg.line,
      from: a.station.name,
      to: b.station.name,
      distance_m: Math.round(dist),
      coordinates: sliceCoords,
    });
    for (const name of [a.station.name, b.station.name]) {
      if (!onLineCount.has(name)) onLineCount.set(name, new Set());
      onLineCount.get(name).add(seg.line);
    }
  }
}

console.log(`Built ${edges.length} edges`);

const orphanStations = stations.filter((s) => !onLineCount.has(s.name));
console.log(`Stations not snapped to any line: ${orphanStations.length}`);
if (orphanStations.length) {
  console.log("  e.g.:", orphanStations.slice(0, 8).map((s) => s.name).join(", "));
}

// ---------- 4. write output ----------

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(
  OUT_PATH,
  JSON.stringify({ stations, edges }, null, 0),
);
console.log(`Wrote ${OUT_PATH} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB)`);
