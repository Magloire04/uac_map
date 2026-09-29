/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Recharge le jeu de démonstration : npm run demo (-- --forcer pour écraser des données réelles).

import { buildDemoCampusMap } from '../server/demo.js';
import { readCampusMap, rewriteCampusMap } from '../server/database/campusMapRepository.js';
import { runWithDatabase } from './runWithDatabase.js';

await runWithDatabase(async (database) => {
  const campusMap = await readCampusMap(database);
  const hasRealData = !campusMap.settings.isDemo && (campusMap.places.length > 0 || campusMap.paths.length > 0);
  if (hasRealData && !process.argv.includes('--forcer')) {
    console.error('La carte contient déjà des données réelles. Relancez avec : npm run demo -- --forcer');
    process.exitCode = 1;
    return;
  }
  await rewriteCampusMap(database, () => buildDemoCampusMap());
  console.log('Données de démonstration chargées.');
});
