/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Limite les essais de jeton : 10 échecs par client sur 15 minutes, partagés entre toutes les copies de
// l'application. Le client n'est connu que par une empreinte HMAC, effacée à la fin de sa fenêtre.

export const MAX_FAILED_ATTEMPTS = 10;
export const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export async function isClientBlocked(executor, clientDigest, now = new Date()) {
  const [rows] = await executor.execute(
    'SELECT failure_count FROM failed_login_attempts WHERE client_digest = ? AND reset_at > ?',
    [clientDigest, now],
  );
  return rows.length > 0 && rows[0].failure_count >= MAX_FAILED_ATTEMPTS;
}

export async function recordFailedAttempt(executor, clientDigest, now = new Date()) {
  await executor.execute('DELETE FROM failed_login_attempts WHERE reset_at <= ?', [now]);
  await executor.execute(
    `INSERT INTO failed_login_attempts (client_digest, failure_count, reset_at) VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE failure_count = failure_count + 1`,
    [clientDigest, new Date(now.getTime() + FAILED_ATTEMPT_WINDOW_MS)],
  );
}

export async function clearFailedAttempts(executor, clientDigest) {
  await executor.execute('DELETE FROM failed_login_attempts WHERE client_digest = ?', [clientDigest]);
}

// Réserve un essai AVANT de comparer le jeton : l'incrément est atomique (clé primaire + LAST_INSERT_ID),
// donc des requêtes lancées en parallèle ne peuvent pas dépasser la limite. Faux quand la limite est atteinte.
// Une connexion réussie efface ensuite le compteur (clearFailedAttempts).
export async function reserveLoginAttempt(executor, clientDigest, now = new Date()) {
  await executor.execute('DELETE FROM failed_login_attempts WHERE reset_at <= ?', [now]);
  const [result] = await executor.execute(
    `INSERT INTO failed_login_attempts (client_digest, failure_count, reset_at) VALUES (?, 1, ?)
     ON DUPLICATE KEY UPDATE failure_count = LAST_INSERT_ID(failure_count + 1)`,
    [clientDigest, new Date(now.getTime() + FAILED_ATTEMPT_WINDOW_MS)],
  );
  const attemptCount = result.affectedRows === 1 ? 1 : Number(result.insertId);
  return attemptCount <= MAX_FAILED_ATTEMPTS;
}
