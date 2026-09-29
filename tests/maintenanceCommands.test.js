/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import { insertPlace, readCampusMap, rewriteCampusMap } from '../server/database/campusMapRepository.js';
import {
  createTestPool,
  databaseAfter,
  databaseBefore,
  databaseTest,
  dropAllTestTables,
  resetTestDatabase,
} from './testDatabase.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const runFile = promisify(execFile);
const realPlace = {
  id: 'place_reelle',
  name: 'Rectorat',
  category: 'other',
  aliases: [],
  description: '',
  access: '',
  longitude: 2.342,
  latitude: 6.416,
  entrances: [],
};
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

// Les commandes héritent des variables DATABASE_* de la base de test.
async function runCommand(scriptName, commandArguments = []) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [join('scripts', scriptName), ...commandArguments], {
      cwd: PROJECT_ROOT,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function startWithOneRealPlace() {
  await rewriteCampusMap(database, () => createEmptyCampusMap());
  await insertPlace(database, realPlace);
}

databaseTest('reset refuse de vider la carte sans --oui', async () => {
  await startWithOneRealPlace();
  const result = await runCommand('resetCampusMap.js');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--oui/);
  assert.equal((await readCampusMap(database)).places.length, 1);
});

databaseTest('reset vide la carte avec --oui', async () => {
  await startWithOneRealPlace();
  assert.equal((await runCommand('resetCampusMap.js', ['--oui'])).code, 0);
  assert.equal((await readCampusMap(database)).places.length, 0);
});

databaseTest('demo refuse d’écraser des données réelles sans --forcer', async () => {
  await startWithOneRealPlace();
  const result = await runCommand('loadDemoData.js');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--forcer/);
  assert.deepEqual(
    (await readCampusMap(database)).places.map((place) => place.id),
    ['place_reelle'],
  );
});

databaseTest('demo charge la démonstration avec --forcer', async () => {
  await startWithOneRealPlace();
  assert.equal((await runCommand('loadDemoData.js', ['--forcer'])).code, 0);
  const campusMap = await readCampusMap(database);
  assert.equal(campusMap.settings.isDemo, true);
  assert.equal(campusMap.places.length, 8);
});

databaseTest(
  'import-osm ajoute les éléments OpenStreetMap et garde les lieux saisis, sauf avec --remplacer',
  async () => {
    await startWithOneRealPlace();
    const directory = await mkdtemp(join(tmpdir(), 'uac-osm-'));
    try {
      const inputFile = join(directory, 'overpass.json');
      await writeFile(
        inputFile,
        JSON.stringify({
          elements: [
            {
              type: 'way',
              id: 1,
              tags: { highway: 'steps' },
              geometry: [
                { lon: 2.34, lat: 6.415 },
                { lon: 2.3401, lat: 6.415 },
              ],
            },
            { type: 'node', id: 20, lon: 2.342, lat: 6.417, tags: { amenity: 'restaurant', name: 'Resto U' } },
          ],
        }),
      );
      assert.equal((await runCommand('importOpenStreetMap.js', ['--fichier', inputFile])).code, 0);
      let campusMap = await readCampusMap(database);
      assert.deepEqual(campusMap.places.map((place) => place.name).sort(), ['Rectorat', 'Resto U']);
      assert.deepEqual(
        campusMap.paths.map((path) => path.id),
        ['osm_way_1'],
      );
      assert.equal((await runCommand('importOpenStreetMap.js', ['--fichier', inputFile, '--remplacer'])).code, 0);
      campusMap = await readCampusMap(database);
      assert.deepEqual(
        campusMap.places.map((place) => place.name),
        ['Resto U'],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

databaseTest('les commandes refusent un schéma en retard', async () => {
  await dropAllTestTables();
  const result = await runCommand('resetCampusMap.js', ['--oui']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /npm run database:migrate/);
  await resetTestDatabase();
});
