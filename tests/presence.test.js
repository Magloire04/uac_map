/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDevicePosition, createCampusTest } from '../shared/presence.js';
import { createSquarePerimeter, offsetPosition } from './helpers.js';

const perimeter = createSquarePerimeter(500);

test('le module partagé applique la règle de présence sans dépendre du serveur', () => {
  const [longitude, latitude] = offsetPosition(10, 20);
  assert.equal(checkDevicePosition({ longitude, latitude, accuracy: 10, ageMs: 1000 }, perimeter), null);
  const [farLongitude, farLatitude] = offsetPosition(2000, 0);
  const far = { longitude: farLongitude, latitude: farLatitude, accuracy: 10, ageMs: 1000 };
  assert.equal(checkDevicePosition(far, perimeter), 'OUTSIDE_CAMPUS');
});

test('la marge de 50 m autour du campus est comprise', () => {
  const isOnCampus = createCampusTest(perimeter);
  assert.equal(isOnCampus(offsetPosition(540, 0)), true);
  assert.equal(isOnCampus(offsetPosition(560, 0)), false);
});
