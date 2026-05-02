// Parse row_errpos.json (raw closure records with embedded geocoded coords)
// into a GeoJSON FeatureCollection at public/geo_example.json, which the
// /api/navigate-avoid endpoint reads.
//
// Run: node scripts/build-geo-example.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SRC_PATH = path.join(ROOT, "row_errpos.json");
const OUT_PATH = path.join(ROOT, "public", "geo_example.json");

const raw = JSON.parse(fs.readFileSync(SRC_PATH, "utf8"));
if (!Array.isArray(raw)) {
  throw new Error(`${SRC_PATH} is not a JSON array`);
}

const features = [];
let skippedNoGeo = 0;
let skippedBadCoord = 0;
const seen = new Set();

for (const entry of raw) {
  const geo = entry?.geo;
  if (!geo || typeof geo !== "object") {
    skippedNoGeo += 1;
    continue;
  }
  const lon = Number(geo.lon);
  const lat = Number(geo.lat);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    skippedBadCoord += 1;
    continue;
  }

  // Two records with the same address often share identical geocoded coords;
  // dedupe so the avoid_polygons payload doesn't carry redundant circles.
  const key = `${lon.toFixed(7)},${lat.toFixed(7)}`;
  if (seen.has(key)) continue;
  seen.add(key);

  features.push({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      address: entry.ral_address1 ?? null,
      address2: entry.ral_address2 ?? null,
      city: geo.city ?? null,
      district: geo.district ?? null,
      road: geo.road ?? null,
      house: geo.house ?? null,
      apply_type: entry.apply_type ?? null,
      provider: geo.provider ?? null,
    },
  });
}

const fc = { type: "FeatureCollection", features };
fs.writeFileSync(OUT_PATH, JSON.stringify(fc, null, 2) + "\n", "utf8");

const dedupSkipped = raw.length - features.length - skippedNoGeo - skippedBadCoord;
console.log(
  `Wrote ${features.length} features to ${path.relative(ROOT, OUT_PATH)} ` +
    `(input ${raw.length}, skipped ${skippedNoGeo} no-geo, ${skippedBadCoord} bad-coord, ${dedupSkipped} duplicate)`,
);
