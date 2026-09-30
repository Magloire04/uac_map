/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Relecteurs nommés. Le jeton personnel n'est affiché qu'une fois, à la création : la base n'en garde que l'empreinte.

import { randomBytes, randomUUID } from 'node:crypto';
import { createTokenDigest } from '../adminSessions.js';
import { toPageParameters } from './pagination.js';

const REVIEWER_COLUMNS = 'id, name, is_active, created_at, revoked_at';

const toReviewer = (row) => ({
  id: row.id,
  name: row.name,
  isActive: Boolean(row.is_active),
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
});

export const createReviewerToken = () => randomBytes(32).toString('base64url');

export async function findReviewer(executor, reviewerId) {
  const [rows] = await executor.execute(`SELECT ${REVIEWER_COLUMNS} FROM reviewers WHERE id = ?`, [reviewerId]);
  return rows.length ? toReviewer(rows[0]) : null;
}

export async function createReviewer(executor, name, now = new Date()) {
  const reviewerId = randomUUID();
  const token = createReviewerToken();
  await executor.execute(
    'INSERT INTO reviewers (id, name, token_digest, is_active, created_at, revoked_at) VALUES (?, ?, ?, TRUE, ?, NULL)',
    [reviewerId, name, createTokenDigest(token), now],
  );
  return { reviewer: await findReviewer(executor, reviewerId), token };
}

export async function findActiveReviewerByToken(executor, token) {
  if (typeof token !== 'string' || !token) return null;
  const [rows] = await executor.execute(
    `SELECT ${REVIEWER_COLUMNS} FROM reviewers WHERE token_digest = ? AND is_active = TRUE`,
    [createTokenDigest(token)],
  );
  return rows.length ? toReviewer(rows[0]) : null;
}

export async function listReviewers(executor, { page, limit }) {
  const [[{ total }]] = await executor.execute('SELECT COUNT(*) AS total FROM reviewers');
  const [rows] = await executor.execute(
    `SELECT ${REVIEWER_COLUMNS} FROM reviewers ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    toPageParameters({ page, limit }),
  );
  return { items: rows.map(toReviewer), total: Number(total) };
}

// Faux si le relecteur n'existe pas ou est déjà révoqué. Ses sessions sont fermées.
export async function revokeReviewer(executor, reviewerId, now = new Date()) {
  const [result] = await executor.execute(
    'UPDATE reviewers SET is_active = FALSE, revoked_at = ? WHERE id = ? AND is_active = TRUE',
    [now, reviewerId],
  );
  if (result.affectedRows === 0) return false;
  await executor.execute('DELETE FROM admin_sessions WHERE reviewer_id = ?', [reviewerId]);
  return true;
}
