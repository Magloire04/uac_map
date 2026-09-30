/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routes publiques et routes du contributeur : rejoindre par un lien, gérer son téléphone, proposer.
// Un contributeur est reconnu par le secret aléatoire de son cookie ; la base n'en garde que l'empreinte.

import express from 'express';
import { createHash } from 'node:crypto';
import { readCookie } from './adminSessions.js';
import { contributorActor } from './actors.js';
import {
  checkDevicePosition,
  cleanProposal,
  cleanPseudonym,
  isGeometryInsidePerimeter,
  isPublishedDirectly,
  listProposalPoints,
  POSITION_ERROR_MESSAGES,
  RATE_LIMITS,
} from './contributionRules.js';
import { readEntityVersion, readSettings } from './database/campusMapRepository.js';
import { withTransaction } from './database/connection.js';
import { findContributionLink, findPublicContributionLink } from './database/contributionLinkRepository.js';
import {
  createContributor,
  deleteContributor,
  findContributorByDeviceSecret,
  touchContributor,
  updateContributorPseudonym,
} from './database/contributorRepository.js';
import { insertProposal, listProposals } from './database/proposalRepository.js';
import { reserveRateLimit } from './database/rateLimitRepository.js';
import { ApiError, asyncRoute, readBaseUrl, readPage, sendError, toPage, writeCookie } from './http.js';
import { publishProposal } from './proposalPublication.js';
import { logSecurityEvent } from './securityLog.js';

export const CONTRIBUTOR_COOKIE_NAME = 'uac_contributor';
export const CONTRIBUTOR_COOKIE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export const buildContributionUrl = (baseUrl, linkCode) => `${baseUrl}/?contribuer=${encodeURIComponent(linkCode)}`;

const toOwnContributor = ({ id, pseudonym, status, createdAt }) => ({ id, pseudonym, status, createdAt });

// Ce que le téléphone voit de ses propositions : ni l'identité du relecteur, ni la précision de sa position.
const toOwnProposal = ({ id, entityType, action, targetId, payload, status, reviewNote, createdAt, reviewedAt }) => ({
  id,
  entityType,
  action,
  targetId,
  payload,
  status,
  reviewNote,
  createdAt,
  reviewedAt,
});

const createContributorDigest = (contributorId) => createHash('sha256').update(`contributor:${contributorId}`).digest();

export function createContributionRoutes({ database, publicUrl, getNow, getClientDigest }) {
  const router = express.Router();

  const reserveLimit = (limit, subjectDigest) => reserveRateLimit(database, limit.kind, subjectDigest, limit, getNow());
  const tooManyRequests = () => new ApiError(429, 'TOO_MANY_REQUESTS', 'Trop d’envois : réessayez dans une heure');

  // Chaque appel d'un contributeur reconnu met à jour sa dernière visite, qui sert à la purge.
  const requireContributor = asyncRoute(async (request, response, next) => {
    const contributor = await findContributorByDeviceSecret(database, readCookie(request, CONTRIBUTOR_COOKIE_NAME));
    if (!contributor) {
      return sendError(response, 401, 'NOT_A_CONTRIBUTOR', 'Ce téléphone n’a pas rejoint la contribution');
    }
    await touchContributor(database, contributor.id, getNow());
    request.contributor = contributor;
    next();
  });

  router.get(
    '/contribution/public-link',
    asyncRoute(async (request, response) => {
      const link = await findPublicContributionLink(database);
      if (!link) throw new ApiError(404, 'NO_PUBLIC_LINK', 'Aucun lien de contribution public');
      response.set('Cache-Control', 'no-cache');
      response.json({ data: { code: link.id, url: buildContributionUrl(readBaseUrl(request, publicUrl), link.id) } });
    }),
  );

  // Un téléphone déjà inscrit reçoit son contributeur existant, quel que soit le lien : rejoindre à nouveau ne
  // fait donc pas sortir d'un blocage.
  router.post(
    '/contributors',
    asyncRoute(async (request, response) => {
      const now = getNow();
      const existing = await findContributorByDeviceSecret(database, readCookie(request, CONTRIBUTOR_COOKIE_NAME));
      if (existing) {
        await touchContributor(database, existing.id, now);
        return response.json({ data: toOwnContributor(existing) });
      }
      const body = request.body ?? {};
      const pseudonym = cleanPseudonym(body.pseudonym);
      const link = await findContributionLink(database, body.linkCode);
      if (!link) throw new ApiError(404, 'LINK_NOT_FOUND', 'Lien de contribution inconnu');
      if (!link.isActive) throw new ApiError(410, 'LINK_CLOSED', 'Ce lien de contribution est fermé');
      if (!(await reserveLimit(RATE_LIMITS.contributorPerConnection, getClientDigest(request)))) {
        throw tooManyRequests();
      }
      const { contributor, deviceSecret } = await createContributor(database, { linkId: link.id, pseudonym }, now);
      writeCookie(request, response, CONTRIBUTOR_COOKIE_NAME, deviceSecret, CONTRIBUTOR_COOKIE_MAX_AGE_MS);
      logSecurityEvent('contributor_joined', {
        requestId: request.requestId,
        contributorId: contributor.id,
        linkId: link.id,
      });
      response.status(201).json({ data: toOwnContributor(contributor) });
    }),
  );

  router.get('/contributors/me', requireContributor, (request, response) => {
    response.json({ data: toOwnContributor(request.contributor) });
  });

  router.patch(
    '/contributors/me',
    requireContributor,
    asyncRoute(async (request, response) => {
      const pseudonym = cleanPseudonym(request.body?.pseudonym);
      const contributor = await updateContributorPseudonym(database, request.contributor.id, pseudonym);
      response.json({ data: toOwnContributor(contributor) });
    }),
  );

  // « Oublier ce téléphone » : ses propositions en attente sont retirées ; ce qu'il a publié reste, attribué à
  // « contributeur supprimé ».
  router.delete(
    '/contributors/me',
    requireContributor,
    asyncRoute(async (request, response) => {
      await withTransaction(database, (connection) => deleteContributor(connection, request.contributor.id, getNow()));
      writeCookie(request, response, CONTRIBUTOR_COOKIE_NAME, '', 0);
      logSecurityEvent('contributor_forgotten', {
        requestId: request.requestId,
        contributorId: request.contributor.id,
      });
      response.status(204).end();
    }),
  );

  router.get(
    '/contributors/me/proposals',
    requireContributor,
    asyncRoute(async (request, response) => {
      const page = readPage(request.query);
      const { items, total } = await listProposals(database, {
        ...page,
        contributorId: request.contributor.id,
        order: 'desc',
      });
      response.json(toPage({ items: items.map(toOwnProposal), total }, page));
    }),
  );

  // Contrôles, dans l'ordre : téléphone bloqué, contributions suspendues, périmètre absent, limites d'envoi
  // (comptées avant la validation : un robot ne peut pas essayer sans fin), forme, présence, géométrie, cible.
  router.post(
    '/proposals',
    requireContributor,
    asyncRoute(async (request, response) => {
      const { contributor } = request;
      if (contributor.status === 'blocked') {
        throw new ApiError(403, 'CONTRIBUTOR_BLOCKED', 'Ce téléphone ne peut plus proposer de modification');
      }
      const settings = await readSettings(database);
      if (settings?.contributionsPaused) {
        throw new ApiError(503, 'CONTRIBUTIONS_PAUSED', 'Les contributions sont suspendues pour le moment');
      }
      if (!settings?.perimeter) {
        throw new ApiError(503, 'PERIMETER_NOT_CONFIGURED', 'Le périmètre du campus n’est pas encore configuré');
      }
      const isWithinLimits =
        (await reserveLimit(RATE_LIMITS.proposalPerContributor, createContributorDigest(contributor.id))) &&
        (await reserveLimit(RATE_LIMITS.proposalPerConnection, getClientDigest(request)));
      if (!isWithinLimits) throw tooManyRequests();
      const proposal = cleanProposal(request.body);
      const { devicePosition } = request.body;
      const positionError = checkDevicePosition(devicePosition, settings.perimeter);
      if (positionError) throw new ApiError(422, positionError, POSITION_ERROR_MESSAGES[positionError]);
      if (!isGeometryInsidePerimeter(listProposalPoints(proposal), settings.perimeter)) {
        throw new ApiError(422, 'GEOMETRY_OUTSIDE_CAMPUS', 'Ce que vous proposez doit se trouver sur le campus');
      }
      const targetUpdatedAt = proposal.targetId
        ? await readEntityVersion(database, proposal.entityType, proposal.targetId)
        : null;
      if (proposal.targetId && !targetUpdatedAt) {
        throw new ApiError(404, 'TARGET_NOT_FOUND', 'L’élément visé n’existe pas');
      }
      const isDirect = isPublishedDirectly(contributor, proposal);
      const now = getNow();
      const saved = await withTransaction(database, async (connection) => {
        const inserted = await insertProposal(
          connection,
          {
            ...proposal,
            contributorId: contributor.id,
            targetUpdatedAt,
            positionAccuracyMeters: devicePosition.accuracy,
            status: isDirect ? 'accepted' : 'pending',
          },
          now,
        );
        if (isDirect) await publishProposal(connection, inserted, contributorActor(contributor.id), now);
        return inserted;
      });
      logSecurityEvent(isDirect ? 'proposal_published_directly' : 'proposal_submitted', {
        requestId: request.requestId,
        contributorId: contributor.id,
        proposalId: saved.id,
      });
      response.status(201).json({ data: toOwnProposal(saved) });
    }),
  );

  return router;
}
