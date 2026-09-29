/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Vide la carte avant la vraie collecte : npm run reset -- --oui

import { createEmptyCampusMap } from '../server/campusMapDefaults.js';
import { rewriteCampusMap } from '../server/database/campusMapRepository.js';
import { runWithDatabase } from './runWithDatabase.js';

if (!process.argv.includes('--oui')) {
  console.error('Cette commande efface tous les lieux et chemins. Confirmez avec : npm run reset -- --oui');
  process.exitCode = 1;
} else {
  await runWithDatabase(async (database) => {
    await rewriteCampusMap(database, () => createEmptyCampusMap());
    console.log('Carte vidée.');
  });
}
