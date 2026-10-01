/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Validation des données envoyées par le mode collecte. Partagée par l'API et les tests.

import { PLACE_CATEGORIES, DEFAULT_PLACE_CATEGORY } from './search.js';
import { PATH_TYPES, DEFAULT_PATH_TYPE } from './graph.js';

export const MAX_ALIASES = 15;
export const MAX_ENTRANCES = 10;
export const MAX_PATH_POINTS = 5000;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function cleanText(value, maxLength, label, isRequired = false) {
  const rawValue = value ?? '';
  if (typeof rawValue !== 'string') throw new ValidationError(`${label} doit être un texte`);
  const text = rawValue
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (isRequired && !text) throw new ValidationError(`${label} est obligatoire`);
  if (text.length > maxLength) throw new ValidationError(`${label} dépasse ${maxLength} caractères`);
  return text;
}

function cleanCoordinate(value, limit, label) {
  const number = Number(value);
  if (value === null || value === '' || !Number.isFinite(number) || Math.abs(number) > limit) {
    throw new ValidationError(`${label} invalide`);
  }
  return Math.round(number * 1e7) / 1e7;
}

export function cleanPosition(longitude, latitude, label = 'Position') {
  return {
    longitude: cleanCoordinate(longitude, 180, `${label} (longitude)`),
    latitude: cleanCoordinate(latitude, 90, `${label} (latitude)`),
  };
}

export function cleanPlace(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('Corps de requête invalide');
  const category = Object.hasOwn(PLACE_CATEGORIES, input.category) ? input.category : DEFAULT_PLACE_CATEGORY;
  const rawAliases = Array.isArray(input.aliases) ? input.aliases : String(input.aliases || '').split(',');
  const aliases = [
    ...new Set(rawAliases.map((alias, index) => cleanText(String(alias), 60, `Alias ${index + 1}`)).filter(Boolean)),
  ];
  if (aliases.length > MAX_ALIASES) throw new ValidationError(`${MAX_ALIASES} alias au maximum`);
  const rawEntrances = Array.isArray(input.entrances) ? input.entrances : [];
  if (rawEntrances.length > MAX_ENTRANCES) throw new ValidationError(`${MAX_ENTRANCES} entrées au maximum`);
  const entrances = rawEntrances.map((entrance, index) => {
    const label = `Entrée ${index + 1}`;
    if (!entrance || typeof entrance !== 'object') throw new ValidationError(`${label} invalide`);
    return {
      ...cleanPosition(entrance.longitude, entrance.latitude, label),
      note: cleanText(entrance.note, 120, `Note de l'entrée ${index + 1}`),
    };
  });
  return {
    name: cleanText(input.name, 120, 'Nom', true),
    category,
    aliases,
    description: cleanText(input.description, 1000, 'Description'),
    access: cleanText(input.access, 300, 'Accès'),
    ...cleanPosition(input.longitude, input.latitude, 'Position du lieu'),
    entrances,
  };
}

export function cleanPath(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('Corps de requête invalide');
  if (!Array.isArray(input.coordinates) || input.coordinates.length < 2) {
    throw new ValidationError('Un chemin doit compter au moins deux points');
  }
  if (input.coordinates.length > MAX_PATH_POINTS) {
    throw new ValidationError(`Chemin trop long (${MAX_PATH_POINTS} points au maximum)`);
  }
  return {
    type: Object.hasOwn(PATH_TYPES, input.type) ? input.type : DEFAULT_PATH_TYPE,
    name: cleanText(input.name, 120, 'Nom du chemin'),
    isFloodProne: input.isFloodProne === true,
    coordinates: input.coordinates.map((point, index) => {
      if (!Array.isArray(point)) throw new ValidationError(`Point ${index + 1} invalide`);
      const position = cleanPosition(point[0], point[1], `Point ${index + 1}`);
      return [position.longitude, position.latitude];
    }),
  };
}
