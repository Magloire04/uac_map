/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPerimeterTest,
  getDistance,
  simplifyLine,
  locateOnLine,
  isInsidePerimeter,
  isValidPerimeter,
} from '../shared/geo.js';
import { offsetPosition, createSquarePerimeter } from './helpers.js';

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

const square = createSquarePerimeter(100);

test('situe une position dans le périmètre, marge comprise', () => {
  assert.equal(isInsidePerimeter(offsetPosition(0, 0), square, 0), true);
  assert.equal(isInsidePerimeter(offsetPosition(140, 0), square, 0), false);
  assert.equal(isInsidePerimeter(offsetPosition(140, 0), square, 50), true);
  assert.equal(isInsidePerimeter(offsetPosition(0, -170), square, 50), false);
  assert.equal(isInsidePerimeter(offsetPosition(130, 130), square, 50), true);
  assert.equal(isInsidePerimeter(offsetPosition(140, 140), square, 50), false);
});

test('gère un périmètre concave', () => {
  const lShape = [
    [0, 0],
    [200, 0],
    [200, 100],
    [100, 100],
    [100, 200],
    [0, 200],
    [0, 0],
  ].map(([east, north]) => offsetPosition(east, north));
  assert.equal(isInsidePerimeter(offsetPosition(50, 150), lShape, 0), true);
  assert.equal(isInsidePerimeter(offsetPosition(150, 150), lShape, 0), false);
  assert.equal(isInsidePerimeter(offsetPosition(150, 150), lShape, 60), true);
});

test('un périmètre absent, trop court, ouvert ou mal formé ne contient rien', () => {
  const center = offsetPosition(0, 0);
  assert.equal(isInsidePerimeter(center, null, 50), false);
  assert.equal(isInsidePerimeter(center, square.slice(0, 3), 50), false);
  assert.equal(isInsidePerimeter(center, square.slice(0, 4), 50), false);
  assert.equal(isValidPerimeter(square), true);
  assert.equal(
    isValidPerimeter([
      [2.34, 6.41],
      [2.35, 'x'],
      [2.35, 6.42],
      [2.34, 6.41],
    ]),
    false,
  );
  assert.equal(isValidPerimeter('carré'), false);
});

test('un périmètre préparé répond comme isInsidePerimeter et refuse une position mal formée', () => {
  const isOnCampus = createPerimeterTest(square, 50);
  for (const offsets of [
    [0, 0],
    [140, 0],
    [0, -170],
    [130, 130],
    [140, 140],
  ]) {
    const position = offsetPosition(...offsets);
    assert.equal(isOnCampus(position), isInsidePerimeter(position, square, 50), String(offsets));
  }
  for (const position of [null, undefined, 'ici', [2.34], [Number.NaN, 6.41], ['2.34', '6.41'], [2.34, 95]]) {
    assert.equal(isOnCampus(position), false, String(position));
  }
  assert.equal(isInsidePerimeter(null, square, 50), false);
  assert.equal(createPerimeterTest(null, 50)(offsetPosition(0, 0)), false);
});
