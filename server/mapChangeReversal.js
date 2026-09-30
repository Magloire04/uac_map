/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Annulation d'une modification : l'élément retrouve son état d'avant, et l'annulation entre à son tour dans
// l'historique. L'élément doit être encore dans l'état laissé par la modification ; sinon il a changé depuis, et
// l'on annule d'abord les modifications plus récentes. Une opération en masse ne s'annule pas.

import { isDeepStrictEqual } from 'node:util';
import { findMapChange } from './database/mapChangeRepository.js';
import { ApiError } from './http.js';
import { findEntity, restoreEntity } from './mapEditing.js';

// À appeler dans une transaction. Le verrou sur la ligne d'historique fait passer l'une après l'autre deux
// annulations de la même modification, même quand l'élément n'existe plus (rien à verrouiller de son côté).
export async function revertMapChange(connection, changeId, actor, now) {
  const change = await findMapChange(connection, changeId, { isLocking: true });
  if (!change) throw new ApiError(404, 'CHANGE_NOT_FOUND', 'Modification inexistante');
  if (change.action === 'bulk') {
    throw new ApiError(409, 'CHANGE_NOT_REVERTIBLE', 'Une opération en masse ne s’annule pas');
  }
  const current = await findEntity(connection, change.entityType, change.entityId, { isLocking: true });
  if (!isDeepStrictEqual(current, change.afterState)) {
    throw new ApiError(
      409,
      'CHANGE_OUTDATED',
      'L’élément a changé depuis : annulez d’abord les modifications plus récentes',
    );
  }
  const revertId = await restoreEntity(
    connection,
    change.entityType,
    change.entityId,
    change.beforeState,
    { actor, revertsChangeId: change.id },
    now,
  );
  return findMapChange(connection, revertId);
}
