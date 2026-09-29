/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Consignes de guidage en français, ancrées sur des repères (bâtiments proches) plutôt que sur des distances seules.

import { getBearing, getDistance } from './geo.js';

const CARDINAL_DIRECTIONS = [
  'le nord',
  'le nord-est',
  "l'est",
  'le sud-est',
  'le sud',
  'le sud-ouest',
  "l'ouest",
  'le nord-ouest',
];
const MIN_TURN_DEGREES = 35;
const SLIGHT_TURN_DEGREES = 60;
const U_TURN_DEGREES = 150;
const MIN_STEP_METERS = 6;
const LANDMARK_RADIUS_METERS = 25;
// Vitesse de marche retenue : 1,2 m/s (environ 4,3 km/h), allure prudente sur un campus en terre et en pente.
export const WALKING_SPEED_METERS_PER_SECOND = 1.2;

export function getCardinalDirection(degrees) {
  return CARDINAL_DIRECTIONS[Math.round(degrees / 45) % 8];
}

export function getTurnAngle(fromBearing, toBearing) {
  let angle = toBearing - fromBearing;
  while (angle > 180) angle -= 360;
  while (angle <= -180) angle += 360;
  return angle;
}

export function describeTurn(angle) {
  const absoluteAngle = Math.abs(angle);
  const side = angle > 0 ? 'droite' : 'gauche';
  if (absoluteAngle < MIN_TURN_DEGREES) return null;
  if (absoluteAngle < SLIGHT_TURN_DEGREES) return `Prenez légèrement à ${side}`;
  if (absoluteAngle < U_TURN_DEGREES) return `Tournez à ${side}`;
  return 'Faites demi-tour';
}

export function formatDistance(meters) {
  if (meters < 10) return `${Math.max(1, Math.round(meters))} m`;
  if (meters < 1000) return `${Math.round(meters / 5) * 5} m`;
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

export function formatDuration(meters, speed = WALKING_SPEED_METERS_PER_SECOND) {
  return `${Math.max(1, Math.round(meters / speed / 60))} min`;
}

function findNearestLandmark(position, places, excludedPlaceId) {
  let nearest = null;
  for (const place of places) {
    if (place.id === excludedPlaceId) continue;
    const distance = getDistance(position, [place.longitude, place.latitude]);
    if (distance <= LANDMARK_RADIUS_METERS && (!nearest || distance < nearest.distance)) {
      nearest = { place, distance };
    }
  }
  return nearest ? nearest.place : null;
}

// Regroupe les petits zigzags du tracé en tronçons de direction homogène.
function groupIntoLegs(points) {
  const legs = [];
  for (let index = 1; index < points.length; index++) {
    const length = getDistance(points[index - 1], points[index]);
    const bearing = getBearing(points[index - 1], points[index]);
    const currentLeg = legs[legs.length - 1];
    if (currentLeg && Math.abs(getTurnAngle(currentLeg.bearing, bearing)) < MIN_TURN_DEGREES) {
      currentLeg.length += length;
      currentLeg.end = points[index];
      if (length > 3) currentLeg.bearing = bearing;
    } else {
      legs.push({ start: points[index - 1], end: points[index], length, bearing, startBearing: bearing });
    }
  }
  // Les tronçons de quelques mètres (raccord vers une porte, jonction imprécise) ne méritent pas de consigne.
  for (let index = legs.length - 1; index >= 1; index--) {
    if (legs[index].length < MIN_STEP_METERS) {
      legs[index - 1].length += legs[index].length;
      legs[index - 1].end = legs[index].end;
      legs.splice(index, 1);
    }
  }
  if (legs.length > 1 && legs[0].length < MIN_STEP_METERS) {
    legs[1].length += legs[0].length;
    legs[1].start = legs[0].start;
    legs.shift();
  }
  return legs;
}

export function buildRouteSteps(coordinates, { places = [], destination = null, entranceNote = '' } = {}) {
  const points = [];
  for (const coordinate of coordinates) {
    if (!points.length || getDistance(points[points.length - 1], coordinate) >= 1) points.push(coordinate);
  }
  if (points.length === 1 && coordinates.length > 1) points.push(coordinates[coordinates.length - 1]);

  const arrivalStep = {
    kind: 'arrival',
    text: destination ? `Vous êtes arrivé : ${destination.name}` : 'Vous êtes arrivé',
    detail: entranceNote || '',
    distance: 0,
    position: points[points.length - 1] || coordinates[0],
  };
  if (points.length < 2) return [arrivalStep];

  const legs = groupIntoLegs(points);
  const steps = [
    {
      kind: 'departure',
      text: `Partez vers ${getCardinalDirection(legs[0].startBearing)}`,
      detail: '',
      distance: legs[0].length,
      position: legs[0].start,
    },
  ];
  for (let index = 1; index < legs.length; index++) {
    const angle = getTurnAngle(legs[index - 1].bearing, legs[index].startBearing);
    const landmark = findNearestLandmark(legs[index].start, places, destination && destination.id);
    steps.push({
      kind: 'turn',
      text: describeTurn(angle) || 'Continuez tout droit',
      detail: landmark ? `au niveau de ${landmark.name}` : '',
      distance: legs[index].length,
      position: legs[index].start,
    });
  }
  steps.push(arrivalStep);
  return steps;
}
