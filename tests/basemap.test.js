/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getDistance } from '../shared/geo.js';
import {
  BASEMAP_BOUNDS,
  BASEMAP_MAX_ZOOM,
  BASEMAP_MIN_ZOOM,
  createExtractArguments,
  createMapStyle,
  withoutPointsOfInterest,
} from '../shared/basemap.js';
import { CAMPUS_CENTER } from './helpers.js';

const ORIGIN = 'https://uacmap.bytechnum.com';
const basemapLayers = [
  { id: 'background', type: 'background' },
  { id: 'roads_minor', type: 'line', source: 'protomaps', 'source-layer': 'roads' },
  { id: 'pois', type: 'symbol', source: 'protomaps', 'source-layer': 'pois' },
  { id: 'places_locality', type: 'symbol', source: 'protomaps', 'source-layer': 'places' },
];

test('la zone contient le centre du campus avec plus de 3,4 km de marge de chaque côté', () => {
  const [west, south, east, north] = BASEMAP_BOUNDS;
  assert.ok(west < CAMPUS_CENTER[0] && CAMPUS_CENTER[0] < east);
  assert.ok(south < CAMPUS_CENTER[1] && CAMPUS_CENTER[1] < north);
  for (const edge of [
    [west, CAMPUS_CENTER[1]],
    [east, CAMPUS_CENTER[1]],
    [CAMPUS_CENTER[0], south],
    [CAMPUS_CENTER[0], north],
  ]) {
    assert.ok(getDistance(CAMPUS_CENTER, edge) > 3400, `bord ${edge}`);
  }
});

test('retire la couche des lieux OpenStreetMap sans toucher aux autres ni à la liste reçue', () => {
  const kept = withoutPointsOfInterest(basemapLayers);
  assert.deepEqual(
    kept.map((layer) => layer.id),
    ['background', 'roads_minor', 'places_locality'],
  );
  assert.equal(basemapLayers.length, 4);
});

test("le style n'appelle que le site, sauf l'imagerie satellite", () => {
  const style = createMapStyle({ basemapLayers, origin: ORIGIN });
  assert.equal(style.glyphs, `${ORIGIN}/basemap/fonts/{fontstack}/{range}.pbf`);
  assert.equal(style.sprite, `${ORIGIN}/basemap/sprites/light`);
  assert.equal(style.sources.protomaps.url, 'pmtiles://campus');
  assert.match(style.sources.protomaps.attribution, /OpenStreetMap/);
  assert.deepEqual(style.sources.satellite.tiles, [
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  ]);
  assert.equal(Object.keys(style.sources).length, 2);
});

test('la couche satellite est cachée par défaut et posée sur le fond', () => {
  const style = createMapStyle({ basemapLayers, origin: ORIGIN });
  const satellite = style.layers.at(-1);
  assert.equal(satellite.id, 'satellite');
  assert.equal(satellite.layout.visibility, 'none');
  assert.ok(!style.layers.some((layer) => layer['source-layer'] === 'pois'));
});

test("prépare l'extraction de la zone, des zooms 11 à 15", () => {
  assert.deepEqual(createExtractArguments('20260930', 'public/basemap/campus.pmtiles'), [
    'extract',
    'https://build.protomaps.com/20260930.pmtiles',
    'public/basemap/campus.pmtiles',
    '--bbox=2.3104,6.3822,2.3736,6.45',
    '--minzoom=11',
    '--maxzoom=15',
  ]);
  assert.throws(() => createExtractArguments('2026-09-30', 'x.pmtiles'), /AAAAMMJJ/);
});

// En-tête PMTiles v3 : zooms aux octets 100 et 101, puis les bornes en dix-millionièmes de degré.
test('le fichier versionné couvre la zone, des zooms 11 à 15', async () => {
  const header = await readFile(new URL('../public/basemap/campus.pmtiles', import.meta.url));
  assert.equal(header.subarray(0, 7).toString('ascii'), 'PMTiles');
  assert.equal(header.readUInt8(100), BASEMAP_MIN_ZOOM);
  assert.equal(header.readUInt8(101), BASEMAP_MAX_ZOOM);
  const bounds = [102, 106, 110, 114].map((offset) => header.readInt32LE(offset) / 1e7);
  assert.deepEqual(bounds, BASEMAP_BOUNDS);
});
