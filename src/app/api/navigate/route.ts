
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

interface OsrmStep {
  distance: number;
  duration: number;
  name: string;
  geometry: LineString;
  maneuver: { type: string; modifier?: string; location: LngLat };
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: LineString;
  legs: { steps: OsrmStep[] }[];
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
}

const OSRM_PROFILE: Record<Exclude<TravelMode, "transit">, string> = {
  car: "driving",
  pedestrian: "foot",
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

async function routeViaOsrm(
  origin: LngLat,
  destination: LngLat,
  mode: Exclude<TravelMode, "transit">,
): Promise<FeatureCollection> {
  const profile = OSRM_PROFILE[mode];
  const coords = `${origin[0]},${origin[1]};${destination[0]},${destination[1]}`;
  const url = `https://router.project-osrm.org/route/v1/${profile}/${coords}?overview=full&geometries=geojson&steps=true`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`OSRM ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as OsrmResponse;
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM: ${data.code}${data.message ? ` - ${data.message}` : ""}`);
  }

  const route = data.routes[0];
  const steps = route.legs.flatMap((leg) => leg.steps);

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: route.geometry,
        properties: {
          mode,
          provider: "osrm",
          distance_m: route.distance,
          duration_s: route.duration,
        },
      },
      ...steps.map<Feature>((s, i) => ({
        type: "Feature",
        geometry: s.geometry,
        properties: {
          kind: "step",
          index: i,
          name: s.name,
          maneuver: s.maneuver.type,
          modifier: s.maneuver.modifier ?? null,
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
        : await routeViaOsrm(origin, destination, mode);
    return Response.json(geojson);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown routing error";
    return Response.json({ error: message }, { status: 502 });
  }
}
