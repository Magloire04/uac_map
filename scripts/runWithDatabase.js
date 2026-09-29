/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ConfigurationError, readDatabaseConfiguration } from '../server/configuration.js';
import { createDatabasePool } from '../server/database/connection.js';
import { getPendingMigrations } from '../server/database/migrations.js';

// Ouvre la base, vérifie que son schéma est à jour, exécute la commande puis ferme les connexions.
export async function runWithDatabase(command) {
  let database;
  try {
    database = createDatabasePool(readDatabaseConfiguration());
    const pendingMigrations = await getPendingMigrations(database);
    if (pendingMigrations.length) {
      throw new ConfigurationError(
        `Schéma de la base en retard : lancez d'abord npm run database:migrate (${pendingMigrations.join(', ')})`,
      );
    }
    await command(database);
  } catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : `Échec : ${error.message}`);
    process.exitCode = 1;
  } finally {
    await database?.end();
  }
}
