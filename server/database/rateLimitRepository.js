/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Limites d'envoi (propositions, inscriptions), partagées entre toutes les copies de l'application. La réservation
// est atomique (clé primaire et LAST_INSERT_ID) : des requêtes parallèles ne peuvent pas dépasser la limite.

export async function reserveRateLimit(executor, limitKind, subjectDigest, { maxCount, windowMs }, now = new Date()) {
  await executor.execute('DELETE FROM rate_limits WHERE reset_at <= ?', [now]);
  const [result] = await executor.execute(
    `INSERT INTO rate_limits (limit_kind, subject_digest, attempt_count, reset_at) VALUES (?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE attempt_count = LAST_INSERT_ID(attempt_count + 1)`,
    [limitKind, subjectDigest, new Date(now.getTime() + windowMs)],
  );
  const attemptCount = result.affectedRows === 1 ? 1 : Number(result.insertId);
  return attemptCount <= maxCount;
}
