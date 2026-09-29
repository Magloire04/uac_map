/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Sessions du mode collecte. La base ne contient que l'empreinte de l'identifiant de session et celle du
// jeton en vigueur : une copie de la base ne permet pas d'ouvrir une session.

import { createSessionDigest, createSessionId, SESSION_DURATION_MS } from '../adminSessions.js';

export async function createAdminSession(executor, tokenFingerprint, now = new Date()) {
  const sessionId = createSessionId();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await executor.execute('DELETE FROM admin_sessions WHERE expires_at <= ?', [now]);
  await executor.execute(
    'INSERT INTO admin_sessions (session_digest, token_fingerprint, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [createSessionDigest(sessionId), tokenFingerprint, expiresAt, now],
  );
  return { sessionId, expiresAt };
}

export async function findAdminSessionExpiration(executor, sessionId, tokenFingerprint, now = new Date()) {
  if (!sessionId) return null;
  const [rows] = await executor.execute(
    'SELECT expires_at FROM admin_sessions WHERE session_digest = ? AND token_fingerprint = ? AND expires_at > ?',
    [createSessionDigest(sessionId), tokenFingerprint, now],
  );
  return rows.length ? rows[0].expires_at : null;
}

export async function deleteAdminSession(executor, sessionId) {
  if (!sessionId) return;
  await executor.execute('DELETE FROM admin_sessions WHERE session_digest = ?', [createSessionDigest(sessionId)]);
}
