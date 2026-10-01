/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Règle de présence sur le campus pour la contribution ouverte. Le navigateur l'applique avant d'ouvrir les outils
// du contributeur ; le serveur la revérifie à chaque envoi, et seul ce contrôle fait foi.

import { createPerimeterTest } from './geo.js';

export const PERIMETER_MARGIN_METERS = 50;
export const MAX_POSITION_ACCURACY_METERS = 50;
export const MAX_POSITION_AGE_MS = 2 * 60 * 1000;

export const POSITION_ERROR_MESSAGES = {
  POSITION_REQUIRED: 'Position du téléphone absente ou invalide',
  OUTSIDE_CAMPUS: 'Vous devez être sur le campus pour proposer une modification',
  POSITION_INACCURATE: `Position trop imprécise : ${MAX_POSITION_ACCURACY_METERS} m au plus`,
  POSITION_TOO_OLD: 'Position trop ancienne : actualisez-la',
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Prédicat « sur le campus, marge comprise », à préparer une fois par périmètre.
export const createCampusTest = (perimeter) => createPerimeterTest(perimeter, PERIMETER_MARGIN_METERS);

// Position envoyée avec une proposition, contrôlée dans cet ordre : forme, présence dans le périmètre (marge
// comprise), précision, âge mesuré par l'horloge du téléphone. Renvoie un code d'erreur, ou null.
export function checkDevicePosition(devicePosition, perimeter) {
  if (!devicePosition || typeof devicePosition !== 'object') return 'POSITION_REQUIRED';
  const { longitude, latitude, accuracy, ageMs } = devicePosition;
  const isWellFormed =
    [longitude, latitude, accuracy, ageMs].every(isFiniteNumber) &&
    Math.abs(longitude) <= 180 &&
    Math.abs(latitude) <= 90 &&
    accuracy >= 0;
  if (!isWellFormed) return 'POSITION_REQUIRED';
  if (!createCampusTest(perimeter)([longitude, latitude])) return 'OUTSIDE_CAMPUS';
  if (accuracy > MAX_POSITION_ACCURACY_METERS) return 'POSITION_INACCURATE';
  if (ageMs > MAX_POSITION_AGE_MS) return 'POSITION_TOO_OLD';
  return null;
}
