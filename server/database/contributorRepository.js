/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contributeurs : un par téléphone. Le cookie contient un secret aléatoire ; la base n'en garde que l'empreinte.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTransaction } from './connection.js';
import { anonymizeContributorChanges } from './mapChangeRepository.js';
import { toPageParameters } from './pagination.js';

export const CONTRIBUTOR_RETENTION_MONTHS = 12;

const CONTRIBUTOR_COLUMNS = 'c.id, c.link_id, c.pseudonym, c.`status`, c.created_at, c.last_seen_at';
const PROPOSAL_COUNT_COLUMNS = [
  "(SELECT COUNT(*) FROM proposals p WHERE p.contributor_id = c.id AND p.`status` = 'accepted') AS accepted_count",
  "(SELECT COUNT(*) FROM proposals p WHERE p.contributor_id = c.id AND p.`status` = 'rejected') AS rejected_count",
  "(SELECT COUNT(*) FROM proposals p WHERE p.contributor_id = c.id AND p.`status` = 'pending') AS pending_count",
].join(', ');

const toContributor = (row) => ({
  id: row.id,
  linkId: row.link_id,
  pseudonym: row.pseudonym,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  lastSeenAt: row.last_seen_at.toISOString(),
});

const toContributorWithCounts = (row) => ({
  ...toContributor(row),
  acceptedCount: Number(row.accepted_count),
  rejectedCount: Number(row.rejected_count),
  pendingCount: Number(row.pending_count),
});

const createDeviceDigest = (deviceSecret) => createHash('sha256').update(deviceSecret).digest();

export async function findContributor(executor, contributorId, { isLocking = false } = {}) {
  const lockClause = isLocking ? ' FOR UPDATE' : '';
  const [rows] = await executor.execute(
    `SELECT ${CONTRIBUTOR_COLUMNS} FROM contributors c WHERE c.id = ?${lockClause}`,
    [contributorId],
  );
  return rows.length ? toContributor(rows[0]) : null;
}

export async function createContributor(executor, { linkId, pseudonym = null }, now = new Date()) {
  const contributorId = randomUUID();
  const deviceSecret = randomBytes(32).toString('base64url');
  await executor.execute(
    'INSERT INTO contributors (id, device_digest, link_id, pseudonym, `status`, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [contributorId, createDeviceDigest(deviceSecret), linkId, pseudonym, 'new', now, now],
  );
  return { contributor: await findContributor(executor, contributorId), deviceSecret };
}

export async function findContributorByDeviceSecret(executor, deviceSecret) {
  if (typeof deviceSecret !== 'string' || !deviceSecret) return null;
  const [rows] = await executor.execute(`SELECT ${CONTRIBUTOR_COLUMNS} FROM contributors c WHERE c.device_digest = ?`, [
    createDeviceDigest(deviceSecret),
  ]);
  return rows.length ? toContributor(rows[0]) : null;
}

export async function touchContributor(executor, contributorId, now = new Date()) {
  await executor.execute('UPDATE contributors SET last_seen_at = ? WHERE id = ?', [now, contributorId]);
}

export async function updateContributorPseudonym(executor, contributorId, pseudonym) {
  await executor.execute('UPDATE contributors SET pseudonym = ? WHERE id = ?', [pseudonym, contributorId]);
  return findContributor(executor, contributorId);
}

export async function setContributorStatus(executor, contributorId, status) {
  if (!(await findContributor(executor, contributorId, { isLocking: true }))) return null;
  await executor.execute('UPDATE contributors SET `status` = ? WHERE id = ?', [status, contributorId]);
  return findContributor(executor, contributorId);
}

export async function findContributorWithCounts(executor, contributorId) {
  const [rows] = await executor.execute(
    `SELECT ${CONTRIBUTOR_COLUMNS}, ${PROPOSAL_COUNT_COLUMNS} FROM contributors c WHERE c.id = ?`,
    [contributorId],
  );
  return rows.length ? toContributorWithCounts(rows[0]) : null;
}

export async function listContributors(executor, { page, limit, status }) {
  const whereClause = status ? 'WHERE c.`status` = ?' : '';
  const parameters = status ? [status] : [];
  const [[{ total }]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM contributors c ${whereClause}`,
    parameters,
  );
  const [rows] = await executor.execute(
    `SELECT ${CONTRIBUTOR_COLUMNS}, ${PROPOSAL_COUNT_COLUMNS} FROM contributors c ${whereClause} ORDER BY c.created_at DESC, c.id LIMIT ? OFFSET ?`,
    [...parameters, ...toPageParameters({ page, limit })],
  );
  return { items: rows.map(toContributorWithCounts), total: Number(total) };
}

// À appeler dans une transaction : retire les propositions en attente, efface l'auteur de l'historique
// (« contributeur supprimé »), puis supprime le contributeur. Ses propositions traitées perdent leur auteur.
export async function deleteContributor(executor, contributorId, now = new Date()) {
  await executor.execute(
    "UPDATE proposals SET `status` = 'withdrawn', reviewed_at = ? WHERE contributor_id = ? AND `status` = 'pending'",
    [now, contributorId],
  );
  await anonymizeContributorChanges(executor, contributorId);
  const [result] = await executor.execute('DELETE FROM contributors WHERE id = ?', [contributorId]);
  return result.affectedRows > 0;
}

export async function purgeInactiveContributors(pool, inactiveSince, now = new Date()) {
  const [rows] = await pool.execute('SELECT id FROM contributors WHERE last_seen_at < ? ORDER BY last_seen_at', [
    inactiveSince,
  ]);
  for (const { id } of rows) {
    await withTransaction(pool, (connection) => deleteContributor(connection, id, now));
  }
  return rows.length;
}
