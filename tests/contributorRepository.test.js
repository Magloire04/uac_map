/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { contributorActor } from '../server/actors.js';
import { createContributionLink } from '../server/database/contributionLinkRepository.js';
import {
  createContributor,
  deleteContributor,
  findContributorByDeviceSecret,
  findContributorWithCounts,
  listContributors,
  purgeInactiveContributors,
  setContributorStatus,
  touchContributor,
  updateContributorPseudonym,
} from '../server/database/contributorRepository.js';
import { findMapChange, recordMapChange } from '../server/database/mapChangeRepository.js';
import { findProposal, insertProposal } from '../server/database/proposalRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const NOW = new Date('2026-09-30T08:00:00.000Z');
const LATER = new Date('2026-09-30T09:00:00.000Z');
let database;
let linkId;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  linkId = (await createContributionLink(database, { label: 'Test' }, NOW)).id;
});

databaseAfter(async () => {
  await database.end();
});

const clearContributors = async () => {
  await database.execute('DELETE FROM map_changes');
  await database.execute('DELETE FROM proposals');
  await database.execute('DELETE FROM contributors');
};

const proposalFor = (contributorId, status) => ({
  contributorId,
  entityType: 'place',
  action: 'report',
  targetId: 'place_x',
  targetUpdatedAt: NOW,
  payload: { message: 'Porte fermée' },
  positionAccuracyMeters: 12,
  status,
});

databaseTest('crée un contributeur retrouvé par le seul secret du cookie', async () => {
  await clearContributors();
  const { contributor, deviceSecret } = await createContributor(database, { linkId, pseudonym: 'Awa' }, NOW);
  assert.deepEqual(contributor, {
    id: contributor.id,
    linkId,
    pseudonym: 'Awa',
    status: 'new',
    createdAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
  });
  assert.equal((await findContributorByDeviceSecret(database, deviceSecret)).id, contributor.id);
  assert.equal(await findContributorByDeviceSecret(database, 'x'.repeat(5000)), null);
  assert.equal(await findContributorByDeviceSecret(database, ['secret']), null);
  const [rows] = await database.execute('SELECT device_digest FROM contributors');
  assert.ok(!rows[0].device_digest.includes(Buffer.from(deviceSecret)));
});

databaseTest('met à jour la dernière visite, le pseudo et le statut', async () => {
  await clearContributors();
  const { contributor } = await createContributor(database, { linkId }, NOW);
  await touchContributor(database, contributor.id, LATER);
  assert.equal((await updateContributorPseudonym(database, contributor.id, 'Koffi')).pseudonym, 'Koffi');
  const trusted = await setContributorStatus(database, contributor.id, 'trusted');
  assert.equal(trusted.status, 'trusted');
  assert.equal(trusted.lastSeenAt, LATER.toISOString());
  assert.equal((await setContributorStatus(database, contributor.id, 'trusted')).status, 'trusted');
  assert.equal(await setContributorStatus(database, 'inconnu', 'blocked'), null);
});

databaseTest('donne le bilan de chaque contributeur', async () => {
  await clearContributors();
  const { contributor } = await createContributor(database, { linkId }, NOW);
  await insertProposal(database, proposalFor(contributor.id, 'pending'), NOW);
  await insertProposal(database, proposalFor(contributor.id, 'accepted'), NOW);
  await insertProposal(database, proposalFor(contributor.id, 'accepted'), NOW);
  const withCounts = await findContributorWithCounts(database, contributor.id);
  assert.deepEqual([withCounts.pendingCount, withCounts.acceptedCount, withCounts.rejectedCount], [1, 2, 0]);
  const list = await listContributors(database, { page: 1, limit: 20, status: 'new' });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].acceptedCount, 2);
  assert.equal((await listContributors(database, { page: 1, limit: 20, status: 'blocked' })).total, 0);
});

databaseTest('oublie un contributeur : propositions en attente retirées, auteur effacé', async () => {
  await clearContributors();
  const { contributor } = await createContributor(database, { linkId, pseudonym: 'Awa' }, NOW);
  const pending = await insertProposal(database, proposalFor(contributor.id, 'pending'), NOW);
  const accepted = await insertProposal(database, proposalFor(contributor.id, 'accepted'), NOW);
  const changeId = await recordMapChange(
    database,
    {
      entityType: 'place',
      entityId: 'place_x',
      action: 'create',
      afterState: { id: 'place_x' },
      actor: contributorActor(contributor.id),
    },
    NOW,
  );
  assert.equal((await findMapChange(database, changeId)).actorName, 'Awa');
  assert.equal(await deleteContributor(database, contributor.id, LATER), true);
  const withdrawn = await findProposal(database, pending.id);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal(withdrawn.contributorId, null);
  assert.equal((await findProposal(database, accepted.id)).status, 'accepted');
  assert.equal((await findMapChange(database, changeId)).actorId, null);
  assert.equal(await deleteContributor(database, contributor.id, LATER), false);
});

databaseTest('purge les contributeurs inactifs depuis la date donnée', async () => {
  await clearContributors();
  const { contributor: former } = await createContributor(database, { linkId }, new Date('2025-01-01T00:00:00.000Z'));
  const { contributor: recent } = await createContributor(database, { linkId }, NOW);
  const deletedCount = await purgeInactiveContributors(database, new Date('2025-09-30T00:00:00.000Z'), NOW);
  assert.equal(deletedCount, 1);
  assert.equal(await findContributorWithCounts(database, former.id), null);
  assert.ok(await findContributorWithCounts(database, recent.id));
});
