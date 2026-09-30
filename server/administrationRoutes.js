/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routes réservées à l'administrateur : relecteurs, liens de contribution, suspension des contributions.
// Une session de relecteur y reçoit 403.

import express from 'express';
import { buildContributionUrl } from './contributionRoutes.js';
import { readSettings, setContributionsPaused } from './database/campusMapRepository.js';
import { withTransaction } from './database/connection.js';
import {
  createContributionLink,
  findContributionLink,
  listContributionLinks,
  updateContributionLink,
} from './database/contributionLinkRepository.js';
import { createReviewer, findReviewer, listReviewers, revokeReviewer } from './database/reviewerRepository.js';
import { ApiError, asyncRoute, readBaseUrl, readPage, toPage } from './http.js';
import { logSecurityEvent } from './securityLog.js';
import { cleanText, ValidationError } from '../shared/validate.js';

const MAX_REVIEWER_NAME_LENGTH = 80;
const MAX_LINK_LABEL_LENGTH = 80;

function cleanOptionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`${label} doit valoir true ou false`);
  return value;
}

const cleanLinkLabel = (value) => cleanText(value, MAX_LINK_LABEL_LENGTH, 'Libellé du lien', true);

function cleanLinkChanges(input) {
  const body = input ?? {};
  return {
    label: body.label === undefined ? undefined : cleanLinkLabel(body.label),
    isActive: cleanOptionalBoolean(body.isActive, 'isActive'),
    isPublic: cleanOptionalBoolean(body.isPublic, 'isPublic'),
  };
}

export function createAdministrationRoutes({ database, publicUrl, getNow, requireAdministrator }) {
  const router = express.Router();
  const withUrl = (request, link) => ({ ...link, url: buildContributionUrl(readBaseUrl(request, publicUrl), link.id) });

  router.get(
    '/reviewers',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const page = readPage(request.query);
      response.json(toPage(await listReviewers(database, page), page));
    }),
  );

  // Le jeton personnel n'est renvoyé qu'ici, une seule fois : la base n'en garde que l'empreinte.
  router.post(
    '/reviewers',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const name = cleanText(request.body?.name, MAX_REVIEWER_NAME_LENGTH, 'Nom du relecteur', true);
      const { reviewer, token } = await createReviewer(database, name, getNow());
      logSecurityEvent('reviewer_created', { requestId: request.requestId, reviewerId: reviewer.id });
      response.set('Cache-Control', 'no-store');
      response.status(201).json({ data: { ...reviewer, token } });
    }),
  );

  // Révocation : ses sessions sont fermées aussitôt. Révoquer un relecteur déjà révoqué ne change rien.
  router.delete(
    '/reviewers/:reviewerId',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const reviewer = await findReviewer(database, request.params.reviewerId);
      if (!reviewer) throw new ApiError(404, 'REVIEWER_NOT_FOUND', 'Relecteur inexistant');
      const isRevoked = await withTransaction(database, (connection) =>
        revokeReviewer(connection, reviewer.id, getNow()),
      );
      if (isRevoked) logSecurityEvent('reviewer_revoked', { requestId: request.requestId, reviewerId: reviewer.id });
      response.status(204).end();
    }),
  );

  router.get(
    '/contribution-links',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const page = readPage(request.query);
      const { items, total } = await listContributionLinks(database, page);
      response.json(toPage({ items: items.map((link) => withUrl(request, link)), total }, page));
    }),
  );

  router.post(
    '/contribution-links',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const label = cleanLinkLabel(request.body?.label);
      const isPublic = cleanOptionalBoolean(request.body?.isPublic, 'isPublic') ?? false;
      const link = await withTransaction(database, (connection) =>
        createContributionLink(connection, { label, isPublic }, getNow()),
      );
      logSecurityEvent('contribution_link_created', { requestId: request.requestId, linkId: link.id, isPublic });
      response.status(201).json({ data: withUrl(request, link) });
    }),
  );

  router.patch(
    '/contribution-links/:linkId',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const changes = cleanLinkChanges(request.body);
      const link = await withTransaction(database, async (connection) => {
        const existing = await findContributionLink(connection, request.params.linkId, { isLocking: true });
        if (!existing) return null;
        if (changes.isPublic && !(changes.isActive ?? existing.isActive)) {
          throw new ValidationError('Un lien fermé ne peut pas être le lien public');
        }
        return updateContributionLink(connection, existing.id, changes, getNow());
      });
      if (!link) throw new ApiError(404, 'LINK_NOT_FOUND', 'Lien de contribution inconnu');
      logSecurityEvent('contribution_link_updated', {
        requestId: request.requestId,
        linkId: link.id,
        isActive: link.isActive,
        isPublic: link.isPublic,
      });
      response.json({ data: withUrl(request, link) });
    }),
  );

  router.patch(
    '/campus-settings',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      const isPaused = request.body?.contributionsPaused;
      if (typeof isPaused !== 'boolean') throw new ValidationError('contributionsPaused doit valoir true ou false');
      await setContributionsPaused(database, isPaused, getNow());
      logSecurityEvent(isPaused ? 'contributions_paused' : 'contributions_resumed', { requestId: request.requestId });
      response.json({ data: await readSettings(database) });
    }),
  );

  return router;
}
