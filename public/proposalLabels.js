/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Libellés des propositions, communs à la contribution (Mes propositions) et à la relecture.

import { PATH_TYPES } from '/shared/graph.js';

const STATUS_LABELS = { pending: 'En attente', accepted: 'Publiée', rejected: 'Refusée', withdrawn: 'Retirée' };

export function describeProposalKind({ entityType, action }) {
  if (action === 'report') return entityType === 'place' ? 'Signalement sur un lieu' : 'Signalement sur un chemin';
  if (entityType === 'place') return action === 'create' ? 'Nouveau lieu' : 'Correction de lieu';
  return 'Nouveau chemin';
}

// Un signalement accepté n'est pas « publié » : il a été traité.
export const describeProposalStatus = ({ action, status }) =>
  action === 'report' && status === 'accepted' ? 'Traité' : STATUS_LABELS[status];

// Texte court qui identifie la proposition : nom du lieu, nom ou type du chemin, ou message du signalement.
export function summarizeProposal({ entityType, action, payload }) {
  if (action === 'report') return payload.message;
  if (entityType === 'place') return payload.name;
  return payload.name || PATH_TYPES[payload.type] || 'Chemin';
}

export const formatDateTime = (isoDate) =>
  new Date(isoDate).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
