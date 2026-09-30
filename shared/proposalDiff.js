/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Comparaison champ par champ entre la version actuelle d'un lieu et la correction proposée, pour la relecture.

import { PLACE_CATEGORIES } from './search.js';
import { getDistance } from './geo.js';
import { formatDistance } from './instructions.js';

const MIN_MOVE_METERS = 1;

const describeEntrances = (entrances) =>
  entrances.length
    ? `${entrances.length} : ${entrances.map((entrance, index) => entrance.note || `entrée ${index + 1}`).join(' ; ')}`
    : 'Aucune';

const PLACE_FIELDS = [
  { field: 'name', label: 'Nom', describe: (place) => place.name },
  { field: 'category', label: 'Catégorie', describe: (place) => PLACE_CATEGORIES[place.category] || place.category },
  { field: 'aliases', label: 'Autres noms', describe: (place) => place.aliases.join(', ') || '—' },
  { field: 'description', label: 'Description', describe: (place) => place.description || '—' },
  { field: 'access', label: 'Accès', describe: (place) => place.access || '—' },
  { field: 'entrances', label: 'Entrées', describe: (place) => describeEntrances(place.entrances) },
];

// Les entrées sont comparées par leurs valeurs : une base qui réordonne les clés JSON ne crée pas de fausse différence.
const toComparable = (place, field) =>
  field === 'entrances'
    ? place.entrances.map(({ longitude, latitude, note }) => [longitude, latitude, note])
    : place[field];

// Renvoie [{ field, label, before, after }] pour chaque champ modifié, dans l'ordre de la fiche. Une entrée déplacée
// sans changer de note est signalée ; le lieu lui-même apparaît s'il a bougé d'au moins un mètre.
export function listPlaceChanges(current, proposed) {
  const changes = [];
  for (const { field, label, describe } of PLACE_FIELDS) {
    if (JSON.stringify(toComparable(current, field)) === JSON.stringify(toComparable(proposed, field))) continue;
    const before = describe(current);
    const after = describe(proposed);
    changes.push({ field, label, before, after: before === after ? `${after} (emplacement modifié)` : after });
  }
  const moveMeters = getDistance([current.longitude, current.latitude], [proposed.longitude, proposed.latitude]);
  if (moveMeters >= MIN_MOVE_METERS) {
    changes.push({
      field: 'position',
      label: 'Position',
      before: 'Emplacement actuel',
      after: `Déplacé de ${formatDistance(moveMeters)}`,
    });
  }
  return changes;
}
