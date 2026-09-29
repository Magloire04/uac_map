/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { ConfigurationError, loadEnvironmentFile } from './configuration.js';
import { logError } from './securityLog.js';
import { startServer } from './startServer.js';

// Sur l'hébergement, l'application n'est pas lancée par « npm start » : le fichier .env est lu ici,
// sans jamais écraser une variable déjà définie.
loadEnvironmentFile(fileURLToPath(new URL('../.env', import.meta.url)));

startServer().catch((error) => {
  if (error instanceof ConfigurationError) console.error(`Démarrage impossible : ${error.message}`);
  else logError('startup_failed', error);
  process.exit(1);
});
