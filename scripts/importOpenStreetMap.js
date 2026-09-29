/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Importe les chemins, lieux nommés et entrées déjà présents dans OpenStreetMap pour le campus.
//   npm run import-osm                       interroge Overpass (connexion Internet requise)
//   npm run import-osm -- --fichier x.json   utilise un export Overpass déjà téléchargé
//   npm run import-osm -- --remplacer        remplace toutes les données au lieu de fusionner
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CampusMapStore } from '../server/store.js';
import { convertOverpassResponse, OVERPASS_QUERY } from '../server/openStreetMapImport.js';
import { DATA_FILE } from './dataFilePath.js';

const commandArguments = process.argv.slice(2);
const inputFile = commandArguments.includes('--fichier')
  ? commandArguments[commandArguments.indexOf('--fichier') + 1]
  : null;
const isReplacing = commandArguments.includes('--remplacer');
const overpassUrl = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

async function fetchOverpassResponse() {
  console.log(`Interrogation d'Overpass (${overpassUrl})…`);
  const response = await fetch(overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'uac-map/0.1' },
    body: new URLSearchParams({ data: OVERPASS_QUERY }),
  });
  if (!response.ok) {
    console.error(`Overpass a répondu ${response.status}. Réessayez plus tard ou changez de serveur via OVERPASS_URL.`);
    process.exit(1);
  }
  const overpassResponse = await response.json();
  const rawFile = join(dirname(DATA_FILE), 'osm-brut.json');
  await mkdir(dirname(rawFile), { recursive: true });
  await writeFile(rawFile, JSON.stringify(overpassResponse));
  console.log(`Réponse brute conservée dans ${rawFile}`);
  return overpassResponse;
}

const overpassResponse = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : await fetchOverpassResponse();
const imported = convertOverpassResponse(overpassResponse);
const store = new CampusMapStore(DATA_FILE);
await store.load();
await store.update((campusMap) => {
  const keepExisting = (items) =>
    isReplacing
      ? []
      : items.filter(
          (item) => !item.id.startsWith('osm_') && !(campusMap.settings.isDemo && item.id.startsWith('demo_')),
        );
  campusMap.paths = [...keepExisting(campusMap.paths), ...imported.paths];
  campusMap.places = [...keepExisting(campusMap.places), ...imported.places];
  campusMap.settings.isDemo = false;
  if (imported.center) campusMap.settings.center = imported.center;
});
const { counts } = imported;
console.log(`Import terminé : ${counts.paths} chemins, ${counts.places} lieux nommés, ${counts.entrances} entrées.`);
console.log("Redémarrez le serveur s'il tourne, puis complétez et corrigez en mode collecte.");
