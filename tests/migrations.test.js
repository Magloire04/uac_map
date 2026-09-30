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
  'contribution_links',
  'contributors',
  'failed_login_attempts',
  'map_changes',
  'paths',
  'places',
  'proposals',
  'rate_limits',
  'reviewers',
  'schema_migrations',
];
const ALL_MIGRATIONS = ['001-initial-schema.sql', '002-contribution-ouverte.sql'];
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
  assert.deepEqual(await getPendingMigrations(database), ALL_MIGRATIONS);
  assert.deepEqual(await applyPendingMigrations(testDatabaseConfiguration), ALL_MIGRATIONS);
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
  assert.deepEqual(results.flat(), ALL_MIGRATIONS);
  const [rows] = await database.query('SELECT COUNT(*) AS total FROM schema_migrations');
  assert.equal(Number(rows[0].total), ALL_MIGRATIONS.length);
});

databaseTest('nomme le fichier en cause et ne l’inscrit pas quand une migration échoue', () =>
  withTemporaryDirectory(async (directory) => {
    await dropAllTestTables();
    await writeFile(join(directory, '001-cassee.sql'), 'CREATE TABLE pas du sql;');
    await assert.rejects(applyPendingMigrations(testDatabaseConfiguration, { directory }), /001-cassee\.sql/);
    assert.deepEqual(await getPendingMigrations(database, directory), ['001-cassee.sql']);
  }),
);

async function listColumns(tableName) {
  const [rows] = await database.query(
    'SELECT column_name AS columnName FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
    [tableName],
  );
  return rows.map((row) => row.columnName);
}

databaseTest('complète les réglages et les sessions pour la contribution', async () => {
  await dropAllTestTables();
  await applyPendingMigrations(testDatabaseConfiguration);
  assert.ok((await listColumns('campus_settings')).includes('perimeter'));
  assert.ok((await listColumns('campus_settings')).includes('contributions_paused'));
  assert.ok((await listColumns('admin_sessions')).includes('actor_kind'));
  assert.ok((await listColumns('admin_sessions')).includes('reviewer_id'));
});

databaseTest('relance la migration 002 sans erreur', async () => {
  await dropAllTestTables();
  await applyPendingMigrations(testDatabaseConfiguration);
  await database.query("DELETE FROM schema_migrations WHERE version = '002-contribution-ouverte.sql'");
  assert.deepEqual(await applyPendingMigrations(testDatabaseConfiguration), ['002-contribution-ouverte.sql']);
});
