/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Jeu de démonstration : un petit réseau fictif posé au centre du campus pour tester
// recherche et itinéraires dès le premier lancement. Les positions ne correspondent PAS aux vrais bâtiments.

import { createProjector } from '../shared/geo.js';
import { createEmptyCampusMap, DEFAULT_CENTER } from './campusMapDefaults.js';

const roundCoordinate = (value) => Math.round(value * 1e7) / 1e7;

export function buildDemoCampusMap(center = DEFAULT_CENTER) {
  const projector = createProjector(center[1]);
  const planeCenter = projector.toPlane(center);
  // Position à partir d'un décalage en mètres vers l'est (eastMeters) et le nord (northMeters).
  const toLonLat = (eastMeters, northMeters) =>
    projector.toLonLat([planeCenter[0] + eastMeters, planeCenter[1] + northMeters]).map(roundCoordinate);
  const toLine = (...offsets) => offsets.map(([eastMeters, northMeters]) => toLonLat(eastMeters, northMeters));

  let pathCount = 0;
  const createPath = (type, coordinates, extra = {}) => ({
    id: `demo_path_${++pathCount}`,
    type,
    name: '',
    isFloodProne: false,
    coordinates,
    ...extra,
  });
  let placeCount = 0;
  const createPlace = (name, category, [eastMeters, northMeters], entrances, extra = {}) => {
    const [longitude, latitude] = toLonLat(eastMeters, northMeters);
    return {
      id: `demo_place_${++placeCount}`,
      name: `Démo · ${name}`,
      category,
      aliases: [],
      description: '',
      access: '',
      longitude,
      latitude,
      entrances: entrances.map(([entranceEast, entranceNorth, note]) => {
        const [entranceLongitude, entranceLatitude] = toLonLat(entranceEast, entranceNorth);
        return { longitude: entranceLongitude, latitude: entranceLatitude, note };
      }),
      ...extra,
    };
  };

  const campusMap = createEmptyCampusMap();
  campusMap.settings.isDemo = true;
  campusMap.settings.center = center;
  campusMap.paths = [
    createPath('road', toLine([0, -235], [0, -100], [0, 0], [0, 90], [0, 180]), { name: 'Voie principale' }),
    createPath('footpath', toLine([-220, 0], [-120, 0], [0, 0], [100, 0], [180, 0]), { name: 'Allée centrale' }),
    createPath('footpath', toLine([-180, 90], [0, 90], [100, 90], [180, 90]), { name: 'Allée nord' }),
    createPath('track', toLine([-180, 0], [-180, 90]), { isFloodProne: true, name: 'Piste ouest' }),
    createPath('footpath', toLine([180, 0], [180, 90])),
    createPath('footpath', toLine([100, 0], [100, 40])),
    createPath('stairs', toLine([100, 40], [100, 55]), { name: 'Escaliers du talus' }),
    createPath('footpath', toLine([100, 55], [100, 90])),
    createPath('footpath', toLine([0, -100], [120, -100], [120, -150])),
    createPath('footpath', toLine([-120, 0], [-120, -50])),
    createPath('footpath', toLine([0, -60], [35, -60])),
  ];
  campusMap.places = [
    createPlace('Portail principal', 'gate', [0, -240], [[0, -232, 'Entrée piétonne à gauche de la barrière']]),
    createPlace('Rectorat', 'administration', [-60, -30], [[-60, -3, "Porte principale, face à l'allée centrale"]], {
      aliases: ['administration centrale'],
      access: 'Rez-de-chaussée : accueil',
    }),
    createPlace(
      'Amphi A',
      'lecture-hall',
      [150, 45],
      [
        [150, 88, 'Grande porte côté allée nord'],
        [177, 45, 'Porte latérale est'],
      ],
      { aliases: ['amphi 1000'] },
    ),
    createPlace(
      'Bibliothèque universitaire',
      'library',
      [-100, 115],
      [[-100, 93, 'Entrée unique, sacs au vestiaire']],
      {
        aliases: ['BU', 'biblio'],
      },
    ),
    createPlace('Restaurant universitaire', 'food', [135, -160], [[122, -152, 'Porte côté allée']], {
      aliases: ['resto U', 'RU', 'restau'],
    }),
    createPlace('Infirmerie', 'health', [-120, -65], [[-120, -54, "Porte d'accueil"]], {
      aliases: ['centre de santé', 'dispensaire'],
    }),
    createPlace('Scolarité centrale', 'administration', [45, -60], [[37, -60, 'Guichets au rez-de-chaussée']], {
      access: 'Guichets 1 à 6',
    }),
    createPlace('Parking visiteurs', 'transport', [-35, -200], [[-8, -200, '']]),
  ];
  return campusMap;
}
