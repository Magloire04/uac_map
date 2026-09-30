/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import {
  createContributionLink,
  findContributionLink,
  findPublicContributionLink,
  listContributionLinks,
  updateContributionLink,
} from '../server/database/contributionLinkRepository.js';
import { createTestPool, databaseAfter, databaseBefore, databaseTest, resetTestDatabase } from './testDatabase.js';

const NOW = new Date('2026-09-30T08:00:00.000Z');
const LATER = new Date('2026-09-30T09:00:00.000Z');
let database;

databaseBefore(async () => {
  await resetTestDatabase();
  database = createTestPool();
});

databaseAfter(async () => {
  await database.end();
});

const clearLinks = () => database.execute('DELETE FROM contribution_links');

databaseTest('crée un lien actif avec un code aléatoire', async () => {
  await clearLinks();
  const link = await createContributionLink(database, { label: 'Promo L2' }, NOW);
  assert.match(link.id, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(link, {
    id: link.id,
    label: 'Promo L2',
    isActive: true,
    isPublic: false,
    createdAt: NOW.toISOString(),
    closedAt: null,
  });
  assert.equal(await findContributionLink(database, ['pas', 'une', 'chaîne']), null);
});

databaseTest('garde au plus un lien public', async () => {
  await clearLinks();
  const first = await createContributionLink(database, { label: 'Site', isPublic: true }, NOW);
  const second = await createContributionLink(database, { label: 'Nouveau site', isPublic: true }, LATER);
  assert.equal((await findPublicContributionLink(database)).id, second.id);
  assert.equal((await findContributionLink(database, first.id)).isPublic, false);
  await updateContributionLink(database, first.id, { isPublic: true }, LATER);
  assert.equal((await findPublicContributionLink(database)).id, first.id);
  assert.equal((await findContributionLink(database, second.id)).isPublic, false);
});

databaseTest('fermer un lien lui retire le statut public, le rouvrir le réactive', async () => {
  await clearLinks();
  const link = await createContributionLink(database, { label: 'Site', isPublic: true }, NOW);
  const closed = await updateContributionLink(database, link.id, { isActive: false }, LATER);
  assert.equal(closed.isActive, false);
  assert.equal(closed.isPublic, false);
  assert.equal(closed.closedAt, LATER.toISOString());
  assert.equal(await findPublicContributionLink(database), null);
  const reopened = await updateContributionLink(database, link.id, { isActive: true, label: 'Site 2' }, LATER);
  assert.equal(reopened.isActive, true);
  assert.equal(reopened.closedAt, null);
  assert.equal(reopened.label, 'Site 2');
});

databaseTest('liste les liens du plus récent au plus ancien et ignore un lien inconnu', async () => {
  await clearLinks();
  await createContributionLink(database, { label: 'Ancien' }, NOW);
  await createContributionLink(database, { label: 'Récent' }, LATER);
  const { items, total } = await listContributionLinks(database, { page: 1, limit: 20 });
  assert.equal(total, 2);
  assert.deepEqual(
    items.map((link) => link.label),
    ['Récent', 'Ancien'],
  );
  assert.equal(await updateContributionLink(database, 'inconnu', { label: 'X' }, LATER), null);
});
