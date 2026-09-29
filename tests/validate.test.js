/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPlace, cleanPath, ValidationError } from '../shared/validate.js';

const validPlace = { name: '  Amphi  B ', category: 'lecture-hall', longitude: 2.34, latitude: 6.41 };

test("nettoie le nom et découpe les alias d'un lieu", () => {
  const place = cleanPlace({ ...validPlace, aliases: 'amphi 2, , AB' });
  assert.equal(place.name, 'Amphi B');
  assert.deepEqual(place.aliases, ['amphi 2', 'AB']);
});

test('refuse un lieu sans nom', () => {
  assert.throws(() => cleanPlace({ ...validPlace, name: '' }), ValidationError);
});

test('refuse une position non numérique', () => {
  assert.throws(() => cleanPlace({ ...validPlace, longitude: 'abc' }), ValidationError);
});

test('remplace une catégorie inconnue par « other »', () => {
  assert.equal(cleanPlace({ ...validPlace, category: 'inconnue' }).category, 'other');
});

test("refuse un chemin d'un seul point", () => {
  assert.throws(() => cleanPath({ coordinates: [[2, 6]] }), ValidationError);
});

test('remplace un type de chemin inconnu par le type par défaut', () => {
  assert.equal(
    cleanPath({
      type: '<script>',
      coordinates: [
        [2, 6],
        [2.1, 6],
      ],
    }).type,
    'footpath',
  );
});
