import type { NextRequest } from "next/server";
import transitData from "@/data/transit.json";
import {
  findPedestrianRoute,
  findPedestrianRouteFeatureCollection,
} from "@/utils/walkRouter";

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
type FeatureCollection = {
  type: "FeatureCollection";
  features: Feature[];
  metadata?: Record<string, unknown>;
};

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

const ORS_PROFILE: Record<"car", string> = {
  car: "driving-car",
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
  mode: "car",
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
        : (data.error?.message ?? `HTTP ${res.status}`);
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

// ---------- Transit (Taipei MRT) ----------

interface TransitEntrance {
  name: string;
  code: string | null;
  lng: number;
  lat: number;
  accessible: boolean;
}
interface TransitStation {
  name: string;
  center: [number, number];
  entrances: TransitEntrance[];
}
interface TransitEdge {
  line: string;
  from: string;
  to: string;
  distance_m: number;
  coordinates: [number, number][];
}

const TRANSIT = transitData as {
  stations: TransitStation[];
  edges: TransitEdge[];
};

const STATIONS_BY_NAME = new Map(TRANSIT.stations.map((s) => [s.name, s]));

// Adjacency: station -> [{ neighbor, line, distance, coords }]
const ADJ = (() => {
  const map = new Map<
    string,
    { to: string; line: string; distance: number; coords: [number, number][] }[]
  >();
  const push = (
    a: string,
    b: string,
    line: string,
    distance: number,
    coords: [number, number][],
  ) => {
    if (!map.has(a)) map.set(a, []);
    map.get(a)!.push({ to: b, line, distance, coords });
  };
  for (const e of TRANSIT.edges) {
    push(e.from, e.to, e.line, e.distance_m, e.coordinates);
    push(e.to, e.from, e.line, e.distance_m, [...e.coordinates].reverse());
  }
  return map;
})();

// Penalty (in meters) added when changing lines, so Dijkstra prefers fewer transfers.
const TRANSFER_PENALTY_M = 1500;

function haversineM(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestEntrance(p: LngLat): {
  station: TransitStation;
  entrance: TransitEntrance;
  distance_m: number;
} {
  let best: {
    station: TransitStation;
    entrance: TransitEntrance;
    distance_m: number;
  } | null = null;
  for (const s of TRANSIT.stations) {
    for (const e of s.entrances) {
      const d = haversineM(p, [e.lng, e.lat]);
      if (!best || d < best.distance_m)
        best = { station: s, entrance: e, distance_m: d };
    }
  }
  if (!best) throw new Error("No transit stations available");
  return best;
}

interface TransitLeg {
  line: string;
  from: string;
  to: string;
  distance_m: number;
  coordinates: [number, number][];
}

function shortestTransitPath(fromName: string, toName: string): TransitLeg[] {
  if (fromName === toName) return [];
  if (!ADJ.has(fromName))
    throw new Error(`Boarding station has no connections: ${fromName}`);
  if (!ADJ.has(toName))
    throw new Error(`Alighting station has no connections: ${toName}`);

  // Dijkstra. State = station name; track previous edge (with line) for transfer penalty.
  const dist = new Map<string, number>();
  const prev = new Map<
    string,
    { from: string; line: string; distance: number; coords: [number, number][] }
  >();
  const prevLine = new Map<string, string>();
  dist.set(fromName, 0);

  // Simple priority queue via sorted array (graph is ~120 nodes).
  const queue: { name: string; cost: number }[] = [{ name: fromName, cost: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const { name, cost } = queue.shift()!;
    if (name === toName) break;
    if (cost > (dist.get(name) ?? Infinity)) continue;

    for (const edge of ADJ.get(name) ?? []) {
      const incomingLine = prevLine.get(name);
      const transfer =
        incomingLine && incomingLine !== edge.line ? TRANSFER_PENALTY_M : 0;
      const next = cost + edge.distance + transfer;
      if (next < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, next);
        prev.set(edge.to, {
          from: name,
          line: edge.line,
          distance: edge.distance,
          coords: edge.coords,
        });
        prevLine.set(edge.to, edge.line);
        queue.push({ name: edge.to, cost: next });
      }
    }
  }

  if (!dist.has(toName))
    throw new Error(`No transit path from ${fromName} to ${toName}`);

  const legs: TransitLeg[] = [];
  let cursor = toName;
  while (cursor !== fromName) {
    const p = prev.get(cursor);
    if (!p) throw new Error(`Broken path at ${cursor}`);
    legs.push({
      line: p.line,
      from: p.from,
      to: cursor,
      distance_m: p.distance,
      coordinates: p.coords,
    });
    cursor = p.from;
  }
  legs.reverse();

  // Merge consecutive legs on the same line into one continuous segment.
  const merged: TransitLeg[] = [];
  for (const leg of legs) {
    const last = merged[merged.length - 1];
    if (last && last.line === leg.line && last.to === leg.from) {
      last.to = leg.to;
      last.distance_m += leg.distance_m;
      last.coordinates = [...last.coordinates, ...leg.coordinates.slice(1)];
    } else {
      merged.push({ ...leg });
    }
  }
  return merged;
}

async function walkLeg(
  from: LngLat,
  to: LngLat,
  label: string,
): Promise<Feature> {
  // Skip routing when the two points are essentially the same.
  if (haversineM(from, to) < 5) {
    return {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [from, to] },
      properties: {
        kind: "walk",
        label,
        distance_m: 0,
        duration_s: 0,
        stroke: "#22C55E",
      },
    };
  }
  const route = await findPedestrianRoute(from, to);
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: route.coordinates },
    properties: {
      kind: "walk",
      label,
      distance_m: route.distance_m,
      duration_s: route.duration_s,
      stroke: "#22C55E",
    },
  };
}

async function routeTransit(
  origin: LngLat,
  destination: LngLat,
): Promise<FeatureCollection> {
  const board = nearestEntrance(origin);
  const alight = nearestEntrance(destination);

  // If the closest entrance for both is the same station, just walk.
  if (board.station.name === alight.station.name) {
    const walk = await walkLeg(origin, destination, "walk");
    const walkDist = Number(walk.properties.distance_m) || 0;
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: walk.geometry,
          properties: {
            mode: "transit",
            provider: "tpe-mrt",
            note: `Origin and destination share nearest station (${board.station.name}); walking only.`,
            distance_m: walk.properties.distance_m,
            duration_s: walk.properties.duration_s,
            stroke: "#22C55E",
          },
        },
        walk,
      ],
      metadata: {
        mode: "transit",
        distance_m: walkDist,
        walk_distance_m: walkDist,
        transit_distance_m: 0,
        transit_ratio: 0,
      },
    };
  }

  const transitLegs = shortestTransitPath(
    board.station.name,
    alight.station.name,
  );

  const walkToBoard = await walkLeg(
    origin,
    [board.entrance.lng, board.entrance.lat],
    `walk to ${board.entrance.name}`,
  );
  const walkFromAlight = await walkLeg(
    [alight.entrance.lng, alight.entrance.lat],
    destination,
    `walk from ${alight.entrance.name}`,
  );

  const transitFeatures: Feature[] = transitLegs.map((leg, i) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: leg.coordinates },
    properties: {
      kind: "transit",
      index: i,
      line: leg.line,
      from: leg.from,
      to: leg.to,
      distance_m: leg.distance_m,
      stroke: "#1E90FF",
    },
  }));

  const walkDistance =
    (Number(walkToBoard.properties.distance_m) || 0) +
    (Number(walkFromAlight.properties.distance_m) || 0);
  const transitDistance = transitLegs.reduce((s, l) => s + l.distance_m, 0);
  const totalDistance = walkDistance + transitDistance;

  const summary: Feature = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        ...(walkToBoard.geometry.coordinates as LngLat[]),
        ...transitLegs.flatMap((l) => l.coordinates),
        ...(walkFromAlight.geometry.coordinates as LngLat[]),
      ],
    },
    properties: {
      mode: "transit",
      provider: "tpe-mrt",
      board_station: board.station.name,
      alight_station: alight.station.name,
      transfers: Math.max(0, transitLegs.length - 1),
      lines: transitLegs.map((l) => l.line),
      distance_m: Math.round(totalDistance),
      stroke: "#1E90FF",
    },
  };

  return {
    type: "FeatureCollection",
    features: [summary, walkToBoard, ...transitFeatures, walkFromAlight],
    metadata: {
      mode: "transit",
      distance_m: Math.round(totalDistance),
      walk_distance_m: Math.round(walkDistance),
      transit_distance_m: Math.round(transitDistance),
      // Fraction of total trip distance covered by transit (vs walking).
      // 0 when distance_m == 0.
      transit_ratio: totalDistance > 0 ? transitDistance / totalDistance : 0,
    },
  };
}

export async function GET(request: NextRequest) {
  const parsed = parseSearchParams(request.nextUrl.searchParams);
  if ("error" in parsed)
    return Response.json({ error: parsed.error }, { status: 400 });

  const { origin, destination, mode } = parsed;

  try {
    const geojson =
      mode === "transit"
        ? await routeTransit(origin, destination)
        : mode === "pedestrian"
          ? await findPedestrianRouteFeatureCollection(origin, destination)
          : await routeViaOrs(origin, destination, mode);
    return Response.json(geojson);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown routing error";
    return Response.json({ error: message }, { status: 502 });
  }
}
