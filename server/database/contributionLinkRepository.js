/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Liens de contribution. Le code d'un lien n'est pas un secret : il est affiché sur le site. Au plus un lien actif
// est public (celui du bouton « Contribuer à la carte »). Création et modification s'appellent dans une transaction.

import { randomBytes } from 'node:crypto';
import { toPageParameters } from './pagination.js';

const LINK_COLUMNS = 'id, label, is_active, is_public, created_at, closed_at';

const toContributionLink = (row) => ({
  id: row.id,
  label: row.label,
  isActive: Boolean(row.is_active),
  isPublic: Boolean(row.is_public),
  createdAt: row.created_at.toISOString(),
  closedAt: row.closed_at ? row.closed_at.toISOString() : null,
});

export const createLinkCode = () => randomBytes(16).toString('base64url');

export async function findContributionLink(executor, linkId, { isLocking = false } = {}) {
  if (typeof linkId !== 'string' || !linkId) return null;
  const lockClause = isLocking ? ' FOR UPDATE' : '';
  const [rows] = await executor.execute(`SELECT ${LINK_COLUMNS} FROM contribution_links WHERE id = ?${lockClause}`, [
    linkId,
  ]);
  return rows.length ? toContributionLink(rows[0]) : null;
}

export async function findPublicContributionLink(executor) {
  const [rows] = await executor.execute(
    `SELECT ${LINK_COLUMNS} FROM contribution_links WHERE is_public = TRUE AND is_active = TRUE ORDER BY created_at DESC LIMIT 1`,
  );
  return rows.length ? toContributionLink(rows[0]) : null;
}

export async function listContributionLinks(executor, { page, limit }) {
  const [[{ total }]] = await executor.execute('SELECT COUNT(*) AS total FROM contribution_links');
  const [rows] = await executor.execute(
    `SELECT ${LINK_COLUMNS} FROM contribution_links ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    toPageParameters({ page, limit }),
  );
  return { items: rows.map(toContributionLink), total: Number(total) };
}

export async function createContributionLink(executor, { label, isPublic = false }, now = new Date()) {
  const linkId = createLinkCode();
  if (isPublic) await executor.execute('UPDATE contribution_links SET is_public = FALSE WHERE is_public = TRUE');
  await executor.execute(
    'INSERT INTO contribution_links (id, label, is_active, is_public, created_at, closed_at) VALUES (?, ?, TRUE, ?, ?, NULL)',
    [linkId, label, isPublic, now],
  );
  return findContributionLink(executor, linkId);
}

// Fermer un lien lui retire aussi le statut public ; en désigner un public le retire aux autres.
export async function updateContributionLink(executor, linkId, { label, isActive, isPublic }, now = new Date()) {
  const existing = await findContributionLink(executor, linkId, { isLocking: true });
  if (!existing) return null;
  if (label !== undefined) {
    await executor.execute('UPDATE contribution_links SET label = ? WHERE id = ?', [label, linkId]);
  }
  if (isActive === false && existing.isActive) {
    await executor.execute(
      'UPDATE contribution_links SET is_active = FALSE, is_public = FALSE, closed_at = ? WHERE id = ?',
      [now, linkId],
    );
  }
  if (isActive === true && !existing.isActive) {
    await executor.execute('UPDATE contribution_links SET is_active = TRUE, closed_at = NULL WHERE id = ?', [linkId]);
  }
  if (isPublic === true) {
    await executor.execute('UPDATE contribution_links SET is_public = FALSE WHERE is_public = TRUE AND id <> ?', [
      linkId,
    ]);
    await executor.execute('UPDATE contribution_links SET is_public = TRUE WHERE id = ?', [linkId]);
  }
  if (isPublic === false) {
    await executor.execute('UPDATE contribution_links SET is_public = FALSE WHERE id = ?', [linkId]);
  }
  return findContributionLink(executor, linkId);
}
