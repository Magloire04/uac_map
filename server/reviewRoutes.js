/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routes de relecture, ouvertes aux relecteurs et à l'administrateur : file des propositions, contributeurs,
// historique et annulation.

import express from 'express';
import {
  cleanContributorStatus,
  cleanReview,
  CONTRIBUTOR_STATUSES,
  ENTITY_TYPES,
  PROPOSAL_STATUSES,
} from './contributionRules.js';
import { readEntityVersion } from './database/campusMapRepository.js';
import { withTransaction } from './database/connection.js';
import { findContributorWithCounts, listContributors, setContributorStatus } from './database/contributorRepository.js';
import { listMapChanges } from './database/mapChangeRepository.js';
import {
  findProposal,
  listProposals,
  markProposalReviewed,
  rejectPendingProposalsOf,
} from './database/proposalRepository.js';
import { ApiError, asyncRoute, readFilter, readIdentifierFilter, readOrder, readPage, toPage } from './http.js';
import { revertMapChange } from './mapChangeReversal.js';
import { findEntity } from './mapEditing.js';
import { publishProposal } from './proposalPublication.js';
import { logSecurityEvent } from './securityLog.js';
import { ValidationError } from '../shared/validate.js';

const MAP_CHANGE_ENTITY_TYPES = [...ENTITY_TYPES, 'map'];

// Auteur d'une décision, pour le journal de sécurité.
const describeReviewer = (actor) => ({ reviewerKind: actor.kind, reviewerId: actor.id });

function cleanRevertedChangeId(input) {
  const changeId = input?.revertsChangeId;
  if (!Number.isSafeInteger(changeId) || changeId < 1) {
    throw new ValidationError('revertsChangeId doit être un entier positif');
  }
  return changeId;
}

export function createReviewRoutes({ database, getNow, requireStaff }) {
  const router = express.Router();

  router.get(
    '/proposals',
    requireStaff,
    asyncRoute(async (request, response) => {
      const page = readPage(request.query);
      const { query } = request;
      const filters = {
        status: readFilter(query.status, PROPOSAL_STATUSES, 'INVALID_STATUS', 'Statut de proposition inconnu'),
        entityType: readFilter(query['entity-type'], ENTITY_TYPES, 'INVALID_ENTITY_TYPE', 'Type d’élément inconnu'),
        contributorId: readIdentifierFilter(
          query['contributor-id'],
          'INVALID_CONTRIBUTOR_ID',
          'Identifiant de contributeur invalide',
        ),
        order: readOrder(query),
      };
      response.json(toPage(await listProposals(database, { ...page, ...filters }), page));
    }),
  );

  // Détail : version actuelle de la cible, conflit si elle a changé ou disparu depuis l'envoi, bilan du contributeur.
  router.get(
    '/proposals/:proposalId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const proposal = await findProposal(database, request.params.proposalId);
      if (!proposal) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'Proposition inexistante');
      const { entityType, targetId } = proposal;
      const target = targetId ? await findEntity(database, entityType, targetId) : null;
      const targetVersion = targetId ? await readEntityVersion(database, entityType, targetId) : null;
      // Seule une proposition en attente peut être en conflit : l'acceptation modifie elle-même la cible.
      const hasConflict =
        proposal.status === 'pending' && Boolean(targetId) && targetVersion?.toISOString() !== proposal.targetUpdatedAt;
      const contributor = proposal.contributorId
        ? await findContributorWithCounts(database, proposal.contributorId)
        : null;
      response.json({ data: { ...proposal, contributor, target, hasConflict } });
    }),
  );

  // Accepter publie la proposition (un signalement est seulement marqué comme traité) ; refuser la clôt.
  // Proposition verrouillée : si deux relecteurs décident en même temps, le second reçoit 409.
  router.patch(
    '/proposals/:proposalId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const { status, note } = cleanReview(request.body);
      const now = getNow();
      const reviewed = await withTransaction(database, async (connection) => {
        const proposal = await findProposal(connection, request.params.proposalId, { isLocking: true });
        if (!proposal) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'Proposition inexistante');
        if (proposal.status !== 'pending') {
          throw new ApiError(409, 'PROPOSAL_ALREADY_REVIEWED', 'Proposition déjà traitée');
        }
        if (status === 'accepted') await publishProposal(connection, proposal, request.actor, now);
        return markProposalReviewed(connection, proposal.id, { status, reviewer: request.actor, note }, now);
      });
      logSecurityEvent(status === 'accepted' ? 'proposal_accepted' : 'proposal_rejected', {
        requestId: request.requestId,
        proposalId: reviewed.id,
        ...describeReviewer(request.actor),
      });
      response.json({ data: reviewed });
    }),
  );

  router.get(
    '/contributors',
    requireStaff,
    asyncRoute(async (request, response) => {
      const page = readPage(request.query);
      const status = readFilter(request.query.status, CONTRIBUTOR_STATUSES, 'INVALID_STATUS', 'Statut inconnu');
      response.json(toPage(await listContributors(database, { ...page, status }), page));
    }),
  );

  // « me » est traité plus haut par les routes du contributeur : il désigne toujours le téléphone qui appelle.
  router.patch(
    '/contributors/:contributorId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const status = cleanContributorStatus(request.body);
      const now = getNow();
      const contributor = await withTransaction(database, async (connection) => {
        const updated = await setContributorStatus(connection, request.params.contributorId, status);
        if (updated && status === 'blocked') await rejectPendingProposalsOf(connection, updated.id, request.actor, now);
        return updated;
      });
      if (!contributor) throw new ApiError(404, 'CONTRIBUTOR_NOT_FOUND', 'Contributeur inexistant');
      logSecurityEvent('contributor_status_changed', {
        requestId: request.requestId,
        contributorId: contributor.id,
        status,
        ...describeReviewer(request.actor),
      });
      response.json({ data: await findContributorWithCounts(database, contributor.id) });
    }),
  );

  router.get(
    '/map-changes',
    requireStaff,
    asyncRoute(async (request, response) => {
      const page = readPage(request.query);
      const filters = {
        entityType: readFilter(
          request.query['entity-type'],
          MAP_CHANGE_ENTITY_TYPES,
          'INVALID_ENTITY_TYPE',
          'Type d’élément inconnu',
        ),
        entityId: readIdentifierFilter(request.query['entity-id'], 'INVALID_ENTITY_ID', 'Identifiant invalide'),
      };
      response.json(toPage(await listMapChanges(database, { ...page, ...filters }), page));
    }),
  );

  router.post(
    '/map-changes',
    requireStaff,
    asyncRoute(async (request, response) => {
      const changeId = cleanRevertedChangeId(request.body);
      const revert = await withTransaction(database, (connection) =>
        revertMapChange(connection, changeId, request.actor, getNow()),
      );
      logSecurityEvent('map_change_reverted', {
        requestId: request.requestId,
        changeId: revert.id,
        revertsChangeId: changeId,
        ...describeReviewer(request.actor),
      });
      response.status(201).json({ data: revert });
    }),
  );

  return router;
}
