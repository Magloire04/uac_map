/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertOverpassResponse, extractPerimeter, UAC_BOUNDARY_WAY_ID } from '../server/openStreetMapImport.js';

const overpassResponse = {
  elements: [
    {
      type: 'way',
      id: UAC_BOUNDARY_WAY_ID,
      tags: { name: 'UAC', amenity: 'university' },
      geometry: [
        { lon: 2.33, lat: 6.41 },
        { lon: 2.35, lat: 6.41 },
        { lon: 2.35, lat: 6.42 },
        { lon: 2.33, lat: 6.41 },
      ],
    },
    {
      type: 'way',
      id: 1,
      tags: { highway: 'steps' },
      geometry: [
        { lon: 2.34, lat: 6.415 },
        { lon: 2.3401, lat: 6.415 },
      ],
    },
    {
      type: 'way',
      id: 2,
      tags: { building: 'yes', name: 'Bâtiment B FSA' },
      nodes: [10, 11, 12, 10],
      geometry: [
        { lon: 2.341, lat: 6.416 },
        { lon: 2.3412, lat: 6.416 },
        { lon: 2.3412, lat: 6.4162 },
        { lon: 2.341, lat: 6.416 },
      ],
    },
    { type: 'node', id: 11, lon: 2.3412, lat: 6.416, tags: { entrance: 'main' } },
    { type: 'node', id: 20, lon: 2.342, lat: 6.417, tags: { amenity: 'restaurant', name: 'Resto U' } },
  ],
};
const converted = convertOverpassResponse(overpassResponse);

test('convertit des escaliers OSM en chemin de type stairs', () => {
  assert.equal(converted.paths[0].type, 'stairs');
});

test('crée un lieu par élément nommé, sans le contour du campus', () => {
  assert.deepEqual(converted.places.map((place) => place.name).sort(), ['Bâtiment B FSA', 'Resto U']);
});

test('déduit la catégorie des étiquettes OSM', () => {
  assert.equal(converted.places.find((place) => place.name === 'Resto U').category, 'food');
});

test('rattache une entrée au bâtiment qui la contient', () => {
  assert.equal(converted.places.find((place) => place.name.startsWith('Bâtiment')).entrances.length, 1);
});

test('calcule le centre du campus à partir de son contour', () => {
  assert.ok(converted.center);
});

test('extrait le contour fermé du campus', () => {
  assert.deepEqual(extractPerimeter(overpassResponse), [
    [2.33, 6.41],
    [2.35, 6.41],
    [2.35, 6.42],
    [2.33, 6.41],
  ]);
});

test('ne renvoie pas de contour absent ou ouvert', () => {
  assert.equal(extractPerimeter({ elements: [] }), null);
  assert.equal(extractPerimeter(null), null);
  const [boundary] = overpassResponse.elements;
  const openRing = { elements: [{ ...boundary, geometry: boundary.geometry.slice(0, 3) }] };
  assert.equal(extractPerimeter(openRing), null);
});
