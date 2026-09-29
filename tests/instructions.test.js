/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteSteps, describeTurn, formatDistance } from '../shared/instructions.js';
import { offsetPosition } from './helpers.js';

test('décrit un virage à droite et à gauche', () => {
  assert.equal(describeTurn(90), 'Tournez à droite');
  assert.equal(describeTurn(-90), 'Tournez à gauche');
});

test("ne crée pas de consigne pour un léger changement d'angle", () => {
  assert.equal(describeTurn(10), null);
});

test('produit départ, virage puis arrivée pour un trajet en L', () => {
  const steps = buildRouteSteps([offsetPosition(0, 0), offsetPosition(0, 50), offsetPosition(40, 50)], {
    destination: { id: 'amphi', name: 'Amphi' },
  });
  assert.deepEqual(
    steps.map((step) => step.text),
    ['Partez vers le nord', 'Tournez à droite', 'Vous êtes arrivé : Amphi'],
  );
});

test('ignore les tronçons de moins de 6 mètres en fin de trajet', () => {
  const steps = buildRouteSteps([offsetPosition(0, 0), offsetPosition(0, 50), offsetPosition(-3, 52)]);
  assert.equal(steps.length, 2);
});

test('arrondit les distances de façon lisible', () => {
  assert.equal(formatDistance(3.2), '3 m');
  assert.equal(formatDistance(137), '135 m');
  assert.equal(formatDistance(1520), '1,5 km');
});
