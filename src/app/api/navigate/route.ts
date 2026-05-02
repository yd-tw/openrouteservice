
import type { NextRequest } from "next/server";

export type TravelMode = "car" | "transit" | "pedestrian";

export type LngLat = [number, number];

export interface NavigateRequest {
  origin: LngLat;
  destination: LngLat;
  mode: TravelMode;
}

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

const ORS_PROFILE: Record<Exclude<TravelMode, "transit">, string> = {
  car: "driving-car",
  pedestrian: "foot-walking",
};

function isLngLat(v: unknown): v is LngLat {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
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
): NavigateRequest | { error: string } {
  const origin = parseLngLat(searchParams.get("origin"));
  const destination = parseLngLat(searchParams.get("destination"));
  const mode = searchParams.get("mode");
  if (!origin) return { error: "origin must be 'lng,lat'" };
  if (!destination) return { error: "destination must be 'lng,lat'" };
  if (mode !== "car" && mode !== "transit" && mode !== "pedestrian") {
    return { error: "mode must be one of: car, transit, pedestrian" };
  }
  return { origin, destination, mode };
}

async function routeViaOrs(
  origin: LngLat,
  destination: LngLat,
  mode: Exclude<TravelMode, "transit">,
): Promise<FeatureCollection> {
  const apiKey = process.env.OPENROUTESERVICE_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTESERVICE_API_KEY is not set");
  }

  const profile = ORS_PROFILE[mode];
  const url = `https://api.openrouteservice.org/v2/directions/${profile}/geojson`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      Accept: "application/geo+json, application/json",
    },
    body: JSON.stringify({ coordinates: [origin, destination] }),
  });

  const data = (await res.json()) as OrsResponse;
  if (!res.ok || !data.features?.length) {
    const msg =
      typeof data.error === "string"
        ? data.error
        : data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`ORS: ${msg}`);
  }

  const feature = data.features[0];
  const coords = feature.geometry.coordinates;
  const steps = feature.properties.segments.flatMap((seg) => seg.steps);

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: feature.geometry,
        properties: {
          mode,
          provider: "openrouteservice",
          distance_m: feature.properties.summary.distance,
          duration_s: feature.properties.summary.duration,
        },
      },
      ...steps.map<Feature>((s, i) => ({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords.slice(s.way_points[0], s.way_points[1] + 1),
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
}

// Transit needs a GTFS-aware engine (OpenTripPlanner, Google Directions, etc.).
// No free unauthenticated provider works globally, so we return a clearly-marked
// straight-line placeholder. Swap this out once a provider + key are configured.
function placeholderTransit(origin: LngLat, destination: LngLat): FeatureCollection {
  const dx = destination[0] - origin[0];
  const dy = destination[1] - origin[1];
  // ~111km per degree; rough great-circle-free estimate, fine as placeholder
  const distanceM = Math.round(Math.hypot(dx, dy) * 111_000);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [origin, destination] },
        properties: {
          mode: "transit",
          provider: "placeholder",
          distance_m: distanceM,
          duration_s: null,
          notice:
            "Transit routing not configured. Integrate a GTFS provider (OpenTripPlanner, Google Directions, etc.) and replace placeholderTransit().",
        },
      },
    ],
  };
}

export async function GET(request: NextRequest) {
  const parsed = parseSearchParams(request.nextUrl.searchParams);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  const { origin, destination, mode } = parsed;

  try {
    const geojson =
      mode === "transit"
        ? placeholderTransit(origin, destination)
        : await routeViaOrs(origin, destination, mode);
    return Response.json(geojson);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown routing error";
    return Response.json({ error: message }, { status: 502 });
  }
}
