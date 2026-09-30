/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { reviewerActor } from '../server/actors.js';
import { createContributionLink } from '../server/database/contributionLinkRepository.js';
import { createContributor } from '../server/database/contributorRepository.js';
import {
  findProposal,
  insertProposal,
  listProposals,
  markProposalReviewed,
  rejectPendingProposalsOf,
} from '../server/database/proposalRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const NOW = new Date('2026-09-30T08:00:00.000Z');
const LATER = new Date('2026-09-30T09:00:00.000Z');
const REVIEWER = reviewerActor('relecteur-1');
let database;
let contributor;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
  const linkId = (await createContributionLink(database, { label: 'Test' }, NOW)).id;
  contributor = (await createContributor(database, { linkId, pseudonym: 'Awa' }, NOW)).contributor;
});

databaseAfter(async () => {
  await database.end();
});

const newPlace = {
  name: 'Kiosque',
  category: 'food',
  aliases: [],
  description: '',
  access: '',
  longitude: 2.342,
  latitude: 6.416,
  entrances: [],
};
const proposalInput = (overrides = {}) => ({
  contributorId: contributor.id,
  entityType: 'place',
  action: 'create',
  targetId: null,
  targetUpdatedAt: null,
  payload: newPlace,
  positionAccuracyMeters: 8.5,
  status: 'pending',
  ...overrides,
});

const clearProposals = () => database.execute('DELETE FROM proposals');

databaseTest('relit une proposition avec son contributeur', async () => {
  await clearProposals();
  const proposal = await insertProposal(database, proposalInput(), NOW);
  assert.deepEqual(proposal, {
    id: proposal.id,
    contributorId: contributor.id,
    contributor: { id: contributor.id, pseudonym: 'Awa', status: 'new' },
    entityType: 'place',
    action: 'create',
    targetId: null,
    targetUpdatedAt: null,
    payload: newPlace,
    positionAccuracyMeters: 8.5,
    status: 'pending',
    reviewerKind: null,
    reviewerId: null,
    reviewNote: null,
    createdAt: NOW.toISOString(),
    reviewedAt: null,
  });
  assert.equal(await findProposal(database, 'inconnue'), null);
  assert.equal((await findProposal(database, proposal.id, { isLocking: true })).id, proposal.id);
  assert.equal(await findProposal(database, 'inconnue', { isLocking: true }), null);
});

databaseTest('une proposition publiée directement est datée de sa publication', async () => {
  await clearProposals();
  const proposal = await insertProposal(database, proposalInput({ status: 'accepted' }), NOW);
  assert.equal(proposal.reviewedAt, NOW.toISOString());
});

databaseTest('liste la file dans l' + String.fromCharCode(39) + 'ordre demandé, avec filtres', async () => {
  await clearProposals();
  const first = await insertProposal(database, proposalInput(), NOW);
  const second = await insertProposal(
    database,
    proposalInput({ entityType: 'path', action: 'report', targetId: 'path_x', payload: { message: 'Boue' } }),
    LATER,
  );
  const queue = await listProposals(database, { page: 1, limit: 20, status: 'pending', order: 'asc' });
  assert.deepEqual(
    queue.items.map((proposal) => proposal.id),
    [first.id, second.id],
  );
  const mine = await listProposals(database, { page: 1, limit: 20, contributorId: contributor.id, order: 'desc' });
  assert.equal(mine.items[0].id, second.id);
  assert.equal((await listProposals(database, { page: 1, limit: 20, entityType: 'path' })).total, 1);
});

databaseTest('ne traite une proposition qu' + String.fromCharCode(39) + 'une seule fois', async () => {
  await clearProposals();
  const proposal = await insertProposal(database, proposalInput(), NOW);
  const rejected = await markProposalReviewed(
    database,
    proposal.id,
    { status: 'rejected', reviewer: REVIEWER, note: 'Doublon' },
    LATER,
  );
  assert.deepEqual(
    [rejected.status, rejected.reviewerKind, rejected.reviewerId, rejected.reviewNote, rejected.reviewedAt],
    ['rejected', 'reviewer', 'relecteur-1', 'Doublon', LATER.toISOString()],
  );
  assert.equal(
    await markProposalReviewed(database, proposal.id, { status: 'accepted', reviewer: REVIEWER }, LATER),
    null,
  );
});

databaseTest(
  'refuse d' +
    String.fromCharCode(39) +
    'un coup les propositions en attente d' +
    String.fromCharCode(39) +
    'un contributeur',
  async () => {
    await clearProposals();
    await insertProposal(database, proposalInput(), NOW);
    await insertProposal(database, proposalInput(), NOW);
    const accepted = await insertProposal(database, proposalInput({ status: 'accepted' }), NOW);
    assert.equal(await rejectPendingProposalsOf(database, contributor.id, REVIEWER, LATER), 2);
    assert.equal((await findProposal(database, accepted.id)).status, 'accepted');
    assert.equal((await listProposals(database, { page: 1, limit: 20, status: 'pending' })).total, 0);
  },
);
