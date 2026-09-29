/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Base MariaDB des tests d'intégration, lue dans .env.test. Les tests vident ses tables : son nom doit se
// terminer par _test. Sans base configurée, ces tests sont ignorés en local et font échouer la CI.

import { test, before, after } from 'node:test';
import mysql from 'mysql2/promise';
import { readDatabaseConfiguration } from '../server/configuration.js';
import { createDatabasePool } from '../server/database/connection.js';
import { applyPendingMigrations } from '../server/database/migrations.js';

const SKIP_REASON = 'aucune base de test configurée (copier .env.test.example en .env.test)';

function readTestDatabaseConfiguration() {
  if (!process.env.DATABASE_NAME) {
    if (process.env.CI) throw new Error('CI : variables DATABASE_* obligatoires pour les tests de base de données');
    return null;
  }
  const configuration = readDatabaseConfiguration(process.env);
  if (!configuration.database.endsWith('_test')) {
    throw new Error(`Base de test refusée : « ${configuration.database} » ne se termine pas par _test`);
  }
  return configuration;
}

export const testDatabaseConfiguration = readTestDatabaseConfiguration();
if (!testDatabaseConfiguration) process.emitWarning(`Tests de base de données ignorés : ${SKIP_REASON}`);

// Remplacent test, before et after dans les fichiers qui ont besoin de la base.
export const databaseTest = testDatabaseConfiguration
  ? test
  : (name, ...rest) => test(name, { skip: SKIP_REASON }, rest.at(-1));
export const databaseBefore = testDatabaseConfiguration ? before : () => {};
export const databaseAfter = testDatabaseConfiguration ? after : () => {};

export const createTestPool = () => createDatabasePool(testDatabaseConfiguration);

// Supprime toutes les tables de la base de test, schema_migrations comprise.
export async function dropAllTestTables() {
  const connection = await mysql.createConnection({ ...testDatabaseConfiguration, multipleStatements: true });
  try {
    const [rows] = await connection.query(
      'SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    if (rows.length) {
      const tableList = rows.map((row) => `\`${row.tableName}\``).join(', ');
      await connection.query(`SET FOREIGN_KEY_CHECKS = 0; DROP TABLE ${tableList}; SET FOREIGN_KEY_CHECKS = 1`);
    }
  } finally {
    await connection.end();
  }
}

// Base de test vide, au schéma à jour.
export async function resetTestDatabase() {
  await dropAllTestTables();
  await applyPendingMigrations(testDatabaseConfiguration);
}
