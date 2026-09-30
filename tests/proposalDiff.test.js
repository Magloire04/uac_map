/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPlaceChanges } from '../shared/proposalDiff.js';
import { offsetPosition } from './helpers.js';

const [longitude, latitude] = offsetPosition(0, 0);
const [entranceLongitude, entranceLatitude] = offsetPosition(10, 0);
const place = {
  id: 'place_bu',
  name: 'Bibliothèque',
  category: 'library',
  aliases: ['BU'],
  description: '',
  access: 'Rez-de-chaussée',
  longitude,
  latitude,
  entrances: [{ longitude: entranceLongitude, latitude: entranceLatitude, note: 'Porte nord' }],
};

test('ne signale rien quand la proposition reprend le lieu à l’identique', () => {
  const { id, ...payload } = place;
  assert.deepEqual(listPlaceChanges(place, payload), []);
});

test('liste les champs modifiés avec des libellés lisibles', () => {
  const changes = listPlaceChanges(place, {
    ...place,
    name: 'BU centrale',
    category: 'administration',
    aliases: ['BU', 'BUC'],
    description: 'Salle de lecture',
  });
  assert.deepEqual(changes, [
    { field: 'name', label: 'Nom', before: 'Bibliothèque', after: 'BU centrale' },
    { field: 'category', label: 'Catégorie', before: 'Bibliothèque', after: 'Administration' },
    { field: 'aliases', label: 'Autres noms', before: 'BU', after: 'BU, BUC' },
    { field: 'description', label: 'Description', before: '—', after: 'Salle de lecture' },
  ]);
});

test('ignore l’ordre des clés des entrées enregistrées', () => {
  const { id, ...payload } = place;
  const stored = {
    ...place,
    entrances: [{ note: 'Porte nord', latitude: entranceLatitude, longitude: entranceLongitude }],
  };
  assert.deepEqual(listPlaceChanges(stored, payload), []);
});

test('signale le déplacement du lieu et celui d’une entrée', () => {
  const [movedLongitude, movedLatitude] = offsetPosition(30, 0);
  const [movedEntranceLongitude, movedEntranceLatitude] = offsetPosition(10, 5);
  const changes = listPlaceChanges(place, {
    ...place,
    longitude: movedLongitude,
    latitude: movedLatitude,
    entrances: [{ longitude: movedEntranceLongitude, latitude: movedEntranceLatitude, note: 'Porte nord' }],
  });
  assert.deepEqual(changes, [
    { field: 'entrances', label: 'Entrées', before: '1 : Porte nord', after: '1 : Porte nord (emplacement modifié)' },
    { field: 'position', label: 'Position', before: 'Emplacement actuel', after: 'Déplacé de 30 m' },
  ]);
});
