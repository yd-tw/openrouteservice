import { promises as fs } from "node:fs";
import path from "node:path";

export type LngLat = [number, number];

type LineString = { type: "LineString"; coordinates: LngLat[] };
type Feature = {
  type: "Feature";
  geometry: LineString;
  properties: Record<string, unknown>;
};
export type WalkFeatureCollection = {
  type: "FeatureCollection";
  features: Feature[];
};

type Ring = LngLat[];
type Polygon = Ring[];
export type AvoidMultiPolygon = {
  type: "MultiPolygon";
  coordinates: Polygon[];
};

// Per-meter cost multipliers. Lower = preferred. We route over sidewalks AND
// regular roads in the same graph; sidewalks cost 1× and roads cost 5×, so the
// algorithm prefers sidewalks but will fall back to roads where no sidewalk is
// reachable. Connectors (origin/destination snap edges + 50 m noding bridges
// between dangling LineString endpoints) are 1× — short by construction so the
// equal-to-sidewalk rate doesn't dominate.
const SIDEWALK_COST_MULTIPLIER = 1;
const ROAD_COST_MULTIPLIER = 5;
const CONNECTOR_COST_MULTIPLIER = 1;

export type EdgeKind = "sidewalk" | "road" | "connector";

const COST_BY_KIND: Record<EdgeKind, number> = {
  sidewalk: SIDEWALK_COST_MULTIPLIER,
  road: ROAD_COST_MULTIPLIER,
  connector: CONNECTOR_COST_MULTIPLIER,
};

const WALK_SPEED_MPS = 1.4; // ~5 km/h, matches OSRM/ORS foot-walking default

type SourceKind = "sidewalk" | "road";
const SOURCES: { file: string; kind: SourceKind }[] = [
  { file: "taipei.geojson", kind: "sidewalk" },
  { file: "ntpc.geojson", kind: "sidewalk" },
  { file: "taipei_road.geojson", kind: "road" },
];

// ~10 cm quantization. Tight enough to keep distinct intersections apart, loose
// enough to merge endpoints that two OSM ways share but represent slightly
// differently due to floating-point rounding in the source.
const NODE_KEY_DECIMALS = 6;

// Spatial-index cell size in degrees. ~500 m at Taipei latitude — a balance
// between cell occupancy and the number of cells we scan per snap.
const CELL_DEG = 0.005;

// OSM sidewalk LineStrings dangle at intersections in this dataset — the
// endpoint of one way often lands several metres from a perpendicular way's
// endpoint *or* the middle of a perpendicular way that should logically meet
// it. Without bridging we get >3,000 disconnected components and almost every
// A* query fails. The noding pass after loading connects each way endpoint to
// any other vertex within MERGE_RADIUS_M (endpoint *or* mid-LineString) using
// a non-sidewalk connector — the same 1× class as origin/destination
// connectors, so the algorithm treats it as a curb-cut/crossing. 50 m is the
// smallest radius at which the central-Taipei sidewalk graph collapses into a
// single dominant component for the test routes; smaller values leave too
// many fragments isolated. The cost is some across-street shortcuts where
// no real crossing exists — acceptable for first-cut pedestrian routing.
const MERGE_RADIUS_M = 50;

// Number of nearest segments each query endpoint is connected to. Using more
// than 1 lets A* pick the best entry/exit when the closest segment happens to
// be in a small isolated component — the data is fragmented enough that this
// matters. A budget of 6 is plenty in practice and adds <12 virtual edges.
const SNAP_K = 6;

interface Edge {
  to: number;
  distance_m: number;
  cost: number;
  kind: EdgeKind;
  // Polyline geometry of this edge (always [from, to] for a simple segment).
  coords: LngLat[];
}

interface Segment {
  fromId: number;
  toId: number;
  a: LngLat;
  b: LngLat;
  distance_m: number;
  kind: SourceKind;
}

interface Graph {
  nodes: LngLat[];
  adj: Edge[][];
  // segmentsByCell: cellKey -> array of segment indices that overlap that cell.
  segments: Segment[];
  segmentsByCell: Map<string, number[]>;
}

let graphPromise: Promise<Graph> | null = null;

function nodeKey(lng: number, lat: number): string {
  return `${lng.toFixed(NODE_KEY_DECIMALS)},${lat.toFixed(NODE_KEY_DECIMALS)}`;
}

function cellKey(lng: number, lat: number): string {
  return `${Math.floor(lng / CELL_DEG)}_${Math.floor(lat / CELL_DEG)}`;
}

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

async function loadGraph(): Promise<Graph> {
  const nodes: LngLat[] = [];
  const adj: Edge[][] = [];
  const nodeIds = new Map<string, number>();
  const segments: Segment[] = [];
  const wayEndpoints = new Set<number>();

  const addNode = (lng: number, lat: number): number => {
    const key = nodeKey(lng, lat);
    let id = nodeIds.get(key);
    if (id === undefined) {
      id = nodes.length;
      nodeIds.set(key, id);
      nodes.push([lng, lat]);
      adj.push([]);
    }
    return id;
  };

  const addEdge = (
    from: number,
    to: number,
    a: LngLat,
    b: LngLat,
    kind: SourceKind,
  ) => {
    if (from === to) return;
    const d = haversineM(a, b);
    if (d === 0) return;
    const cost = d * COST_BY_KIND[kind];
    adj[from].push({ to, distance_m: d, cost, kind, coords: [a, b] });
    adj[to].push({ to: from, distance_m: d, cost, kind, coords: [b, a] });
    segments.push({ fromId: from, toId: to, a, b, distance_m: d, kind });
  };

  for (const { file, kind } of SOURCES) {
    const filePath = path.join(process.cwd(), "public", file);
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as {
      features: {
        geometry: { type: string; coordinates: unknown };
        properties?: Record<string, unknown>;
      }[];
    };
    for (const feature of data.features) {
      const g = feature.geometry;
      if (!g || g.type !== "LineString") continue;
      // Drop road segments where pedestrians are explicitly forbidden. We
      // tolerate every other access tag (use_sidepath, customers, …) since
      // foot routing on local Taipei roads is permissive in practice.
      if (kind === "road" && feature.properties?.foot === "no") continue;
      const line = g.coordinates as LngLat[];
      if (!Array.isArray(line) || line.length < 2) continue;
      let prevId = addNode(line[0][0], line[0][1]);
      wayEndpoints.add(prevId);
      let prevPt = line[0];
      for (let i = 1; i < line.length; i++) {
        const pt = line[i];
        const id = addNode(pt[0], pt[1]);
        addEdge(prevId, id, prevPt, pt, kind);
        prevId = id;
        prevPt = pt;
      }
      wayEndpoints.add(prevId);
    }
  }

  // Noding pass: for each way endpoint, attach 1× connector edges to every
  // *other* node (endpoint or mid-LineString vertex) within MERGE_RADIUS_M.
  // We index every node, but only iterate from way-endpoints — that already
  // catches T-junctions where one way dead-ends into the side of another, and
  // doing it from endpoints keeps us from creating spurious shortcuts between
  // mid-vertices of two parallel sidewalks. Since MERGE_RADIUS_M (20 m) is
  // far less than CELL_DEG ≈ 555 m, we only need to scan the 9 neighbouring
  // cells per source.
  const nodesByCell = new Map<string, number[]>();
  for (let id = 0; id < nodes.length; id++) {
    const [lng, lat] = nodes[id];
    const key = cellKey(lng, lat);
    const list = nodesByCell.get(key);
    if (list) list.push(id);
    else nodesByCell.set(key, [id]);
  }
  // Track existing direct neighbors per source so we don't add duplicate edges.
  const seenNeighbors = new Set<string>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const id of wayEndpoints) {
    for (const e of adj[id]) seenNeighbors.add(pairKey(id, e.to));
  }
  for (const id of wayEndpoints) {
    const p = nodes[id];
    const cx = Math.floor(p[0] / CELL_DEG);
    const cy = Math.floor(p[1] / CELL_DEG);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = nodesByCell.get(`${cx + dx}_${cy + dy}`);
        if (!list) continue;
        for (const other of list) {
          if (other === id) continue;
          const key = pairKey(id, other);
          if (seenNeighbors.has(key)) continue;
          const q = nodes[other];
          const d = haversineM(p, q);
          if (d === 0 || d > MERGE_RADIUS_M) continue;
          seenNeighbors.add(key);
          const cost = d * CONNECTOR_COST_MULTIPLIER;
          adj[id].push({
            to: other,
            distance_m: d,
            cost,
            kind: "connector",
            coords: [p, q],
          });
          adj[other].push({
            to: id,
            distance_m: d,
            cost,
            kind: "connector",
            coords: [q, p],
          });
        }
      }
    }
  }

  const segmentsByCell = new Map<string, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const minLng = Math.min(s.a[0], s.b[0]);
    const maxLng = Math.max(s.a[0], s.b[0]);
    const minLat = Math.min(s.a[1], s.b[1]);
    const maxLat = Math.max(s.a[1], s.b[1]);
    const cMinX = Math.floor(minLng / CELL_DEG);
    const cMaxX = Math.floor(maxLng / CELL_DEG);
    const cMinY = Math.floor(minLat / CELL_DEG);
    const cMaxY = Math.floor(maxLat / CELL_DEG);
    for (let x = cMinX; x <= cMaxX; x++) {
      for (let y = cMinY; y <= cMaxY; y++) {
        const key = `${x}_${y}`;
        const list = segmentsByCell.get(key);
        if (list) list.push(i);
        else segmentsByCell.set(key, [i]);
      }
    }
  }

  return { nodes, adj, segments, segmentsByCell };
}

function getGraph(): Promise<Graph> {
  if (!graphPromise) graphPromise = loadGraph();
  return graphPromise;
}

// Project point p onto segment a-b in lng/lat space, treating it locally as
// planar. Returns the foot of perpendicular and t in [0, 1].
function projectOnSegment(
  p: LngLat,
  a: LngLat,
  b: LngLat,
): { foot: LngLat; t: number } {
  const ax = a[0];
  const ay = a[1];
  const bx = b[0];
  const by = b[1];
  // Compensate for longitude foreshortening so "perpendicular" is meaningful.
  const cosLat = Math.cos((ay * Math.PI) / 180);
  const dx = (bx - ax) * cosLat;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { foot: a, t: 0 };
  const px = (p[0] - ax) * cosLat;
  const py = p[1] - ay;
  let t = (px * dx + py * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return { foot: [ax + (bx - ax) * t, ay + (by - ay) * t], t };
}

interface Snap {
  segmentIndex: number;
  foot: LngLat;
  t: number;
  distance_m: number;
}

function nearestSegments(graph: Graph, point: LngLat, k: number): Snap[] {
  const cx = Math.floor(point[0] / CELL_DEG);
  const cy = Math.floor(point[1] / CELL_DEG);
  const found: Snap[] = [];
  const seenSegs = new Set<number>();
  // Grow the search outward; once we have ≥k candidates, do one extra ring to
  // catch any closer segment we'd otherwise miss at the boundary.
  let extraRingsAfterK = -1;
  for (let r = 0; r <= 80; r++) {
    if (extraRingsAfterK >= 0) {
      extraRingsAfterK++;
      if (extraRingsAfterK > 1) break;
    }
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (
          r > 0 &&
          x !== cx - r &&
          x !== cx + r &&
          y !== cy - r &&
          y !== cy + r
        )
          continue;
        const list = graph.segmentsByCell.get(`${x}_${y}`);
        if (!list) continue;
        for (const idx of list) {
          if (seenSegs.has(idx)) continue;
          seenSegs.add(idx);
          const s = graph.segments[idx];
          const proj = projectOnSegment(point, s.a, s.b);
          const d = haversineM(point, proj.foot);
          found.push({
            segmentIndex: idx,
            foot: proj.foot,
            t: proj.t,
            distance_m: d,
          });
        }
      }
    }
    if (extraRingsAfterK < 0 && found.length >= k) extraRingsAfterK = 0;
  }
  if (found.length === 0) {
    throw new Error(
      `No pedestrian network within search radius of [${point[0]}, ${point[1]}]`,
    );
  }
  found.sort((a, b) => a.distance_m - b.distance_m);
  return found.slice(0, k);
}

// Min-heap keyed by f-score. Stores (nodeId, f) pairs as a flat Float64Array
// pair for speed; the array doubles as needed.
class MinHeap {
  private ids: number[] = [];
  private fs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, f: number): void {
    this.ids.push(id);
    this.fs.push(f);
    this.bubbleUp(this.ids.length - 1);
  }

  pop(): { id: number; f: number } | undefined {
    const n = this.ids.length;
    if (n === 0) return undefined;
    const id = this.ids[0];
    const f = this.fs[0];
    const lastId = this.ids.pop()!;
    const lastF = this.fs.pop()!;
    if (n > 1) {
      this.ids[0] = lastId;
      this.fs[0] = lastF;
      this.sinkDown(0);
    }
    return { id, f };
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.fs[i] >= this.fs[parent]) break;
      [this.ids[i], this.ids[parent]] = [this.ids[parent], this.ids[i]];
      [this.fs[i], this.fs[parent]] = [this.fs[parent], this.fs[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.ids.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.fs[l] < this.fs[smallest]) smallest = l;
      if (r < n && this.fs[r] < this.fs[smallest]) smallest = r;
      if (smallest === i) break;
      [this.ids[i], this.ids[smallest]] = [this.ids[smallest], this.ids[i]];
      [this.fs[i], this.fs[smallest]] = [this.fs[smallest], this.fs[i]];
      i = smallest;
    }
  }
}

// Goal multiplier for the A* heuristic — must be a *lower bound* on per-meter
// cost across all reachable edges. The cheapest classes (sidewalk, connector)
// are 1×, so 1× keeps the heuristic admissible (and therefore A* optimal).
const HEURISTIC_MULTIPLIER = Math.min(
  SIDEWALK_COST_MULTIPLIER,
  ROAD_COST_MULTIPLIER,
  CONNECTOR_COST_MULTIPLIER,
);

interface PathEdge {
  coords: LngLat[]; // always [from, to] for a single A* hop
  kind: EdgeKind;
  distance_m: number;
}

interface AStarResult {
  // Edges in source → target order. Each consecutive pair shares a vertex
  // (edge[i].coords[1] === edge[i+1].coords[0]). The caller can stitch them
  // into a single polyline or group by kind to render mixed-style routes.
  edges: PathEdge[];
  distance_m: number;
  sidewalk_distance_m: number;
}

// Standard A* over the combined sidewalk + road graph. The two synthetic
// source/target nodes are wired in via virtualAdj — their outgoing edges land
// on the real graph at connector cost (1×) plus the cost along the split
// segment (sidewalk 1× or road 5×, whichever the snapped segment belongs to).
// `blockedNodes` (when present) is a Uint8Array indexed by node id; nodes
// flagged are excluded from expansion (used for avoid-polygon support).
function aStar(
  graph: Graph,
  sourceNode: number,
  targetNode: number,
  virtualNodes: LngLat[], // index 0 = source, 1 = target
  virtualAdj: Map<number, Edge[]>,
  goal: LngLat,
  blockedNodes: Uint8Array | null,
): AStarResult {
  const totalNodes = graph.nodes.length;
  // Source/target are addressed as totalNodes + i, where i is their index in virtualNodes.
  const virtBase = totalNodes;
  const nodeCount = totalNodes + virtualNodes.length;

  const coordOf = (id: number): LngLat =>
    id < virtBase ? graph.nodes[id] : virtualNodes[id - virtBase];

  const g = new Float64Array(nodeCount);
  g.fill(Infinity);
  g[sourceNode] = 0;

  const cameFrom = new Int32Array(nodeCount);
  cameFrom.fill(-1);
  // For path reconstruction, we also need the geometry of the edge that led
  // to each node, plus its kind so we can tally sidewalk vs road distance.
  const edgeIn: (LngLat[] | null)[] = new Array(nodeCount).fill(null);
  const edgeDist = new Float64Array(nodeCount);
  const edgeKind: (EdgeKind | null)[] = new Array(nodeCount).fill(null);

  const closed = new Uint8Array(nodeCount);
  const heap = new MinHeap();
  heap.push(
    sourceNode,
    haversineM(coordOf(sourceNode), goal) * HEURISTIC_MULTIPLIER,
  );

  const edgesFor = (id: number): Edge[] => {
    if (id >= virtBase) return virtualAdj.get(id) ?? [];
    return graph.adj[id];
  };

  while (heap.size > 0) {
    const top = heap.pop()!;
    const u = top.id;
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === targetNode) break;

    const gu = g[u];
    for (const e of edgesFor(u)) {
      if (closed[e.to]) continue;
      if (blockedNodes && e.to < virtBase && blockedNodes[e.to]) continue;
      const tentative = gu + e.cost;
      if (tentative < g[e.to]) {
        g[e.to] = tentative;
        cameFrom[e.to] = u;
        edgeIn[e.to] = e.coords;
        edgeDist[e.to] = e.distance_m;
        edgeKind[e.to] = e.kind;
        const f =
          tentative + haversineM(coordOf(e.to), goal) * HEURISTIC_MULTIPLIER;
        heap.push(e.to, f);
      }
    }
  }

  if (g[targetNode] === Infinity) {
    throw new Error("No pedestrian path between origin and destination");
  }

  // Reconstruct, walking backwards from target.
  const edges: PathEdge[] = [];
  let totalDist = 0;
  let sidewalkDist = 0;
  let cursor = targetNode;
  while (cursor !== sourceNode) {
    const seg = edgeIn[cursor];
    const k = edgeKind[cursor];
    if (!seg || !k) throw new Error("Path reconstruction broke");
    const d = edgeDist[cursor];
    edges.push({ coords: seg, kind: k, distance_m: d });
    totalDist += d;
    if (k === "sidewalk") sidewalkDist += d;
    cursor = cameFrom[cursor];
  }
  edges.reverse();

  return { edges, distance_m: totalDist, sidewalk_distance_m: sidewalkDist };
}

export interface PedestrianRouteSegment {
  // Polyline of this run, sharing endpoints with the neighbouring runs.
  coordinates: LngLat[];
  kind: EdgeKind;
  distance_m: number;
}

export interface PedestrianRoute {
  // Stitched whole-route polyline. Kept for callers that only need geometry
  // (e.g. transit walkLeg). Use `segments` to render mixed sidewalk/road
  // styling — this single polyline can't carry per-edge kind information.
  coordinates: LngLat[];
  // The route split into runs of consecutive same-kind edges, in order.
  // Use this to colour sidewalk runs vs. road / connector runs separately.
  segments: PedestrianRouteSegment[];
  distance_m: number;
  duration_s: number;
  // Length of the route that lies on actual sidewalks (vs. regular roads).
  sidewalk_distance_m: number;
  // sidewalk_distance_m / distance_m, in [0, 1]. 0 when distance_m == 0.
  sidewalk_ratio: number;
}

export interface FindPedestrianRouteOptions {
  // Optional MultiPolygon describing areas that the route must avoid. We mark
  // every graph node inside any polygon as blocked and skip expansion through
  // them. (The check is per-node, not per-segment — same coarse approach the
  // upstream avoid feature already uses by buffering 100 m circles around
  // obstacles, so endpoint inclusion is a good proxy for segment intersection.)
  avoid?: AvoidMultiPolygon | null;
}

// Standard ray-casting point-in-polygon. Treats the ring as closed.
function pointInRing(p: LngLat, ring: Ring): boolean {
  let inside = false;
  const x = p[0];
  const y = p[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInMultiPolygon(p: LngLat, mp: AvoidMultiPolygon): boolean {
  for (const poly of mp.coordinates) {
    if (poly.length === 0) continue;
    // Outer ring + inner holes. A point is "in" the polygon iff it's in the
    // outer ring AND not in any hole.
    if (!pointInRing(p, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) {
      if (pointInRing(p, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function buildBlockedNodes(graph: Graph, avoid: AvoidMultiPolygon): Uint8Array {
  // Compute the avoid-area's overall bounding box so we can short-circuit the
  // (relatively expensive) point-in-polygon test for the vast majority of
  // nodes that are far from any obstacle.
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const poly of avoid.coordinates) {
    for (const ring of poly) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }

  const blocked = new Uint8Array(graph.nodes.length);
  for (let i = 0; i < graph.nodes.length; i++) {
    const [lng, lat] = graph.nodes[i];
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;
    if (pointInMultiPolygon(graph.nodes[i], avoid)) blocked[i] = 1;
  }
  return blocked;
}

// For one query endpoint, allocate a user-point virtual node plus one snap-
// foot virtual node per candidate segment, with all the connector / split-
// segment edges wired in. The split-segment edges inherit the snapped
// segment's kind (sidewalk or road) so the cost and the sidewalk-distance
// tally use the correct multiplier. Returns the user-point virtual id and
// the list of real graph nodes that gained back-edges (so the caller can
// roll them back).
function wireEndpoint(
  graph: Graph,
  point: LngLat,
  snaps: Snap[],
  virtualNodes: LngLat[],
  virtualAdj: Map<number, Edge[]>,
): { pointId: number; touchedNodes: number[] } {
  const virtBase = graph.nodes.length;

  const userId = virtBase + virtualNodes.length;
  virtualNodes.push(point);
  const userEdges: Edge[] = [];

  const touchedNodes: number[] = [];

  for (const snap of snaps) {
    const seg = graph.segments[snap.segmentIndex];

    const footId = virtBase + virtualNodes.length;
    virtualNodes.push(snap.foot);

    const connectorDist = snap.distance_m;
    const connectorCost = connectorDist * CONNECTOR_COST_MULTIPLIER;

    userEdges.push({
      to: footId,
      distance_m: connectorDist,
      cost: connectorCost,
      kind: "connector",
      coords: [point, snap.foot],
    });

    const segLen = seg.distance_m;
    const distToA = segLen * snap.t;
    const distToB = segLen * (1 - snap.t);
    const segMul = COST_BY_KIND[seg.kind];

    const footEdges: Edge[] = [
      {
        to: userId,
        distance_m: connectorDist,
        cost: connectorCost,
        kind: "connector",
        coords: [snap.foot, point],
      },
      {
        to: seg.fromId,
        distance_m: distToA,
        cost: distToA * segMul,
        kind: seg.kind,
        coords: [snap.foot, seg.a],
      },
      {
        to: seg.toId,
        distance_m: distToB,
        cost: distToB * segMul,
        kind: seg.kind,
        coords: [snap.foot, seg.b],
      },
    ];
    virtualAdj.set(footId, footEdges);

    // Real graph endpoints get back-edges into this snap-foot so routes can
    // leave the network here too.
    graph.adj[seg.fromId].push({
      to: footId,
      distance_m: distToA,
      cost: distToA * segMul,
      kind: seg.kind,
      coords: [seg.a, snap.foot],
    });
    graph.adj[seg.toId].push({
      to: footId,
      distance_m: distToB,
      cost: distToB * segMul,
      kind: seg.kind,
      coords: [seg.b, snap.foot],
    });
    touchedNodes.push(seg.fromId, seg.toId);
  }

  virtualAdj.set(userId, userEdges);
  return { pointId: userId, touchedNodes };
}

// Undo the temporary back-edges we appended to graph.adj during wireEndpoint.
// Snapshotting the lengths beforehand and slicing them off is faster than
// filtering for the snap-foot virtual ids.
function snapshotAdj(graph: Graph, ids: number[]): number[] {
  return ids.map((id) => graph.adj[id].length);
}
function restoreAdj(graph: Graph, ids: number[], lengths: number[]): void {
  for (let i = 0; i < ids.length; i++) {
    graph.adj[ids[i]].length = lengths[i];
  }
}

export async function findPedestrianRoute(
  origin: LngLat,
  destination: LngLat,
  options: FindPedestrianRouteOptions = {},
): Promise<PedestrianRoute> {
  const graph = await getGraph();

  const virtualNodes: LngLat[] = [];
  const virtualAdj = new Map<number, Edge[]>();

  const originSnaps = nearestSegments(graph, origin, SNAP_K);
  const destSnaps = nearestSegments(graph, destination, SNAP_K);

  // Snapshot the rows of graph.adj we're about to mutate so we can roll them
  // back deterministically after the query, even if A* throws.
  const touched = [
    ...originSnaps.flatMap((s) => [
      graph.segments[s.segmentIndex].fromId,
      graph.segments[s.segmentIndex].toId,
    ]),
    ...destSnaps.flatMap((s) => [
      graph.segments[s.segmentIndex].fromId,
      graph.segments[s.segmentIndex].toId,
    ]),
  ];
  const before = snapshotAdj(graph, touched);

  const blockedNodes = options.avoid
    ? buildBlockedNodes(graph, options.avoid)
    : null;

  try {
    const o = wireEndpoint(
      graph,
      origin,
      originSnaps,
      virtualNodes,
      virtualAdj,
    );
    const d = wireEndpoint(
      graph,
      destination,
      destSnaps,
      virtualNodes,
      virtualAdj,
    );

    const result = aStar(
      graph,
      o.pointId,
      d.pointId,
      virtualNodes,
      virtualAdj,
      destination,
      blockedNodes,
    );

    // Group consecutive same-kind edges into runs so the caller can render
    // each run with its own style (sidewalk green, road/connector black, …).
    const segments: PedestrianRouteSegment[] = [];
    for (const e of result.edges) {
      const last = segments[segments.length - 1];
      if (last && last.kind === e.kind) {
        // Adjacent edges share a vertex (last.coordinates' tail ===
        // e.coords[0]), so append only the new endpoint to avoid duplicating
        // the joint.
        last.coordinates.push(...e.coords.slice(1));
        last.distance_m += e.distance_m;
      } else {
        segments.push({
          coordinates: [...e.coords],
          kind: e.kind,
          distance_m: e.distance_m,
        });
      }
    }

    // Stitch all runs into a single polyline for callers that only want
    // whole-route geometry (transit walkLeg, etc.).
    const coordinates: LngLat[] = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i].coordinates;
      if (i === 0) coordinates.push(...s);
      else coordinates.push(...s.slice(1));
    }

    return {
      coordinates,
      segments,
      distance_m: result.distance_m,
      duration_s: result.distance_m / WALK_SPEED_MPS,
      sidewalk_distance_m: result.sidewalk_distance_m,
      sidewalk_ratio:
        result.distance_m > 0
          ? result.sidewalk_distance_m / result.distance_m
          : 0,
    };
  } finally {
    restoreAdj(graph, touched, before);
  }
}

// Stroke colours per surface kind. Sidewalks render green; everything else
// (road carriageway, snap connector, noding bridge) renders black so the
// caller can show "user is currently not on a sidewalk" segments at a glance.
const STROKE_BY_KIND: Record<EdgeKind, string> = {
  sidewalk: "#22C55E",
  road: "#000000",
  connector: "#000000",
};

// Convenience helper that wraps the A* result in a FeatureCollection. We
// emit one Feature per run of consecutive same-kind edges so the caller can
// style sidewalk vs. non-sidewalk segments differently — a single stitched
// LineString can't carry mixed styling. Aggregate route stats live on the
// first feature's properties (matching the previous shape).
export async function findPedestrianRouteFeatureCollection(
  origin: LngLat,
  destination: LngLat,
  options: FindPedestrianRouteOptions = {},
): Promise<WalkFeatureCollection> {
  const route = await findPedestrianRoute(origin, destination, options);
  const features = route.segments.map((s, i) => ({
    type: "Feature" as const,
    geometry: {
      type: "LineString" as const,
      coordinates: s.coordinates,
    },
    properties: {
      kind: s.kind,
      segment_distance_m: s.distance_m,
      stroke: STROKE_BY_KIND[s.kind],
      ...(i === 0
        ? {
            mode: "pedestrian",
            provider: "astar-sidewalks-roads",
            distance_m: route.distance_m,
            duration_s: route.duration_s,
            sidewalk_distance_m: route.sidewalk_distance_m,
            sidewalk_ratio: route.sidewalk_ratio,
            sidewalk_cost_multiplier: SIDEWALK_COST_MULTIPLIER,
            road_cost_multiplier: ROAD_COST_MULTIPLIER,
          }
        : {}),
    },
  }));
  return { type: "FeatureCollection", features };
}
