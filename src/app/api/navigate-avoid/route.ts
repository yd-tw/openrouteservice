import type { NextRequest } from "next/server";
import { findPedestrianRoute } from "@/utils/walkRouter";

export type TravelMode = "car" | "pedestrian";
export type LngLat = [number, number];

export interface NavigateAvoidRequest {
  origin: LngLat;
  destination: LngLat;
  mode: TravelMode;
}

const ORS_PROFILE: Record<"car", string> = {
  car: "driving-car",
};

const AVOID_SOURCE_PATH = "/geo_example.json";
const AVOID_RADIUS_M = 100;
const CIRCLE_SEGMENTS = 24;
const EARTH_RADIUS_M = 6_371_000;

type LineString = { type: "LineString"; coordinates: LngLat[] };
type Feature = {
  type: "Feature";
  geometry: LineString;
  properties: Record<string, unknown>;
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };

interface OrsStep {
  distance: number;
  duration: number;
  type: number;
  instruction: string;
  name: string;
  way_points: [number, number];
}

interface OrsFeature {
  type: "Feature";
  geometry: LineString;
  properties: {
    summary: { distance: number; duration: number };
    segments: { distance: number; duration: number; steps: OrsStep[] }[];
  };
}

interface OrsResponse {
  type: "FeatureCollection";
  features: OrsFeature[];
  error?: { code: number; message: string } | string;
}

type Ring = LngLat[];
type Polygon = Ring[];
type MultiPolygon = { type: "MultiPolygon"; coordinates: Polygon[] };

function isLngLat(v: unknown): v is LngLat {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    v[0] >= -180 &&
    v[0] <= 180 &&
    v[1] >= -90 &&
    v[1] <= 90
  );
}

function parseLngLat(raw: string | null): LngLat | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const candidate: [number, number] = [parts[0], parts[1]];
  return isLngLat(candidate) ? candidate : null;
}

function parseSearchParams(
  searchParams: URLSearchParams,
): NavigateAvoidRequest | { error: string } {
  const origin = parseLngLat(searchParams.get("origin"));
  const destination = parseLngLat(searchParams.get("destination"));
  const mode = searchParams.get("mode");
  if (!origin) return { error: "origin must be 'lng,lat'" };
  if (!destination) return { error: "destination must be 'lng,lat'" };
  if (mode !== "car" && mode !== "pedestrian") {
    return { error: "mode must be one of: car, pedestrian" };
  }
  return { origin, destination, mode };
}

// Spherical destination point: build a polygon ring approximating a circle of
// radius_m metres around `center`. Returns a closed ring (last == first).
function bufferPoint(
  center: LngLat,
  radius_m: number,
  segments = CIRCLE_SEGMENTS,
): Ring {
  const [lng, lat] = center;
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  const angular = radius_m / EARTH_RADIUS_M;
  const ring: Ring = [];
  for (let i = 0; i < segments; i++) {
    const bearing = (2 * Math.PI * i) / segments;
    const sinLat =
      Math.sin(latRad) * Math.cos(angular) +
      Math.cos(latRad) * Math.sin(angular) * Math.cos(bearing);
    const newLat = Math.asin(sinLat);
    const newLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(latRad),
        Math.cos(angular) - Math.sin(latRad) * sinLat,
      );
    ring.push([(newLng * 180) / Math.PI, (newLat * 180) / Math.PI]);
  }
  ring.push(ring[0]);
  return ring;
}

interface SourceFeature {
  type: "Feature";
  geometry: {
    type?: string;
    coordinates?: unknown;
    geometries?: unknown[];
  } | null;
  properties?: Record<string, unknown> | null;
}

interface SourceFeatureCollection {
  type: "FeatureCollection";
  features: SourceFeature[];
}

function isFeatureCollection(v: unknown): v is SourceFeatureCollection {
  if (!v || typeof v !== "object") return false;
  const o = v as { type?: unknown; features?: unknown };
  return o.type === "FeatureCollection" && Array.isArray(o.features);
}

// Recursively walk any geometry (including GeometryCollection) and call cb
// on every coordinate pair. Used to buffer every vertex into an avoidance circle.
function forEachVertex(geom: unknown, cb: (p: LngLat) => void): void {
  if (!geom || typeof geom !== "object") return;
  const g = geom as {
    type?: string;
    coordinates?: unknown;
    geometries?: unknown[];
  };

  if (g.type === "GeometryCollection" && Array.isArray(g.geometries)) {
    for (const sub of g.geometries) forEachVertex(sub, cb);
    return;
  }

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (
      coords.length >= 2 &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      cb([coords[0], coords[1]]);
      return;
    }
    for (const c of coords) visit(c);
  };

  visit(g.coordinates);
}

// Build a MultiPolygon avoidance geometry. For Polygon/MultiPolygon source
// features we keep the original geometry (so the interior is blocked) AND
// buffer the boundary; for Point/Line geometries we buffer every vertex.
function buildAvoidGeometry(fc: SourceFeatureCollection): {
  geometry: MultiPolygon | null;
  vertexCount: number;
  featureCount: number;
} {
  const polys: Polygon[] = [];
  let vertexCount = 0;

  for (const feature of fc.features) {
    const g = feature.geometry;
    if (!g || typeof g !== "object") continue;

    if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
      polys.push(g.coordinates as Polygon);
    } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
      for (const p of g.coordinates as Polygon[]) polys.push(p);
    }

    forEachVertex(g, (p) => {
      vertexCount += 1;
      polys.push([bufferPoint(p, AVOID_RADIUS_M)]);
    });
  }

  return {
    geometry: polys.length
      ? { type: "MultiPolygon", coordinates: polys }
      : null,
    vertexCount,
    featureCount: fc.features.length,
  };
}

async function fetchAvoidSource(
  request: NextRequest,
): Promise<SourceFeatureCollection | null> {
  const url = new URL(AVOID_SOURCE_PATH, request.nextUrl.origin);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return isFeatureCollection(data) ? data : null;
}

// ORS emits zero-length steps (notably the arrival step with
// way_points: [N, N]). Slicing those yields a single-point LineString, which
// is invalid GeoJSON. Pad backward by one so the step still represents the
// final approach segment.
function stepCoords(coords: LngLat[], [a, b]: [number, number]): LngLat[] {
  if (b > a) return coords.slice(a, b + 1);
  if (a > 0) return coords.slice(a - 1, b + 1);
  return [coords[a], coords[a]];
}

async function routeViaOrs(
  origin: LngLat,
  destination: LngLat,
  mode: "car",
  avoid: MultiPolygon | null,
): Promise<OrsFeature> {
  const apiKey = process.env.OPENROUTESERVICE_API_KEY;
  if (!apiKey) throw new Error("OPENROUTESERVICE_API_KEY is not set");

  const profile = ORS_PROFILE[mode];
  const url = `https://api.openrouteservice.org/v2/directions/${profile}/geojson`;

  const body: Record<string, unknown> = { coordinates: [origin, destination] };
  if (avoid) body.options = { avoid_polygons: avoid };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/geo+json, application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as OrsResponse;
  if (!res.ok || !data.features?.length) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ?? `HTTP ${res.status}`);
    throw new Error(`ORS: ${msg}`);
  }
  return data.features[0];
}

export async function GET(request: NextRequest) {
  const parsed = parseSearchParams(request.nextUrl.searchParams);
  if ("error" in parsed)
    return Response.json({ error: parsed.error }, { status: 400 });

  const { origin, destination, mode } = parsed;

  try {
    const source = await fetchAvoidSource(request);
    const avoid = source
      ? buildAvoidGeometry(source)
      : { geometry: null, vertexCount: 0, featureCount: 0 };

    if (mode === "pedestrian") {
      const route = await findPedestrianRoute(origin, destination, {
        avoid: avoid.geometry,
      });
      const fc: FeatureCollection = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: route.coordinates },
            properties: {
              mode,
              provider: "astar-sidewalks",
              distance_m: route.distance_m,
              duration_s: route.duration_s,
              avoid_source: AVOID_SOURCE_PATH,
              avoid_radius_m: AVOID_RADIUS_M,
              avoid_feature_count: avoid.featureCount,
              avoid_vertex_count: avoid.vertexCount,
              stroke: "#22C55E",
            },
          },
        ],
      };
      return Response.json(fc);
    }

    const route = await routeViaOrs(origin, destination, mode, avoid.geometry);
    const coords = route.geometry.coordinates;
    const steps = route.properties.segments.flatMap((s) => s.steps);

    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: route.geometry,
          properties: {
            mode,
            provider: "openrouteservice",
            distance_m: route.properties.summary.distance,
            duration_s: route.properties.summary.duration,
            avoid_source: AVOID_SOURCE_PATH,
            avoid_radius_m: AVOID_RADIUS_M,
            avoid_feature_count: avoid.featureCount,
            avoid_vertex_count: avoid.vertexCount,
          },
        },
        ...steps.map<Feature>((s, i) => ({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: stepCoords(coords, s.way_points),
          },
          properties: {
            kind: "step",
            index: i,
            name: s.name,
            instruction: s.instruction,
            maneuver_type: s.type,
            distance_m: s.distance,
            duration_s: s.duration,
          },
        })),
      ],
    };

    return Response.json(fc);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown routing error";
    return Response.json({ error: message }, { status: 502 });
  }
}
