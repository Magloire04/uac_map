/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { ConfigurationError } from '../server/configuration.js';
import { readCampusMap } from '../server/database/campusMapRepository.js';
import { startServer } from '../server/startServer.js';
import {
  createTestPool,
  databaseAfter,
  databaseBefore,
  databaseTest,
  dropAllTestTables,
  resetTestDatabase,
  testDatabaseConfiguration,
} from './testDatabase.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADMIN_TOKEN = 'jeton-de-test-1234';
const silent = () => {};
let database;

databaseBefore(() => {
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const databaseEnvironment = () => ({
  DATABASE_HOST: testDatabaseConfiguration.host,
  DATABASE_PORT: String(testDatabaseConfiguration.port),
  DATABASE_NAME: testDatabaseConfiguration.database,
  DATABASE_USER: testDatabaseConfiguration.user,
  DATABASE_PASSWORD: testDatabaseConfiguration.password,
  PORT: '0',
});

const productionEnvironment = () => ({
  ...databaseEnvironment(),
  NODE_ENV: 'production',
  ADMIN_TOKEN,
  PUBLIC_URL: 'https://uacmap.exemple.test',
});

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('refuse de démarrer quand la base est injoignable, sans afficher le mot de passe', async () => {
  const environment = {
    NODE_ENV: 'production',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: '1',
    DATABASE_NAME: 'uac_map_test',
    DATABASE_USER: 'personne',
    DATABASE_PASSWORD: 'mot-de-passe-a-ne-pas-afficher',
    ADMIN_TOKEN,
    PUBLIC_URL: 'https://uacmap.exemple.test',
  };
  await assert.rejects(
    startServer({ environment, log: silent }),
    (error) =>
      error instanceof ConfigurationError &&
      /injoignable/.test(error.message) &&
      !error.message.includes('mot-de-passe-a-ne-pas-afficher'),
  );
});

databaseTest('refuse de démarrer quand le schéma est en retard', async () => {
  await dropAllTestTables();
  await assert.rejects(
    startServer({ environment: productionEnvironment(), log: silent }),
    (error) => error instanceof ConfigurationError && /npm run database:migrate/.test(error.message),
  );
});

databaseTest('démarre sur une carte vide en production', async () => {
  await resetTestDatabase();
  const server = await startServer({ environment: productionEnvironment(), log: silent });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/v1/health`)).status, 200);
    const campusMap = await readCampusMap(database);
    assert.equal(campusMap.settings.isDemo, false);
    assert.equal(campusMap.places.length, 0);
  } finally {
    await server.close();
  }
});

databaseTest('charge la démonstration au premier lancement hors production', async () => {
  await resetTestDatabase();
  const server = await startServer({ environment: { ...databaseEnvironment(), ADMIN_TOKEN }, log: silent });
  try {
    assert.equal((await readCampusMap(database)).places.length, 8);
  } finally {
    await server.close();
  }
});

databaseTest('app.cjs démarre le serveur', async () => {
  await resetTestDatabase();
  const port = await findFreePort();
  const child = spawn(process.execPath, ['app.cjs'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...productionEnvironment(), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('Carte UAC prête')) resolve();
      });
      child.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      child.once('exit', (code) => reject(new Error(`app.cjs arrêté (code ${code}) : ${errors}`)));
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status, 200);
  } finally {
    child.kill();
  }
});
