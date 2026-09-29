/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Outils géométriques. Coordonnées au format [longitude, latitude] (ordre GeoJSON).
// À l'échelle d'un campus, une projection équirectangulaire locale suffit :
// l'erreur reste très inférieure au centimètre sur quelques kilomètres.

export const EARTH_RADIUS_METERS = 6371008.8;
const DEGREES_TO_RADIANS = Math.PI / 180;

export function getDistance(from, to) {
  const latitudeDelta = (to[1] - from[1]) * DEGREES_TO_RADIANS;
  const longitudeDelta = (to[0] - from[0]) * DEGREES_TO_RADIANS;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from[1] * DEGREES_TO_RADIANS) * Math.cos(to[1] * DEGREES_TO_RADIANS) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function createProjector(referenceLatitude) {
  const metersPerDegreeLatitude = EARTH_RADIUS_METERS * DEGREES_TO_RADIANS;
  const metersPerDegreeLongitude = metersPerDegreeLatitude * Math.cos(referenceLatitude * DEGREES_TO_RADIANS);
  return {
    toPlane: ([longitude, latitude]) => [longitude * metersPerDegreeLongitude, latitude * metersPerDegreeLatitude],
    toLonLat: ([x, y]) => [x / metersPerDegreeLongitude, y / metersPerDegreeLatitude],
  };
}

export function getPlaneDistance(from, to) {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

// Projection orthogonale d'un point sur le segment [start, end] (coordonnées planes).
// `ratio` vaut 0 au début du segment et 1 à la fin.
export function projectOnSegment(point, start, end) {
  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  const rawRatio =
    squaredLength === 0 ? 0 : ((point[0] - start[0]) * deltaX + (point[1] - start[1]) * deltaY) / squaredLength;
  const ratio = Math.max(0, Math.min(1, rawRatio));
  const projected = [start[0] + ratio * deltaX, start[1] + ratio * deltaY];
  return { ratio, point: projected, distance: getPlaneDistance(point, projected) };
}

// Intersection stricte de deux segments [firstStart, firstEnd] et [secondStart, secondEnd].
// Renvoie la position relative du croisement sur chacun, ou null.
export function getSegmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const first = [firstEnd[0] - firstStart[0], firstEnd[1] - firstStart[1]];
  const second = [secondEnd[0] - secondStart[0], secondEnd[1] - secondStart[1]];
  const denominator = first[0] * second[1] - first[1] * second[0];
  if (Math.abs(denominator) < 1e-9) return null;
  const offset = [secondStart[0] - firstStart[0], secondStart[1] - firstStart[1]];
  const firstRatio = (offset[0] * second[1] - offset[1] * second[0]) / denominator;
  const secondRatio = (offset[0] * first[1] - offset[1] * first[0]) / denominator;
  if (firstRatio <= 0 || firstRatio >= 1 || secondRatio <= 0 || secondRatio >= 1) return null;
  return { firstRatio, secondRatio };
}

// Cap en degrés (0 = nord, 90 = est) du point `from` vers le point `to`.
export function getBearing(from, to) {
  const fromLatitude = from[1] * DEGREES_TO_RADIANS;
  const toLatitude = to[1] * DEGREES_TO_RADIANS;
  const longitudeDelta = (to[0] - from[0]) * DEGREES_TO_RADIANS;
  const east = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const north =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);
  return (Math.atan2(east, north) / DEGREES_TO_RADIANS + 360) % 360;
}

export function getLineLength(coordinates) {
  let total = 0;
  for (let index = 1; index < coordinates.length; index++) {
    total += getDistance(coordinates[index - 1], coordinates[index]);
  }
  return total;
}

// Position d'un point par rapport à une polyligne : point le plus proche, écart et distance déjà parcourue.
export function locateOnLine(coordinates, position) {
  const projector = createProjector(position[1]);
  const planePosition = projector.toPlane(position);
  let closest = null;
  let travelled = 0;
  for (let index = 1; index < coordinates.length; index++) {
    const start = projector.toPlane(coordinates[index - 1]);
    const end = projector.toPlane(coordinates[index]);
    const projection = projectOnSegment(planePosition, start, end);
    const segmentLength = getPlaneDistance(start, end);
    if (!closest || projection.distance < closest.offset) {
      closest = {
        offset: projection.distance,
        along: travelled + projection.ratio * segmentLength,
        point: projector.toLonLat(projection.point),
        segmentIndex: index - 1,
      };
    }
    travelled += segmentLength;
  }
  return closest;
}

// Simplification Douglas-Peucker (tolérance en mètres), utile pour les traces GPS.
export function simplifyLine(coordinates, toleranceMeters = 1.5) {
  if (coordinates.length < 3) return coordinates.slice();
  const projector = createProjector(coordinates[0][1]);
  const planePoints = coordinates.map(projector.toPlane);
  const isKept = new Uint8Array(planePoints.length);
  isKept[0] = 1;
  isKept[planePoints.length - 1] = 1;
  const pendingRanges = [[0, planePoints.length - 1]];
  while (pendingRanges.length) {
    const [firstIndex, lastIndex] = pendingRanges.pop();
    let farthestDistance = 0;
    let farthestIndex = -1;
    for (let index = firstIndex + 1; index < lastIndex; index++) {
      const { distance } = projectOnSegment(planePoints[index], planePoints[firstIndex], planePoints[lastIndex]);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    }
    if (farthestIndex !== -1 && farthestDistance > toleranceMeters) {
      isKept[farthestIndex] = 1;
      pendingRanges.push([firstIndex, farthestIndex], [farthestIndex, lastIndex]);
    }
  }
  return coordinates.filter((_, index) => isKept[index]);
}

// Polygone approchant un cercle de rayon donné en mètres (cercle de précision GPS).
export function createCirclePolygon(center, radiusMeters, stepCount = 48) {
  const projector = createProjector(center[1]);
  const planeCenter = projector.toPlane(center);
  const ring = [];
  for (let step = 0; step <= stepCount; step++) {
    const angle = (step / stepCount) * 2 * Math.PI;
    ring.push(
      projector.toLonLat([
        planeCenter[0] + radiusMeters * Math.cos(angle),
        planeCenter[1] + radiusMeters * Math.sin(angle),
      ]),
    );
  }
  return ring;
}
