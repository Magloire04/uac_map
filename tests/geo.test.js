/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDistance, simplifyLine, locateOnLine } from '../shared/geo.js';
import { offsetPosition } from './helpers.js';

test('simplifie une trace GPS en zigzag en une ligne droite', () => {
  const zigzag = Array.from({ length: 51 }, (_, index) => offsetPosition(index * 2, index % 2 ? 0.3 : -0.3));
  const simplified = simplifyLine(zigzag, 1.5);
  assert.equal(simplified.length, 2);
  assert.ok(Math.abs(getDistance(simplified[0], simplified[1]) - 100) < 1);
});

test("situe une position le long d'une polyligne", () => {
  const location = locateOnLine([offsetPosition(0, 0), offsetPosition(100, 0)], offsetPosition(30, 4));
  assert.ok(Math.abs(location.along - 30) < 0.5);
  assert.ok(Math.abs(location.offset - 4) < 0.5);
});
