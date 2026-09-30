/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Propositions des contributeurs. La carte publique ne les voit jamais : seule leur publication (acceptation par un
// relecteur, ou envoi d'un contributeur de confiance) écrit dans les lieux et les chemins.

import { randomUUID } from 'node:crypto';
import { readJsonColumn } from './jsonColumns.js';
import { toPageParameters } from './pagination.js';

const PROPOSAL_COLUMNS = [
  'p.id, p.contributor_id, p.entity_type, p.`action`, p.target_id, p.target_updated_at, p.payload',
  'p.position_accuracy_meters, p.`status`, p.reviewer_kind, p.reviewer_id, p.review_note, p.created_at, p.reviewed_at',
  'c.pseudonym AS contributor_pseudonym, c.`status` AS contributor_status',
].join(', ');
const FROM_PROPOSALS = 'FROM proposals p LEFT JOIN contributors c ON c.id = p.contributor_id';
const SORT_DIRECTIONS = { asc: 'ASC', desc: 'DESC' };

const toIsoOrNull = (date) => (date ? date.toISOString() : null);

const toProposal = (row) => ({
  id: row.id,
  contributorId: row.contributor_id,
  contributor: row.contributor_id
    ? { id: row.contributor_id, pseudonym: row.contributor_pseudonym, status: row.contributor_status }
    : null,
  entityType: row.entity_type,
  action: row.action,
  targetId: row.target_id,
  targetUpdatedAt: toIsoOrNull(row.target_updated_at),
  payload: readJsonColumn(row.payload),
  positionAccuracyMeters: row.position_accuracy_meters,
  status: row.status,
  reviewerKind: row.reviewer_kind,
  reviewerId: row.reviewer_id,
  reviewNote: row.review_note,
  createdAt: row.created_at.toISOString(),
  reviewedAt: toIsoOrNull(row.reviewed_at),
});

// isLocking : verrou posé sur la seule proposition, pas sur son contributeur (MariaDB ne connaît pas FOR UPDATE OF).
// Relire une proposition pendant que l'on bloque son contributeur ne peut donc pas créer d'interblocage.
export async function findProposal(executor, proposalId, { isLocking = false } = {}) {
  if (isLocking) {
    const [lockedRows] = await executor.execute('SELECT id FROM proposals WHERE id = ? FOR UPDATE', [proposalId]);
    if (!lockedRows.length) return null;
  }
  const [rows] = await executor.execute(`SELECT ${PROPOSAL_COLUMNS} ${FROM_PROPOSALS} WHERE p.id = ?`, [proposalId]);
  return rows.length ? toProposal(rows[0]) : null;
}

export async function insertProposal(executor, proposal, now = new Date()) {
  const proposalId = randomUUID();
  await executor.execute(
    'INSERT INTO proposals (id, contributor_id, entity_type, `action`, target_id, target_updated_at, payload, position_accuracy_meters, `status`, reviewer_kind, reviewer_id, review_note, created_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)',
    [
      proposalId,
      proposal.contributorId,
      proposal.entityType,
      proposal.action,
      proposal.targetId ?? null,
      proposal.targetUpdatedAt ?? null,
      JSON.stringify(proposal.payload),
      proposal.positionAccuracyMeters,
      proposal.status,
      now,
      proposal.status === 'accepted' ? now : null,
    ],
  );
  return findProposal(executor, proposalId);
}

export async function listProposals(executor, { page, limit, status, entityType, contributorId, order = 'asc' }) {
  const conditions = [];
  const parameters = [];
  if (status) {
    conditions.push('p.`status` = ?');
    parameters.push(status);
  }
  if (entityType) {
    conditions.push('p.entity_type = ?');
    parameters.push(entityType);
  }
  if (contributorId) {
    conditions.push('p.contributor_id = ?');
    parameters.push(contributorId);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const direction = SORT_DIRECTIONS[order] ?? 'ASC';
  const [[{ total }]] = await executor.execute(`SELECT COUNT(*) AS total FROM proposals p ${whereClause}`, parameters);
  const [rows] = await executor.execute(
    `SELECT ${PROPOSAL_COLUMNS} ${FROM_PROPOSALS} ${whereClause} ORDER BY p.created_at ${direction}, p.id ${direction} LIMIT ? OFFSET ?`,
    [...parameters, ...toPageParameters({ page, limit })],
  );
  return { items: rows.map(toProposal), total: Number(total) };
}

// Null si la proposition n'est plus en attente : deux relecteurs ne peuvent pas la traiter tous les deux.
export async function markProposalReviewed(executor, proposalId, { status, reviewer, note = null }, now = new Date()) {
  const [result] = await executor.execute(
    "UPDATE proposals SET `status` = ?, reviewer_kind = ?, reviewer_id = ?, review_note = ?, reviewed_at = ? WHERE id = ? AND `status` = 'pending'",
    [status, reviewer.kind, reviewer.id ?? null, note, now, proposalId],
  );
  return result.affectedRows === 0 ? null : findProposal(executor, proposalId);
}

export async function rejectPendingProposalsOf(executor, contributorId, reviewer, now = new Date()) {
  const [result] = await executor.execute(
    "UPDATE proposals SET `status` = 'rejected', reviewer_kind = ?, reviewer_id = ?, review_note = ?, reviewed_at = ? WHERE contributor_id = ? AND `status` = 'pending'",
    [reviewer.kind, reviewer.id ?? null, 'Téléphone bloqué', now, contributorId],
  );
  return result.affectedRows;
}
