/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import { buildDemoCampusMap } from '../server/demo.js';
import {
  deletePath,
  deletePlace,
  findPath,
  findPlace,
  generateId,
  initialiseCampusMap,
  insertPath,
  insertPlace,
  listPaths,
  listPlaces,
  readCampusMap,
  readSettings,
  replacePlace,
  rewriteCampusMap,
  updatePathAttributes,
} from '../server/database/campusMapRepository.js';
import { offsetPosition } from './helpers.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const emptyTheMap = () => rewriteCampusMap(database, () => createEmptyCampusMap());
const firstPage = { page: 1, limit: 20, sortBy: 'name', order: 'asc' };

function buildPlace(overrides = {}) {
  const [longitude, latitude] = offsetPosition(12.345, -67.891);
  const [entranceLongitude, entranceLatitude] = offsetPosition(20.5, -60.25);
  return {
    id: generateId('place'),
    name: 'Bibliothèque universitaire',
    category: 'library',
    aliases: ['BU', 'bibli'],
    description: 'Salle de lecture « Ouidah » 📚',
    access: '1er étage, porte côté parking',
    longitude,
    latitude,
    entrances: [{ longitude: entranceLongitude, latitude: entranceLatitude, note: 'Porte nord' }],
    ...overrides,
  };
}

function buildPath(overrides = {}) {
  return {
    id: generateId('path'),
    type: 'footpath',
    name: 'Allée des flamboyants',
    isFloodProne: false,
    coordinates: [offsetPosition(0.5, 0.25), offsetPosition(30.75, 12.125)],
    ...overrides,
  };
}

databaseTest('relit un lieu à l’identique : accents, emoji, sigles, entrées et coordonnées exactes', async () => {
  await emptyTheMap();
  const place = buildPlace();
  await insertPlace(database, place);
  assert.deepEqual(await findPlace(database, place.id), place);
});

databaseTest('met à jour la date de la carte à chaque écriture', async () => {
  await emptyTheMap();
  const now = new Date('2026-09-29T10:00:00.000Z');
  await insertPlace(database, buildPlace(), now);
  assert.equal((await readSettings(database)).updatedAt, now.toISOString());
});

databaseTest('remplace un lieu existant et ignore un identifiant inconnu', async () => {
  await emptyTheMap();
  const place = buildPlace();
  await insertPlace(database, place);
  const { id: _id, ...fields } = { ...place, name: 'BU centrale', aliases: [] };
  assert.deepEqual(await replacePlace(database, place.id, fields), { id: place.id, ...fields });
  assert.equal((await findPlace(database, place.id)).name, 'BU centrale');
  assert.equal(await replacePlace(database, 'place_inconnu', fields), null);
});

databaseTest('supprime un lieu une seule fois', async () => {
  await emptyTheMap();
  const place = buildPlace();
  await insertPlace(database, place);
  assert.equal(await deletePlace(database, place.id), true);
  assert.equal(await deletePlace(database, place.id), false);
  assert.equal(await findPlace(database, place.id), null);
});

databaseTest('trie et pagine les lieux par nom, sans tenir compte de la casse, dans les deux sens', async () => {
  await emptyTheMap();
  for (const name of ['Charlie', 'alpha', 'Bravo']) await insertPlace(database, buildPlace({ name }));
  const names = (result) => result.items.map((place) => place.name);
  const firstTwo = await listPlaces(database, { ...firstPage, limit: 2 });
  assert.deepEqual(names(firstTwo), ['alpha', 'Bravo']);
  assert.equal(firstTwo.total, 3);
  assert.deepEqual(names(await listPlaces(database, { ...firstPage, limit: 2, page: 2 })), ['Charlie']);
  assert.deepEqual(names(await listPlaces(database, { ...firstPage, order: 'desc' })), ['Charlie', 'Bravo', 'alpha']);
});

databaseTest('filtre les lieux par catégorie', async () => {
  await emptyTheMap();
  await insertPlace(database, buildPlace({ name: 'Resto U', category: 'food' }));
  await insertPlace(database, buildPlace({ name: 'BU', category: 'library' }));
  const result = await listPlaces(database, { ...firstPage, category: 'food' });
  assert.deepEqual(
    result.items.map((place) => place.name),
    ['Resto U'],
  );
  assert.equal(result.total, 1);
});

databaseTest('cherche sans tenir compte de la casse dans le nom et dans les sigles', async () => {
  await emptyTheMap();
  await insertPlace(database, buildPlace({ name: 'Bibliothèque universitaire', aliases: ['BU'] }));
  await insertPlace(database, buildPlace({ name: 'Restaurant', aliases: ['RU'] }));
  const namesFor = async (search) =>
    (await listPlaces(database, { ...firstPage, search })).items.map((place) => place.name);
  assert.deepEqual(await namesFor('BIBLIO'), ['Bibliothèque universitaire']);
  assert.deepEqual(await namesFor('bu'), ['Bibliothèque universitaire']);
  assert.deepEqual(await namesFor('ru'), ['Restaurant']);
});

databaseTest('cherche % et _ comme du texte, pas comme des jokers', async () => {
  await emptyTheMap();
  await insertPlace(database, buildPlace({ name: 'Amphi 1000', aliases: [] }));
  await insertPlace(database, buildPlace({ name: 'Salle_B', aliases: [] }));
  assert.equal((await listPlaces(database, { ...firstPage, search: '%' })).total, 0);
  assert.deepEqual(
    (await listPlaces(database, { ...firstPage, search: '_' })).items.map((place) => place.name),
    ['Salle_B'],
  );
});

databaseTest('refuse un tri hors de la liste fermée', async () => {
  await assert.rejects(
    listPlaces(database, { ...firstPage, sortBy: 'name; DROP TABLE places' }),
    /Pagination invalide/,
  );
  await assert.rejects(listPlaces(database, { ...firstPage, order: 'sideways' }), /Pagination invalide/);
});

databaseTest('relit un chemin de 5000 points à l’identique', async () => {
  await emptyTheMap();
  const coordinates = Array.from({ length: 5000 }, (_, index) => offsetPosition(index * 0.37, index * -0.21));
  const path = buildPath({ coordinates });
  await insertPath(database, path);
  assert.deepEqual(await findPath(database, path.id), path);
});

databaseTest('modifie le type, le nom et le caractère inondable sans toucher au tracé', async () => {
  await emptyTheMap();
  const path = buildPath();
  await insertPath(database, path);
  const updated = await updatePathAttributes(database, path.id, {
    type: 'stairs',
    name: 'Escaliers',
    isFloodProne: true,
  });
  assert.deepEqual(updated, { ...path, type: 'stairs', name: 'Escaliers', isFloodProne: true });
  assert.equal(
    await updatePathAttributes(database, 'path_inconnu', { type: 'road', name: '', isFloodProne: false }),
    null,
  );
});

databaseTest('filtre les chemins par type et les trie par identifiant', async () => {
  await emptyTheMap();
  await insertPath(database, buildPath({ id: 'path_b', type: 'road' }));
  await insertPath(database, buildPath({ id: 'path_a', type: 'road' }));
  await insertPath(database, buildPath({ id: 'path_c', type: 'stairs' }));
  const result = await listPaths(database, { page: 1, limit: 20, sortBy: 'id', order: 'asc', type: 'road' });
  assert.deepEqual(
    result.items.map((path) => path.id),
    ['path_a', 'path_b'],
  );
  assert.equal(result.total, 2);
  assert.equal(await deletePath(database, 'path_a'), true);
});

databaseTest('remplace toute la carte en une transaction', async () => {
  const campusMap = await rewriteCampusMap(database, () => buildDemoCampusMap());
  assert.equal(campusMap.settings.isDemo, true);
  assert.equal(campusMap.places.length, 8);
  assert.equal(campusMap.paths.length, 11);
  assert.deepEqual(await readCampusMap(database), campusMap);
});

databaseTest('ne laisse rien à moitié écrit quand un remplacement échoue', async () => {
  await rewriteCampusMap(database, () => buildDemoCampusMap());
  await assert.rejects(
    rewriteCampusMap(database, () => ({
      ...createEmptyCampusMap(),
      places: [buildPlace({ id: 'doublon' }), buildPlace({ id: 'doublon' })],
    })),
    { code: 'ER_DUP_ENTRY' },
  );
  const campusMap = await readCampusMap(database);
  assert.equal(campusMap.places.length, 8);
  assert.equal(campusMap.settings.isDemo, true);
});

databaseTest('charge la démonstration une seule fois au premier lancement hors production', async () => {
  await resetTestDatabase();
  const options = { isProduction: false, buildDemoCampusMap };
  const outcomes = await Promise.all([initialiseCampusMap(database, options), initialiseCampusMap(database, options)]);
  assert.deepEqual(outcomes.sort(), ['demo', 'existing']);
  assert.equal((await readCampusMap(database)).places.length, 8);
});

databaseTest('démarre sur une carte vide en production', async () => {
  await resetTestDatabase();
  assert.equal(await initialiseCampusMap(database, { isProduction: true, buildDemoCampusMap }), 'empty');
  const campusMap = await readCampusMap(database);
  assert.equal(campusMap.settings.isDemo, false);
  assert.deepEqual(campusMap.places, []);
  assert.equal(await initialiseCampusMap(database, { isProduction: true, buildDemoCampusMap }), 'existing');
});

databaseTest('garde un texte SQL constant quel que soit le numéro de page', async () => {
  await emptyTheMap();
  const connection = await database.getConnection();
  try {
    const readPreparedCount = async () =>
      Number((await connection.query("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'"))[0][0].Value);
    const before = await readPreparedCount();
    for (let page = 1; page <= 50; page++) await listPlaces(connection, { ...firstPage, page });
    assert.ok((await readPreparedCount()) - before <= 2, 'une instruction préparée par numéro de page');
  } finally {
    connection.release();
  }
});
