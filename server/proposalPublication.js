/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Publication d'une proposition sur la carte : acceptée par un relecteur, ou envoyée par un contributeur de
// confiance. À appeler dans la transaction qui enregistre le statut de la proposition : si la publication échoue,
// la proposition reste en attente.

import { generateId } from './database/campusMapRepository.js';
import { ApiError } from './http.js';
import { createEntity, updateEntity } from './mapEditing.js';

const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

// Identifiant court tiré au hasard. En cas de doublon, seule l'insertion échoue, pas la transaction : on retente une fois.
async function createWithFreshId(connection, entityType, fields, context, now) {
  const create = () => createEntity(connection, entityType, { id: generateId(entityType), ...fields }, context, now);
  try {
    return await create();
  } catch (error) {
    if (error.code !== DUPLICATE_ENTRY) throw error;
    return create();
  }
}

// Renvoie l'identifiant du lieu ou du chemin publié. Un signalement ne modifie pas la carte : null.
export async function publishProposal(connection, proposal, actor, now) {
  if (proposal.action === 'report') return null;
  const context = { actor, proposalId: proposal.id };
  if (proposal.action === 'create') {
    return (await createWithFreshId(connection, proposal.entityType, proposal.payload, context, now)).id;
  }
  const updated = await updateEntity(
    connection,
    proposal.entityType,
    proposal.targetId,
    () => proposal.payload,
    context,
    now,
  );
  if (!updated) throw new ApiError(404, 'TARGET_NOT_FOUND', 'L’élément visé n’existe plus');
  return updated.id;
}
