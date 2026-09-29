/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Charge le jeu de démonstration. Écrase des données réelles seulement avec --forcer.
import { CampusMapStore } from '../server/store.js';
import { buildDemoCampusMap } from '../server/demo.js';
import { DATA_FILE } from './dataFilePath.js';

const store = new CampusMapStore(DATA_FILE);
const campusMap = await store.load();
const hasRealData = !campusMap.settings.isDemo && (campusMap.places.length || campusMap.paths.length);
if (hasRealData && !process.argv.includes('--forcer')) {
  console.error(`${DATA_FILE} contient déjà des données réelles. Relancez avec : npm run demo -- --forcer`);
  process.exit(1);
}
await store.update((current) => Object.assign(current, buildDemoCampusMap()));
console.log("Données de démonstration chargées. Redémarrez le serveur s'il tourne.");
