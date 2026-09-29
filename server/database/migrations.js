/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Migrations du schéma : fichiers NNN-description.sql appliqués dans l'ordre, une seule fois chacun.
// Un fichier déjà appliqué ne se modifie jamais : toute évolution passe par un nouveau fichier.

import mysql from 'mysql2/promise';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE_PATTERN = /^\d{3}-[a-z0-9-]+\.sql$/;
const MIGRATIONS_LOCK = 'uac_map_migrations';

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) NOT NULL,
  applied_at DATETIME(3) NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function listMigrationFiles(directory = MIGRATIONS_DIRECTORY) {
  const fileNames = await readdir(directory);
  return fileNames.filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName)).sort();
}

async function readAppliedVersions(executor) {
  try {
    const [rows] = await executor.query('SELECT version FROM schema_migrations');
    return new Set(rows.map((row) => row.version));
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') return new Set();
    throw error;
  }
}

export async function getPendingMigrations(executor, directory = MIGRATIONS_DIRECTORY) {
  const appliedVersions = await readAppliedVersions(executor);
  return (await listMigrationFiles(directory)).filter((fileName) => !appliedVersions.has(fileName));
}

// Connexion dédiée, seule autorisée à envoyer plusieurs instructions à la fois. Le verrou empêche
// deux exécutions simultanées : la seconde attend puis ne trouve plus rien à appliquer.
export async function applyPendingMigrations(configuration, { directory = MIGRATIONS_DIRECTORY, log = () => {} } = {}) {
  const connection = await mysql.createConnection({
    ...configuration,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    multipleStatements: true,
  });
  try {
    const [[{ isLocked }]] = await connection.query('SELECT GET_LOCK(?, 30) AS isLocked', [MIGRATIONS_LOCK]);
    if (isLocked !== 1) throw new Error('Une autre migration est en cours : réessayez dans un instant');
    try {
      await connection.query(CREATE_MIGRATIONS_TABLE);
      const appliedNow = [];
      for (const fileName of await getPendingMigrations(connection, directory)) {
        try {
          await connection.query(await readFile(join(directory, fileName), 'utf8'));
          await connection.execute('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [
            fileName,
            new Date(),
          ]);
        } catch (error) {
          throw new Error(`Migration ${fileName} en échec : ${error.message}`, { cause: error });
        }
        appliedNow.push(fileName);
        log(fileName);
      }
      return appliedNow;
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATIONS_LOCK]);
    }
  } finally {
    await connection.end();
  }
}
