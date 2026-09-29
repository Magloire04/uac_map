/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Vide la carte (lieux et chemins) pour démarrer la vraie collecte.
import { CampusMapStore, createEmptyCampusMap } from '../server/store.js';
import { DATA_FILE } from './dataFilePath.js';

if (!process.argv.includes('--oui')) {
  console.error('Cette commande efface tous les lieux et chemins. Confirmez avec : npm run reset -- --oui');
  process.exit(1);
}
const store = new CampusMapStore(DATA_FILE);
await store.load();
await store.update((current) => Object.assign(current, createEmptyCampusMap()));
console.log("Carte vidée. Redémarrez le serveur s'il tourne.");
