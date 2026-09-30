/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { ADMIN_ACTOR, contributorActor, reviewerActor } from '../server/actors.js';
import {
  anonymizeContributorChanges,
  findMapChange,
  listMapChanges,
  recordMapChange,
} from '../server/database/mapChangeRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const NOW = new Date('2026-09-30T08:00:00.000Z');
const place = { id: 'place_historique', name: 'Rectorat', category: 'other', aliases: ['RECT'] };
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const clearChanges = () => database.execute('DELETE FROM map_changes');

databaseTest('relit une modification avec ses états avant et après', async () => {
  await clearChanges();
  const changeId = await recordMapChange(
    database,
    {
      entityType: 'place',
      entityId: place.id,
      action: 'update',
      beforeState: place,
      afterState: { ...place, name: 'Rectorat UAC' },
      actor: reviewerActor('relecteur-1'),
    },
    NOW,
  );
  assert.deepEqual(await findMapChange(database, changeId), {
    id: changeId,
    entityType: 'place',
    entityId: place.id,
    action: 'update',
    beforeState: place,
    afterState: { ...place, name: 'Rectorat UAC' },
    actorKind: 'reviewer',
    actorId: 'relecteur-1',
    actorName: null,
    proposalId: null,
    revertsChangeId: null,
    createdAt: NOW.toISOString(),
  });
  assert.equal(await findMapChange(database, changeId + 1000), null);
  assert.equal((await findMapChange(database, changeId, { isLocking: true })).id, changeId);
});

databaseTest("liste l'historique du plus récent au plus ancien, avec filtres et pagination", async () => {
  await clearChanges();
  for (const entityId of ['place_a', 'place_b', 'place_c']) {
    await recordMapChange(
      database,
      { entityType: 'place', entityId, action: 'create', afterState: { id: entityId }, actor: ADMIN_ACTOR },
      NOW,
    );
  }
  await recordMapChange(database, { entityType: 'map', action: 'bulk', actor: ADMIN_ACTOR }, NOW);
  const firstPage = await listMapChanges(database, { page: 1, limit: 2 });
  assert.equal(firstPage.total, 4);
  assert.deepEqual(
    firstPage.items.map((change) => change.entityType),
    ['map', 'place'],
  );
  const filtered = await listMapChanges(database, { page: 1, limit: 20, entityType: 'place', entityId: 'place_b' });
  assert.deepEqual(
    filtered.items.map((change) => change.entityId),
    ['place_b'],
  );
});

databaseTest("efface l'auteur contributeur de l'historique", async () => {
  await clearChanges();
  const changeId = await recordMapChange(
    database,
    {
      entityType: 'place',
      entityId: place.id,
      action: 'create',
      afterState: place,
      actor: contributorActor('contributeur-1'),
    },
    NOW,
  );
  await anonymizeContributorChanges(database, 'contributeur-1');
  const change = await findMapChange(database, changeId);
  assert.equal(change.actorKind, 'contributor');
  assert.equal(change.actorId, null);
});
