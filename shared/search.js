/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Recherche tolérante : sans accents, par préfixe, avec alias (sigles, surnoms) et une faute de frappe admise.

// Catégories de lieux : code technique (anglais) et libellé affiché (français).
export const PLACE_CATEGORIES = {
  administration: 'Administration',
  'lecture-hall': 'Amphithéâtre',
  classroom: 'Salle de cours',
  faculty: 'Faculté / École',
  library: 'Bibliothèque',
  food: 'Restauration',
  health: 'Santé',
  sport: 'Sport',
  housing: 'Résidence',
  worship: 'Lieu de culte',
  service: 'Service (banque, photocopie…)',
  transport: 'Transport / parking',
  gate: 'Portail / entrée du campus',
  landmark: 'Repère',
  other: 'Autre',
};

export const DEFAULT_PLACE_CATEGORY = 'other';

const EXACT_WORD_SCORE = 3;
const PREFIX_SCORE = 2;
const SUBSTRING_SCORE = 1.2;
const TYPO_SCORE = 1;

export function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Vrai si les deux mots diffèrent d'au plus une lettre (ajout, suppression ou remplacement).
export function isOneEditAway(word, candidate) {
  if (word === candidate) return true;
  if (Math.abs(word.length - candidate.length) > 1) return false;
  let wordIndex = 0;
  let candidateIndex = 0;
  let editCount = 0;
  while (wordIndex < word.length && candidateIndex < candidate.length) {
    if (word[wordIndex] === candidate[candidateIndex]) {
      wordIndex++;
      candidateIndex++;
      continue;
    }
    editCount++;
    if (editCount > 1) return false;
    if (word.length > candidate.length) wordIndex++;
    else if (word.length < candidate.length) candidateIndex++;
    else {
      wordIndex++;
      candidateIndex++;
    }
  }
  return editCount + (word.length - wordIndex) + (candidate.length - candidateIndex) <= 1;
}

function getQueryWordScore(queryWord, words) {
  let bestScore = 0;
  for (const word of words) {
    if (word === queryWord) bestScore = Math.max(bestScore, EXACT_WORD_SCORE);
    else if (word.startsWith(queryWord)) bestScore = Math.max(bestScore, PREFIX_SCORE);
    else if (queryWord.length >= 3 && word.includes(queryWord)) bestScore = Math.max(bestScore, SUBSTRING_SCORE);
    else if (
      queryWord.length >= 4 &&
      (isOneEditAway(queryWord, word) || isOneEditAway(queryWord, word.slice(0, queryWord.length)))
    ) {
      bestScore = Math.max(bestScore, TYPO_SCORE);
    }
  }
  return bestScore;
}

export function buildSearchIndex(places) {
  return places.map((place) => ({
    place,
    fields: [
      { weight: 3, words: normalizeText(place.name).split(' ') },
      { weight: 3, words: (place.aliases || []).flatMap((alias) => normalizeText(alias).split(' ')) },
      { weight: 1, words: normalizeText(PLACE_CATEGORIES[place.category] || place.category).split(' ') },
      { weight: 0.5, words: normalizeText(place.description).split(' ') },
    ],
  }));
}

// Tous les mots de la requête doivent correspondre à au moins un champ du lieu.
export function searchPlaces(searchIndex, query, maxResults = 8) {
  const queryWords = normalizeText(query).split(' ').filter(Boolean);
  if (!queryWords.length) return [];
  const matches = [];
  for (const entry of searchIndex) {
    let totalScore = 0;
    let isMatch = true;
    for (const queryWord of queryWords) {
      let bestScore = 0;
      for (const field of entry.fields)
        bestScore = Math.max(bestScore, getQueryWordScore(queryWord, field.words) * field.weight);
      if (bestScore === 0) {
        isMatch = false;
        break;
      }
      totalScore += bestScore;
    }
    if (isMatch) matches.push({ place: entry.place, score: totalScore });
  }
  matches.sort(
    (first, second) => second.score - first.score || first.place.name.localeCompare(second.place.name, 'fr'),
  );
  return matches.slice(0, maxResults).map((match) => match.place);
}
