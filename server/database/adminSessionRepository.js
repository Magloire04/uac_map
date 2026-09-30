/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Sessions du mode collecte. La base ne contient que l'empreinte de l'identifiant de session et celle du
// jeton en vigueur : une copie de la base ne permet pas d'ouvrir une session.

import { createSessionDigest, createSessionId, SESSION_DURATION_MS } from '../adminSessions.js';
import { ADMIN_ACTOR, reviewerActor } from '../actors.js';

export async function createAdminSession(executor, tokenFingerprint, now = new Date(), actor = ADMIN_ACTOR) {
  const sessionId = createSessionId();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await executor.execute('DELETE FROM admin_sessions WHERE expires_at <= ?', [now]);
  await executor.execute(
    'INSERT INTO admin_sessions (session_digest, token_fingerprint, expires_at, created_at, actor_kind, reviewer_id) VALUES (?, ?, ?, ?, ?, ?)',
    [
      createSessionDigest(sessionId),
      tokenFingerprint,
      expiresAt,
      now,
      actor.kind,
      actor.kind === 'reviewer' ? actor.id : null,
    ],
  );
  return { sessionId, expiresAt };
}

// Session valide : non expirée, et ouverte avec le jeton administrateur en vigueur ou par un relecteur encore actif.
export async function findAdminSession(executor, sessionId, adminTokenFingerprint, now = new Date()) {
  if (!sessionId) return null;
  const [rows] = await executor.execute(
    `SELECT s.expires_at, s.actor_kind, s.reviewer_id, r.name AS reviewer_name FROM admin_sessions s
     LEFT JOIN reviewers r ON r.id = s.reviewer_id
     WHERE s.session_digest = ? AND s.expires_at > ?
       AND ((s.actor_kind = 'admin' AND s.token_fingerprint = ?) OR (s.actor_kind = 'reviewer' AND r.is_active = TRUE))`,
    [createSessionDigest(sessionId), now, adminTokenFingerprint],
  );
  if (!rows.length) return null;
  const [row] = rows;
  const actor = row.actor_kind === 'reviewer' ? reviewerActor(row.reviewer_id) : ADMIN_ACTOR;
  return { expiresAt: row.expires_at, actor, reviewerName: row.reviewer_name };
}

export async function deleteAdminSession(executor, sessionId) {
  if (!sessionId) return;
  await executor.execute('DELETE FROM admin_sessions WHERE session_digest = ?', [createSessionDigest(sessionId)]);
}
