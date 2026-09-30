/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Historique des modifications publiées sur la carte. Chaque écriture unitaire y inscrit sa ligne dans la même
// transaction ; une opération en masse n'y laisse qu'une ligne « bulk », sans état, qui ne s'annule pas.

import { readJsonColumn, toJsonColumn } from './jsonColumns.js';
import { toPageParameters } from './pagination.js';

const CHANGE_COLUMNS = [
  'm.id, m.entity_type, m.entity_id, m.`action`, m.before_state, m.after_state, m.actor_kind, m.actor_id',
  'm.proposal_id, m.reverts_change_id, m.created_at, COALESCE(r.name, c.pseudonym) AS actor_name',
].join(', ');
// Nom de l'auteur : relecteur, ou pseudo du contributeur (l'historique n'est montré qu'aux relecteurs).
const FROM_CHANGES = `FROM map_changes m
  LEFT JOIN reviewers r ON m.actor_kind = 'reviewer' AND r.id = m.actor_id
  LEFT JOIN contributors c ON m.actor_kind = 'contributor' AND c.id = m.actor_id`;

const toMapChange = (row) => ({
  id: Number(row.id),
  entityType: row.entity_type,
  entityId: row.entity_id,
  action: row.action,
  beforeState: readJsonColumn(row.before_state),
  afterState: readJsonColumn(row.after_state),
  actorKind: row.actor_kind,
  actorId: row.actor_id,
  actorName: row.actor_name,
  proposalId: row.proposal_id,
  revertsChangeId: row.reverts_change_id === null ? null : Number(row.reverts_change_id),
  createdAt: row.created_at.toISOString(),
});

export async function recordMapChange(executor, change, now = new Date()) {
  const [result] = await executor.execute(
    'INSERT INTO map_changes (entity_type, entity_id, `action`, before_state, after_state, actor_kind, actor_id, proposal_id, reverts_change_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      change.entityType,
      change.entityId ?? null,
      change.action,
      toJsonColumn(change.beforeState),
      toJsonColumn(change.afterState),
      change.actor.kind,
      change.actor.id ?? null,
      change.proposalId ?? null,
      change.revertsChangeId ?? null,
      now,
    ],
  );
  return Number(result.insertId);
}

// isLocking : verrou posé sur la seule ligne d'historique, pas sur le relecteur ou le contributeur joints
// (MariaDB ne connaît pas FOR UPDATE OF). La lecture qui suit, faite verrou tenu, voit la dernière version.
export async function findMapChange(executor, changeId, { isLocking = false } = {}) {
  if (isLocking) {
    const [lockedRows] = await executor.execute('SELECT id FROM map_changes WHERE id = ? FOR UPDATE', [changeId]);
    if (!lockedRows.length) return null;
  }
  const [rows] = await executor.execute(`SELECT ${CHANGE_COLUMNS} ${FROM_CHANGES} WHERE m.id = ?`, [changeId]);
  return rows.length ? toMapChange(rows[0]) : null;
}

export async function listMapChanges(executor, { page, limit, entityType, entityId }) {
  const conditions = [];
  const parameters = [];
  if (entityType) {
    conditions.push('m.entity_type = ?');
    parameters.push(entityType);
  }
  if (entityId) {
    conditions.push('m.entity_id = ?');
    parameters.push(entityId);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [[{ total }]] = await executor.execute(
    `SELECT COUNT(*) AS total FROM map_changes m ${whereClause}`,
    parameters,
  );
  const [rows] = await executor.execute(
    `SELECT ${CHANGE_COLUMNS} ${FROM_CHANGES} ${whereClause} ORDER BY m.id DESC LIMIT ? OFFSET ?`,
    [...parameters, ...toPageParameters({ page, limit })],
  );
  return { items: rows.map(toMapChange), total: Number(total) };
}

// « Contributeur supprimé » : l'historique garde la modification, sans l'identifiant de son auteur.
export async function anonymizeContributorChanges(executor, contributorId) {
  await executor.execute("UPDATE map_changes SET actor_id = NULL WHERE actor_kind = 'contributor' AND actor_id = ?", [
    contributorId,
  ]);
}
