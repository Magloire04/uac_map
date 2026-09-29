/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, findRoute } from '../shared/graph.js';
import { buildDemoCampusMap } from '../server/demo.js';
import { CAMPUS_CENTER, offsetPosition, createTestPath } from './helpers.js';

test('relie deux chemins qui se croisent au point de croisement', () => {
  const graph = buildGraph([
    createTestPath('horizontal', 'footpath', [
      [-50, 0],
      [50, 0],
    ]),
    createTestPath('vertical', 'footpath', [
      [0, -50],
      [0, 50],
    ]),
  ]);
  const route = findRoute(graph, offsetPosition(-50, 0), [offsetPosition(0, 50)]);
  assert.ok(Math.abs(route.length - 100) < 0.5, `longueur ${route.length}`);
});

test("raccorde l'extrémité d'un chemin posée près du milieu d'un autre (jonction en T)", () => {
  const graph = buildGraph([
    createTestPath('main', 'footpath', [
      [-50, 0],
      [50, 0],
    ]),
    createTestPath('branch', 'footpath', [
      [10, 2],
      [10, 40],
    ]),
  ]);
  const route = findRoute(graph, offsetPosition(-50, 0), [offsetPosition(10, 40)]);
  assert.ok(route && route.length < 105, `longueur ${route?.length}`);
});

test("renvoie null quand aucun chemin ne relie le départ à l'arrivée", () => {
  const graph = buildGraph([
    createTestPath('south', 'footpath', [
      [0, 0],
      [50, 0],
    ]),
    createTestPath('north', 'footpath', [
      [0, 30],
      [50, 30],
    ]),
  ]);
  assert.equal(findRoute(graph, offsetPosition(0, 0), [offsetPosition(50, 30)]), null);
});

test('renvoie null sur un réseau vide', () => {
  assert.equal(findRoute(buildGraph([]), offsetPosition(0, 0), [offsetPosition(10, 0)]), null);
});

test('calcule un trajet dont départ et arrivée sont sur le même tronçon', () => {
  const graph = buildGraph([
    createTestPath('only', 'footpath', [
      [0, 0],
      [100, 0],
    ]),
  ]);
  const route = findRoute(graph, offsetPosition(20, 3), [offsetPosition(70, -2)]);
  assert.ok(Math.abs(route.length - (3 + 50 + 2)) < 0.5, `longueur ${route.length}`);
});

test("choisit l'entrée la plus proche parmi plusieurs", () => {
  const graph = buildGraph([
    createTestPath('only', 'footpath', [
      [0, 0],
      [200, 0],
    ]),
  ]);
  const route = findRoute(graph, offsetPosition(0, 0), [offsetPosition(190, 0), offsetPosition(40, 5)]);
  assert.equal(route.targetIndex, 1);
});

const demoCampusMap = buildDemoCampusMap(CAMPUS_CENTER);
const demoGraph = buildGraph(demoCampusMap.paths);
const getEntrances = (nameFragment) =>
  demoCampusMap.places
    .find((place) => place.name.includes(nameFragment))
    .entrances.map((entrance) => [entrance.longitude, entrance.latitude]);

test("l'option sans escaliers évite le tronçon d'escaliers", () => {
  const northDoor = getEntrances('Amphi A').slice(0, 1);
  const withStairs = findRoute(demoGraph, offsetPosition(100, 30), northDoor);
  const withoutStairs = findRoute(demoGraph, offsetPosition(100, 30), northDoor, { avoidStairs: true });
  assert.ok(withoutStairs.length > withStairs.length, `${withoutStairs.length} vs ${withStairs.length}`);
});

test("l'option passages inondables contourne la piste marquée inondable", () => {
  const viaTrack = findRoute(demoGraph, offsetPosition(-180, 0), getEntrances('Bibliothèque'));
  const dryRoute = findRoute(demoGraph, offsetPosition(-180, 0), getEntrances('Bibliothèque'), { avoidFlood: true });
  assert.ok(dryRoute.length > viaTrack.length + 50, `${dryRoute.length} vs ${viaTrack.length}`);
});
