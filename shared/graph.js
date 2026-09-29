/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Réseau piéton : construction du graphe à partir des chemins relevés, puis calcul d'itinéraire (A*).
// À l'échelle du campus, le graphe se construit en quelques millisecondes, directement sur le téléphone.

import { createProjector, projectOnSegment, getSegmentIntersection, getPlaneDistance } from './geo.js';

// Types de chemins : code technique (anglais) et libellé affiché (français).
export const PATH_TYPES = {
  footpath: 'Allée piétonne',
  road: 'Route ou voie carrossable',
  track: 'Piste en terre',
  corridor: 'Couloir ou passage couvert',
  stairs: 'Escaliers',
};

export const DEFAULT_PATH_TYPE = 'footpath';

const DEFAULT_SNAP_METERS = 2.5;
const DEFAULT_ATTACH_METERS = 3;
const SPATIAL_CELL_METERS = 25;

// Index spatial en grille : limite les comparaisons aux éléments voisins.
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  getCellRange(minimum, maximum) {
    return [Math.floor(minimum / this.cellSize), Math.floor(maximum / this.cellSize)];
  }

  insert(itemId, minX, minY, maxX, maxY) {
    const [firstColumn, lastColumn] = this.getCellRange(minX, maxX);
    const [firstRow, lastRow] = this.getCellRange(minY, maxY);
    for (let column = firstColumn; column <= lastColumn; column++) {
      for (let row = firstRow; row <= lastRow; row++) {
        const cellKey = `${column}:${row}`;
        if (!this.cells.has(cellKey)) this.cells.set(cellKey, []);
        this.cells.get(cellKey).push(itemId);
      }
    }
  }

  query(minX, minY, maxX, maxY) {
    const found = new Set();
    const [firstColumn, lastColumn] = this.getCellRange(minX, maxX);
    const [firstRow, lastRow] = this.getCellRange(minY, maxY);
    for (let column = firstColumn; column <= lastColumn; column++) {
      for (let row = firstRow; row <= lastRow; row++) {
        for (const itemId of this.cells.get(`${column}:${row}`) || []) found.add(itemId);
      }
    }
    return found;
  }
}

function createEmptyGraph() {
  return { projector: createProjector(0), nodes: [], edges: [], adjacency: [] };
}

function getSegmentBounds(segment, margin) {
  return [
    Math.min(segment.start[0], segment.end[0]) - margin,
    Math.min(segment.start[1], segment.end[1]) - margin,
    Math.max(segment.start[0], segment.end[0]) + margin,
    Math.max(segment.start[1], segment.end[1]) + margin,
  ];
}

/**
 * Construit le graphe piéton.
 * - Les sommets distants de moins de `snapMeters` sont fusionnés.
 * - Deux chemins qui se croisent sont reliés au point de croisement.
 * - Un sommet posé à moins de `attachMeters` du milieu d'un autre chemin s'y raccorde (jonction en T).
 */
export function buildGraph(paths, { snapMeters = DEFAULT_SNAP_METERS, attachMeters = DEFAULT_ATTACH_METERS } = {}) {
  const usablePaths = (paths || []).filter((path) => Array.isArray(path.coordinates) && path.coordinates.length >= 2);
  if (!usablePaths.length) return createEmptyGraph();

  let latitudeSum = 0;
  let pointCount = 0;
  for (const path of usablePaths) {
    for (const coordinate of path.coordinates) {
      latitudeSum += coordinate[1];
      pointCount++;
    }
  }
  const projector = createProjector(latitudeSum / pointCount);

  const segments = [];
  usablePaths.forEach((path, pathIndex) => {
    const planePoints = path.coordinates.map(projector.toPlane);
    for (let index = 1; index < planePoints.length; index++) {
      segments.push({
        start: planePoints[index - 1],
        end: planePoints[index],
        pathIndex,
        positionInPath: index,
        splits: [
          { ratio: 0, point: planePoints[index - 1] },
          { ratio: 1, point: planePoints[index] },
        ],
      });
    }
  });

  const segmentGrid = new SpatialGrid(SPATIAL_CELL_METERS);
  segments.forEach((segment, segmentId) => segmentGrid.insert(segmentId, ...getSegmentBounds(segment, attachMeters)));

  segments.forEach((segment, segmentId) => {
    for (const otherId of segmentGrid.query(...getSegmentBounds(segment, attachMeters))) {
      const other = segments[otherId];
      const isConsecutiveInSamePath =
        other.pathIndex === segment.pathIndex && Math.abs(other.positionInPath - segment.positionInPath) === 1;
      if (otherId > segmentId && !isConsecutiveInSamePath) {
        const crossing = getSegmentIntersection(segment.start, segment.end, other.start, other.end);
        if (crossing) {
          const crossingPoint = [
            segment.start[0] + crossing.firstRatio * (segment.end[0] - segment.start[0]),
            segment.start[1] + crossing.firstRatio * (segment.end[1] - segment.start[1]),
          ];
          segment.splits.push({ ratio: crossing.firstRatio, point: crossingPoint });
          other.splits.push({ ratio: crossing.secondRatio, point: crossingPoint });
        }
      }
      if (otherId !== segmentId) {
        for (const endpoint of [segment.start, segment.end]) {
          const projection = projectOnSegment(endpoint, other.start, other.end);
          const isInsideSegment = projection.ratio > 1e-6 && projection.ratio < 1 - 1e-6;
          if (projection.distance <= attachMeters && isInsideSegment) {
            other.splits.push({ ratio: projection.ratio, point: endpoint });
          }
        }
      }
    }
  });

  const nodes = [];
  const nodeGrid = new SpatialGrid(snapMeters);
  const getOrCreateNode = (planePoint) => {
    const [x, y] = planePoint;
    for (const nodeId of nodeGrid.query(x - snapMeters, y - snapMeters, x + snapMeters, y + snapMeters)) {
      if (getPlaneDistance(nodes[nodeId].planePoint, planePoint) <= snapMeters) return nodeId;
    }
    const nodeId = nodes.length;
    nodes.push({ planePoint, lonLat: projector.toLonLat(planePoint) });
    nodeGrid.insert(nodeId, x, y, x, y);
    return nodeId;
  };

  const edges = [];
  const adjacency = [];
  const knownEdges = new Set();
  for (const segment of segments) {
    segment.splits.sort((first, second) => first.ratio - second.ratio);
    const nodeIds = segment.splits.map((split) => getOrCreateNode(split.point));
    const path = usablePaths[segment.pathIndex];
    const pathType = path.type || DEFAULT_PATH_TYPE;
    for (let index = 1; index < nodeIds.length; index++) {
      const fromNode = nodeIds[index - 1];
      const toNode = nodeIds[index];
      if (fromNode === toNode) continue;
      const edgeKey = `${Math.min(fromNode, toNode)}-${Math.max(fromNode, toNode)}:${pathType}`;
      if (knownEdges.has(edgeKey)) continue;
      knownEdges.add(edgeKey);
      const edgeId = edges.length;
      edges.push({
        fromNode,
        toNode,
        length: getPlaneDistance(nodes[fromNode].planePoint, nodes[toNode].planePoint),
        type: pathType,
        isFloodProne: Boolean(path.isFloodProne),
        pathId: path.id,
      });
      (adjacency[fromNode] ||= []).push({ neighbor: toNode, edgeId });
      (adjacency[toNode] ||= []).push({ neighbor: fromNode, edgeId });
    }
  }
  return { projector, nodes, edges, adjacency };
}

export function isEdgeAllowed(edge, options = {}) {
  if (options.avoidStairs && edge.type === 'stairs') return false;
  if (options.avoidFlood && edge.isFloodProne) return false;
  return true;
}

// Tronçon autorisé le plus proche d'un point.
export function findNearestEdge(graph, lonLat, options = {}) {
  const planePoint = graph.projector.toPlane(lonLat);
  let nearest = null;
  graph.edges.forEach((edge, edgeId) => {
    if (!isEdgeAllowed(edge, options)) return;
    const projection = projectOnSegment(
      planePoint,
      graph.nodes[edge.fromNode].planePoint,
      graph.nodes[edge.toNode].planePoint,
    );
    if (!nearest || projection.distance < nearest.distance) {
      nearest = { edgeId, ratio: projection.ratio, planePoint: projection.point, distance: projection.distance };
    }
  });
  return nearest;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(priority, value) {
    const items = this.items;
    items.push([priority, value]);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent][0] <= items[index][0]) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === index) break;
        [items[smallest], items[index]] = [items[index], items[smallest]];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * Itinéraire piéton du point `origin` vers la plus proche des `targets` (les entrées d'un bâtiment).
 * Renvoie null si aucun chemin ne relie les deux points avec les options demandées.
 */
export function findRoute(graph, origin, targets, options = {}) {
  if (!graph.edges.length || !targets.length) return null;
  const start = findNearestEdge(graph, origin, options);
  if (!start) return null;
  const destinations = targets
    .map((target, targetIndex) => ({ target, targetIndex, snap: findNearestEdge(graph, target, options) }))
    .filter((destination) => destination.snap);
  if (!destinations.length) return null;

  // Nœuds virtuels : le départ, une arrivée par entrée, puis un but unique relié à toutes les arrivées.
  const nodeCount = graph.nodes.length;
  const startNode = nodeCount;
  const goalNode = nodeCount + 1 + destinations.length;
  const getPlanePoint = (nodeId) => {
    if (nodeId < nodeCount) return graph.nodes[nodeId].planePoint;
    if (nodeId === startNode) return start.planePoint;
    return destinations[nodeId - nodeCount - 1].snap.planePoint;
  };

  const virtualLinks = new Map();
  const addVirtualLink = (fromNode, toNode, length, isOneWay = false) => {
    if (!virtualLinks.has(fromNode)) virtualLinks.set(fromNode, []);
    virtualLinks.get(fromNode).push({ neighbor: toNode, length });
    if (isOneWay) return;
    if (!virtualLinks.has(toNode)) virtualLinks.set(toNode, []);
    virtualLinks.get(toNode).push({ neighbor: fromNode, length });
  };
  const attachToEdge = (virtualNode, snap) => {
    const edge = graph.edges[snap.edgeId];
    addVirtualLink(virtualNode, edge.fromNode, snap.ratio * edge.length);
    addVirtualLink(virtualNode, edge.toNode, (1 - snap.ratio) * edge.length);
  };
  attachToEdge(startNode, start);
  destinations.forEach((destination, position) => {
    const arrivalNode = nodeCount + 1 + position;
    attachToEdge(arrivalNode, destination.snap);
    if (destination.snap.edgeId === start.edgeId) {
      const edgeLength = graph.edges[start.edgeId].length;
      addVirtualLink(startNode, arrivalNode, Math.abs(destination.snap.ratio - start.ratio) * edgeLength);
    }
    addVirtualLink(arrivalNode, goalNode, destination.snap.distance, true);
  });

  const estimateRemaining = (nodeId) => {
    if (nodeId === goalNode) return 0;
    const planePoint = getPlanePoint(nodeId);
    let best = Infinity;
    for (const destination of destinations) {
      best = Math.min(best, getPlaneDistance(planePoint, destination.snap.planePoint) + destination.snap.distance);
    }
    return best;
  };

  const totalNodes = goalNode + 1;
  const costFromStart = new Float64Array(totalNodes).fill(Infinity);
  const previousNode = new Int32Array(totalNodes).fill(-1);
  const isClosed = new Uint8Array(totalNodes);
  const openSet = new MinHeap();
  costFromStart[startNode] = 0;
  openSet.push(estimateRemaining(startNode), startNode);

  while (openSet.size) {
    const [, currentNode] = openSet.pop();
    if (isClosed[currentNode]) continue;
    isClosed[currentNode] = 1;
    if (currentNode === goalNode) break;
    const relax = (neighbor, length) => {
      if (isClosed[neighbor]) return;
      const candidateCost = costFromStart[currentNode] + length;
      if (candidateCost < costFromStart[neighbor]) {
        costFromStart[neighbor] = candidateCost;
        previousNode[neighbor] = currentNode;
        openSet.push(candidateCost + estimateRemaining(neighbor), neighbor);
      }
    };
    if (currentNode < nodeCount) {
      for (const { neighbor, edgeId } of graph.adjacency[currentNode] || []) {
        const edge = graph.edges[edgeId];
        if (isEdgeAllowed(edge, options)) relax(neighbor, edge.length);
      }
    }
    for (const link of virtualLinks.get(currentNode) || []) relax(link.neighbor, link.length);
  }
  if (!Number.isFinite(costFromStart[goalNode])) return null;

  const nodeChain = [];
  for (let nodeId = previousNode[goalNode]; nodeId !== -1; nodeId = previousNode[nodeId]) nodeChain.push(nodeId);
  nodeChain.reverse();
  const arrival = destinations[nodeChain[nodeChain.length - 1] - nodeCount - 1];

  const coordinates = [];
  const appendCoordinate = (lonLat) => {
    const previous = coordinates[coordinates.length - 1];
    if (!previous || previous[0] !== lonLat[0] || previous[1] !== lonLat[1]) coordinates.push(lonLat);
  };
  if (start.distance > 0.5) appendCoordinate(origin);
  for (const nodeId of nodeChain) appendCoordinate(graph.projector.toLonLat(getPlanePoint(nodeId)));
  if (arrival.snap.distance > 0.5) appendCoordinate(arrival.target);

  return {
    coordinates,
    length: start.distance + costFromStart[goalNode],
    startOffset: start.distance,
    endOffset: arrival.snap.distance,
    targetIndex: arrival.targetIndex,
  };
}
