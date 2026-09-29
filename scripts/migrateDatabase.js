/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Applique les migrations du schéma manquantes : npm run database:migrate

import { ConfigurationError, readDatabaseConfiguration } from '../server/configuration.js';
import { applyPendingMigrations } from '../server/database/migrations.js';

try {
  const appliedMigrations = await applyPendingMigrations(readDatabaseConfiguration(), {
    log: (fileName) => console.log(`Migration appliquée : ${fileName}`),
  });
  console.log(
    appliedMigrations.length ? `${appliedMigrations.length} migration(s) appliquée(s).` : 'Schéma déjà à jour.',
  );
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : `Échec des migrations : ${error.message}`);
  process.exitCode = 1;
}
