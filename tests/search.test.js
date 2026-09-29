/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, searchPlaces, normalizeText, isOneEditAway } from '../shared/search.js';
import { buildDemoCampusMap } from '../server/demo.js';

const searchIndex = buildSearchIndex(buildDemoCampusMap().places);
const firstResultName = (query) => searchPlaces(searchIndex, query)[0]?.name;

test('trouve un lieu sans tenir compte des accents', () => {
  assert.match(firstResultName('bibliotheque'), /Bibliothèque/);
});

test('trouve un lieu par son sigle', () => {
  assert.match(firstResultName('BU'), /Bibliothèque/);
});

test('trouve un lieu par un début de mot', () => {
  assert.match(firstResultName('scola'), /Scolarité/);
});

test('tolère une faute de frappe', () => {
  assert.match(firstResultName('infirmrie'), /Infirmerie/);
});

test('ne renvoie rien pour une requête sans correspondance', () => {
  assert.equal(searchPlaces(searchIndex, 'zzzz').length, 0);
});

test('ne renvoie rien pour une requête vide', () => {
  assert.equal(searchPlaces(searchIndex, '   ').length, 0);
});

test('normalise casse, accents et ponctuation', () => {
  assert.equal(normalizeText('  Amphi  É-12 '), 'amphi e 12');
});

test("détecte un écart d'une seule lettre et refuse deux écarts", () => {
  assert.equal(isOneEditAway('amphi', 'ampi'), true);
  assert.equal(isOneEditAway('amphi', 'apmhi'), false);
});
