/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Règles de la contribution ouverte : présence sur le campus, forme d'une proposition, limites d'envoi,
// publication directe.

import { createCampusTest } from '../shared/presence.js';
import { cleanPath, cleanPlace, cleanText, ValidationError } from '../shared/validate.js';

export const MAX_PSEUDONYM_LENGTH = 40;
export const MAX_REPORT_LENGTH = 500;
export const MAX_REVIEW_NOTE_LENGTH = 300;
export const CONTRIBUTOR_STATUSES = ['new', 'trusted', 'blocked'];
export const PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected', 'withdrawn'];
export const ENTITY_TYPES = ['place', 'path'];
const MAX_TARGET_ID_LENGTH = 64;
const HOUR_MS = 60 * 60 * 1000;

// La limite qui compte est celle par téléphone. Celle par connexion n'est qu'un plafond contre un robot : sur le
// Wi-Fi du campus comme en 4G, beaucoup d'étudiants partagent la même adresse publique.
export const RATE_LIMITS = {
  proposalPerContributor: { kind: 'proposal_per_contributor', maxCount: 30, windowMs: HOUR_MS },
  contributorPerConnection: { kind: 'contributor_per_connection', maxCount: 100, windowMs: HOUR_MS },
  proposalPerConnection: { kind: 'proposal_per_connection', maxCount: 500, windowMs: HOUR_MS },
};

// Règle de présence partagée avec le navigateur : voir shared/presence.js.
export {
  checkDevicePosition,
  MAX_POSITION_ACCURACY_METERS,
  MAX_POSITION_AGE_MS,
  PERIMETER_MARGIN_METERS,
  POSITION_ERROR_MESSAGES,
} from '../shared/presence.js';

function cleanTargetId(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_TARGET_ID_LENGTH) {
    throw new ValidationError('targetId est obligatoire pour une correction ou un signalement');
  }
  return value;
}

// Ce qu'un contributeur peut proposer : créer un lieu ou un chemin, corriger un lieu, signaler une erreur sur
// l'un ou l'autre. Lieux et chemins sont validés comme dans le mode collecte.
export function cleanProposal(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('Corps de requête invalide');
  const { entityType, action } = input;
  if (!ENTITY_TYPES.includes(entityType)) throw new ValidationError('entityType accepte place ou path');
  const allowedActions = entityType === 'place' ? ['create', 'update', 'report'] : ['create', 'report'];
  if (!allowedActions.includes(action)) {
    throw new ValidationError(`action accepte ${allowedActions.join(', ')} pour ce type d'élément`);
  }
  const targetId = action === 'create' ? null : cleanTargetId(input.targetId);
  if (action === 'report') {
    const message = cleanText(input.payload?.message, MAX_REPORT_LENGTH, 'Message du signalement', true);
    return { entityType, action, targetId, payload: { message } };
  }
  const payload = entityType === 'place' ? cleanPlace(input.payload) : cleanPath(input.payload);
  return { entityType, action, targetId, payload };
}

// Points qui doivent se trouver dans le périmètre : le lieu et ses entrées, ou chaque point du chemin.
// Un signalement n'en a pas.
export function listProposalPoints({ entityType, action, payload }) {
  if (action === 'report') return [];
  if (entityType === 'place') {
    return [
      [payload.longitude, payload.latitude],
      ...payload.entrances.map((entrance) => [entrance.longitude, entrance.latitude]),
    ];
  }
  return payload.coordinates;
}

// Le périmètre est préparé une seule fois pour tous les points : un chemin de 5000 points reste rapide à contrôler.
export function isGeometryInsidePerimeter(points, perimeter) {
  const isOnCampus = createCampusTest(perimeter);
  return points.every((point) => isOnCampus(point));
}

// Publication directe réservée au contributeur de confiance. Un signalement attend toujours un relecteur.
export const isPublishedDirectly = (contributor, proposal) =>
  contributor.status === 'trusted' && proposal.action !== 'report';

export const cleanPseudonym = (value) => cleanText(value, MAX_PSEUDONYM_LENGTH, 'Pseudo') || null;

export function cleanReview(input) {
  const status = input?.status;
  if (status !== 'accepted' && status !== 'rejected') throw new ValidationError('status accepte accepted ou rejected');
  return { status, note: cleanText(input.note, MAX_REVIEW_NOTE_LENGTH, 'Note de relecture') || null };
}

export function cleanContributorStatus(input) {
  const status = input?.status;
  if (!CONTRIBUTOR_STATUSES.includes(status)) throw new ValidationError('status accepte new, trusted ou blocked');
  return status;
}
