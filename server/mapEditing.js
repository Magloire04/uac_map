/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Modifications unitaires de la carte (un lieu ou un chemin). Chacune inscrit sa ligne d'historique dans la même
// transaction : à appeler avec une connexion ouverte par withTransaction. Le contexte donne l'auteur (actor) et,
// pour une proposition publiée, son identifiant (proposalId).

import {
  deletePath,
  deletePlace,
  findPath,
  findPlace,
  insertPath,
  insertPlace,
  replacePath,
  replacePlace,
} from './database/campusMapRepository.js';
import { recordMapChange } from './database/mapChangeRepository.js';

const ENTITY_STORES = {
  place: { find: findPlace, insert: insertPlace, replace: replacePlace, remove: deletePlace },
  path: { find: findPath, insert: insertPath, replace: replacePath, remove: deletePath },
};

export const findEntity = (executor, entityType, entityId, options) =>
  ENTITY_STORES[entityType].find(executor, entityId, options);

export async function createEntity(connection, entityType, entity, { actor, proposalId = null }, now = new Date()) {
  await ENTITY_STORES[entityType].insert(connection, entity, now);
  await recordMapChange(
    connection,
    { entityType, entityId: entity.id, action: 'create', afterState: entity, actor, proposalId },
    now,
  );
  return entity;
}

// buildNext reçoit la version actuelle, lue verrouillée, et renvoie les nouveaux champs (sans identifiant).
// Null si l'élément n'existe pas.
export async function updateEntity(
  connection,
  entityType,
  entityId,
  buildNext,
  { actor, proposalId = null },
  now = new Date(),
) {
  const store = ENTITY_STORES[entityType];
  const before = await store.find(connection, entityId, { isLocking: true });
  if (!before) return null;
  const fields = buildNext(before);
  await store.replace(connection, entityId, fields, now);
  const after = { id: entityId, ...fields };
  await recordMapChange(
    connection,
    { entityType, entityId, action: 'update', beforeState: before, afterState: after, actor, proposalId },
    now,
  );
  return after;
}

export async function deleteEntity(connection, entityType, entityId, { actor }, now = new Date()) {
  const store = ENTITY_STORES[entityType];
  const before = await store.find(connection, entityId, { isLocking: true });
  if (!before) return false;
  await store.remove(connection, entityId, now);
  await recordMapChange(connection, { entityType, entityId, action: 'delete', beforeState: before, actor }, now);
  return true;
}

// Remet un élément dans un état de l'historique (null : il ne doit plus exister) et inscrit une ligne « revert ».
// Renvoie l'identifiant de cette ligne.
export async function restoreEntity(
  connection,
  entityType,
  entityId,
  state,
  { actor, revertsChangeId },
  now = new Date(),
) {
  const store = ENTITY_STORES[entityType];
  const before = await store.find(connection, entityId, { isLocking: true });
  if (state === null) {
    if (before) await store.remove(connection, entityId, now);
  } else if (before) {
    const { id, ...fields } = state;
    await store.replace(connection, id, fields, now);
  } else {
    await store.insert(connection, state, now);
  }
  return recordMapChange(
    connection,
    { entityType, entityId, action: 'revert', beforeState: before, afterState: state, actor, revertsChangeId },
    now,
  );
}
