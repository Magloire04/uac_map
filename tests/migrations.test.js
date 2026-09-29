/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPendingMigrations, getPendingMigrations, listMigrationFiles } from '../server/database/migrations.js';
import {
  createTestPool,
  databaseAfter,
  databaseBefore,
  databaseTest,
  dropAllTestTables,
  testDatabaseConfiguration,
} from './testDatabase.js';

const EXPECTED_TABLES = [
  'admin_sessions',
  'campus_settings',
  'failed_login_attempts',
  'paths',
  'places',
  'schema_migrations',
];
let database;

databaseBefore(() => {
  database = createTestPool();
});

databaseAfter(async () => {
  await dropAllTestTables();
  await database.end();
});

async function listTables() {
  const [rows] = await database.query(
    'SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
  );
  return rows.map((row) => row.tableName);
}

async function withTemporaryDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'uac-migrations-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('ne retient que les fichiers de migration numérotés, dans l’ordre', () =>
  withTemporaryDirectory(async (directory) => {
    await writeFile(join(directory, '002-seconde.sql'), '');
    await writeFile(join(directory, '001-premiere.sql'), '');
    await writeFile(join(directory, 'notes.txt'), '');
    assert.deepEqual(await listMigrationFiles(directory), ['001-premiere.sql', '002-seconde.sql']);
  }));

databaseTest('crée toutes les tables sur une base vide', async () => {
  await dropAllTestTables();
  assert.deepEqual(await getPendingMigrations(database), ['001-initial-schema.sql']);
  assert.deepEqual(await applyPendingMigrations(testDatabaseConfiguration), ['001-initial-schema.sql']);
  assert.deepEqual(await listTables(), EXPECTED_TABLES);
  assert.deepEqual(await getPendingMigrations(database), []);
});

databaseTest('une seconde exécution ne change rien', async () => {
  await dropAllTestTables();
  await applyPendingMigrations(testDatabaseConfiguration);
  assert.deepEqual(await applyPendingMigrations(testDatabaseConfiguration), []);
});

databaseTest('deux lancements simultanés appliquent chaque migration une seule fois', async () => {
  await dropAllTestTables();
  const results = await Promise.all([
    applyPendingMigrations(testDatabaseConfiguration),
    applyPendingMigrations(testDatabaseConfiguration),
  ]);
  assert.deepEqual(results.flat(), ['001-initial-schema.sql']);
  const [rows] = await database.query('SELECT COUNT(*) AS total FROM schema_migrations');
  assert.equal(Number(rows[0].total), 1);
});

databaseTest('nomme le fichier en cause et ne l’inscrit pas quand une migration échoue', () =>
  withTemporaryDirectory(async (directory) => {
    await dropAllTestTables();
    await writeFile(join(directory, '001-cassee.sql'), 'CREATE TABLE pas du sql;');
    await assert.rejects(applyPendingMigrations(testDatabaseConfiguration, { directory }), /001-cassee\.sql/);
    assert.deepEqual(await getPendingMigrations(database, directory), ['001-cassee.sql']);
  }),
);
