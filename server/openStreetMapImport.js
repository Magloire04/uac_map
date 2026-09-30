/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Conversion d'une réponse Overpass (OpenStreetMap) vers le format de l'appli.
// Données © contributeurs OpenStreetMap, licence ODbL : une carte importée hérite de cette licence.

import { getDistance, isValidPerimeter } from '../shared/geo.js';

export const UAC_BOUNDARY_WAY_ID = 347214829; // contour de l'université dans OpenStreetMap
const ENTRANCE_ATTACH_METERS = 40;

export const OVERPASS_QUERY = `[out:json][timeout:120];
way(${UAC_BOUNDARY_WAY_ID})->.boundary;
.boundary map_to_area->.campus;
(
  .boundary;
  way["highway"~"^(footway|path|pedestrian|steps|corridor|service|residential|living_street|unclassified|track|tertiary|secondary|primary)$"](area.campus);
  nwr["name"](area.campus);
  node["entrance"](area.campus);
);
out geom;`;

export const PERIMETER_QUERY = `[out:json][timeout:60];
way(${UAC_BOUNDARY_WAY_ID});
out geom;`;

const PATH_TYPE_BY_HIGHWAY = {
  steps: 'stairs',
  footway: 'footpath',
  path: 'footpath',
  pedestrian: 'footpath',
  corridor: 'corridor',
  track: 'track',
};

const roundCoordinate = (value) => Math.round(value * 1e7) / 1e7;

export function getCategoryFromTags(tags = {}) {
  const name = (tags.name || '').toLowerCase();
  const amenity = tags.amenity;
  if (/amphi/.test(name)) return 'lecture-hall';
  if (['restaurant', 'cafe', 'fast_food', 'food_court', 'canteen'].includes(amenity)) return 'food';
  if (amenity === 'library' || /biblioth/.test(name)) return 'library';
  if (['clinic', 'hospital', 'doctors', 'pharmacy'].includes(amenity) || /infirmerie|sant[eé]/.test(name))
    return 'health';
  if (amenity === 'place_of_worship') return 'worship';
  if (['parking', 'bus_station', 'taxi', 'bicycle_parking'].includes(amenity)) return 'transport';
  if (['bank', 'atm', 'post_office', 'bureau_de_change'].includes(amenity) || tags.shop) return 'service';
  if (['pitch', 'sports_centre', 'stadium', 'track'].includes(tags.leisure)) return 'sport';
  if (tags.building === 'dormitory' || /r[ée]sidence|cit[ée] universitaire/.test(name)) return 'housing';
  if (tags.office || /rectorat|administration|scolarit|d[ée]canat/.test(name)) return 'administration';
  if (
    ['university', 'college', 'school'].includes(amenity) ||
    ['university', 'college', 'school'].includes(tags.building)
  ) {
    return 'faculty';
  }
  if (tags.barrier === 'gate' || /portail/.test(name)) return 'gate';
  if (tags.building === 'classroom' || /salle/.test(name)) return 'classroom';
  return 'other';
}

function getCentroid(geometry) {
  const points = geometry.map((vertex) => [vertex.lon, vertex.lat]);
  if (points.length > 1) {
    const [first, last] = [points[0], points[points.length - 1]];
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  const sum = points.reduce((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function getElementPosition(element) {
  if (element.type === 'node') return [element.lon, element.lat];
  if (element.geometry && element.geometry.length) return getCentroid(element.geometry);
  if (element.bounds) {
    const { minlon, maxlon, minlat, maxlat } = element.bounds;
    return [(minlon + maxlon) / 2, (minlat + maxlat) / 2];
  }
  return null;
}

export function convertOverpassResponse(overpassResponse) {
  const elements = overpassResponse?.elements || [];
  const paths = [];
  const places = [];
  const entranceNodes = [];
  const buildingNodeIds = new Map();
  let boundary = null;

  for (const element of elements) {
    const tags = element.tags || {};
    if (element.type === 'way' && element.id === UAC_BOUNDARY_WAY_ID) {
      boundary = element;
      continue;
    }
    if (element.type === 'node' && tags.entrance) entranceNodes.push(element);
    if (element.type === 'way' && tags.highway && element.geometry?.length >= 2) {
      paths.push({
        id: `osm_way_${element.id}`,
        type: PATH_TYPE_BY_HIGHWAY[tags.highway] || 'road',
        name: tags.name || '',
        isFloodProne: false,
        coordinates: element.geometry.map((vertex) => [roundCoordinate(vertex.lon), roundCoordinate(vertex.lat)]),
      });
      continue;
    }
    if (!tags.name || tags.highway) continue;
    const position = getElementPosition(element);
    if (!position) continue;
    const place = {
      id: `osm_${element.type}_${element.id}`,
      name: tags.name.slice(0, 120),
      category: getCategoryFromTags(tags),
      aliases: [tags.short_name, tags.alt_name, tags.official_name].filter(Boolean).map((alias) => alias.slice(0, 60)),
      description: (tags.description || '').slice(0, 1000),
      access: '',
      longitude: roundCoordinate(position[0]),
      latitude: roundCoordinate(position[1]),
      entrances: [],
    };
    places.push(place);
    if (element.type === 'way' && Array.isArray(element.nodes)) buildingNodeIds.set(place.id, new Set(element.nodes));
  }

  // Chaque entrée OSM rejoint le bâtiment qui la contient, sinon le lieu nommé le plus proche.
  let attachedEntranceCount = 0;
  for (const node of entranceNodes) {
    let owner = places.find((place) => buildingNodeIds.get(place.id)?.has(node.id));
    if (!owner) {
      let smallestDistance = Infinity;
      for (const place of places) {
        const distance = getDistance([place.longitude, place.latitude], [node.lon, node.lat]);
        if (distance < smallestDistance && distance <= ENTRANCE_ATTACH_METERS) {
          smallestDistance = distance;
          owner = place;
        }
      }
    }
    if (owner && owner.entrances.length < 10) {
      owner.entrances.push({
        longitude: roundCoordinate(node.lon),
        latitude: roundCoordinate(node.lat),
        note: (node.tags.name || node.tags.ref || '').slice(0, 120),
      });
      attachedEntranceCount++;
    }
  }

  const center = boundary?.geometry ? getCentroid(boundary.geometry).map(roundCoordinate) : null;
  return {
    paths,
    places,
    center,
    counts: { paths: paths.length, places: places.length, entrances: attachedEntranceCount },
  };
}

// Contour du campus ([[longitude, latitude], …], fermé) tiré d'une réponse Overpass, ou null s'il manque ou
// n'est pas un polygone fermé d'au moins 4 points.
export function extractPerimeter(overpassResponse) {
  const boundary = (overpassResponse?.elements || []).find(
    (element) => element.type === 'way' && element.id === UAC_BOUNDARY_WAY_ID,
  );
  if (!boundary?.geometry?.length) return null;
  const perimeter = boundary.geometry.map((vertex) => [roundCoordinate(vertex.lon), roundCoordinate(vertex.lat)]);
  return isValidPerimeter(perimeter) ? perimeter : null;
}
