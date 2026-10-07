/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { logSecurityEvent, logError } from './securityLog.js';
import { SESSION_COOKIE_NAME, SESSION_DURATION_MS, readCookie } from './adminSessions.js';
import { createStaffAccess, toSessionView } from './access.js';
import { withTransaction } from './database/connection.js';
import { createAdminSession, deleteAdminSession } from './database/adminSessionRepository.js';
import { clearFailedAttempts, reserveLoginAttempt } from './database/failedLoginAttemptRepository.js';
import {
  findPath,
  findPlace,
  generateId,
  listPaths,
  listPlaces,
  readCampusMap,
  rewriteCampusMap,
} from './database/campusMapRepository.js';
import {
  ApiError,
  asyncRoute,
  readBaseUrl,
  readFilter,
  readPagination,
  sendError,
  toPage,
  writeCookie,
} from './http.js';
import { createContributionRoutes } from './contributionRoutes.js';
import { createAdministrationRoutes } from './administrationRoutes.js';
import { createReviewRoutes } from './reviewRoutes.js';
import { sendQrCode } from './qrCode.js';
import { addCanonicalLink } from './homePage.js';
import { createEntity, deleteEntity, updateEntity } from './mapEditing.js';
import { cleanPlace, cleanPath, ValidationError } from '../shared/validate.js';
import { PLACE_CATEGORIES } from '../shared/search.js';
import { PATH_TYPES } from '../shared/graph.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Le plan est servi par le site (public/basemap) ; seule l'imagerie satellite des modes d'édition vient d'Esri.
const SATELLITE_HOSTS = ['https://server.arcgisonline.com'];
const MIN_ADMIN_TOKEN_LENGTH = 18;
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

function setSecurityHeaders(_request, response, next) {
  response.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `img-src 'self' data: blob: ${SATELLITE_HOSTS.join(' ')}`,
      `connect-src 'self' ${SATELLITE_HOSTS.join(' ')}`,
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    // Vers un autre domaine (imagerie satellite), seule l'origine du site part, jamais le chemin ni les paramètres.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}

// X-Request-ID : repris du client s'il est bien formé, sinon généré, et renvoyé dans la réponse.
function assignRequestId(request, response, next) {
  const incomingId = request.get('x-request-id');
  request.requestId = incomingId && /^[A-Za-z0-9-]{8,64}$/.test(incomingId) ? incomingId : randomUUID();
  response.set('X-Request-ID', request.requestId);
  next();
}

function buildGeoJson(campusMap) {
  const features = [
    ...campusMap.paths.map(({ coordinates, ...properties }) => ({
      type: 'Feature',
      properties: { kind: 'path', ...properties },
      geometry: { type: 'LineString', coordinates },
    })),
    ...campusMap.places.map(({ longitude, latitude, entrances, ...properties }) => ({
      type: 'Feature',
      properties: { kind: 'place', ...properties },
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
    })),
    ...campusMap.places.flatMap((place) =>
      place.entrances.map((entrance, index) => ({
        type: 'Feature',
        properties: {
          kind: 'entrance',
          placeId: place.id,
          placeName: place.name,
          position: index + 1,
          note: entrance.note,
        },
        geometry: { type: 'Point', coordinates: [entrance.longitude, entrance.latitude] },
      })),
    ),
  ];
  return { type: 'FeatureCollection', features };
}

// Identifiants courts (8 caractères aléatoires) : si la clé primaire refuse un doublon, on réessaie une fois.
async function insertWithFreshId(database, prefix, insert) {
  const tryInsert = async () => {
    const id = generateId(prefix);
    await withTransaction(database, (connection) => insert(connection, id));
    return id;
  };
  try {
    return await tryInsert();
  } catch (error) {
    if (error.code !== DUPLICATE_ENTRY) throw error;
    return tryInsert();
  }
}

export function createApp({
  database,
  adminToken,
  publicUrl = '',
  trustProxy = 'loopback',
  getNow = () => new Date(),
}) {
  if (!database) throw new Error('database requis');
  if (!adminToken || adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`ADMIN_TOKEN trop court (${MIN_ADMIN_TOKEN_LENGTH} caractères minimum)`);
  }
  const staffAccess = createStaffAccess({ database, adminToken, getNow });
  const { requireStaff, requireAdministrator } = staffAccess;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(setSecurityHeaders);
  app.use(assignRequestId);
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();

  api.get('/health', (_request, response) => response.json({ data: { status: 'ok' } }));

  // ---------- Session du mode collecte ----------

  api.post(
    '/admin/session',
    asyncRoute(async (request, response) => {
      const now = getNow();
      const clientDigest = staffAccess.getClientDigest(request);
      // L'essai est compté avant la comparaison : des requêtes parallèles ne peuvent pas dépasser la limite.
      if (!(await reserveLoginAttempt(database, clientDigest, now))) {
        logSecurityEvent('admin_login_blocked', { requestId: request.requestId }, 'warn');
        return sendError(response, 429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives, réessayez dans 15 minutes');
      }
      const identity = await staffAccess.identifyToken(request.body?.token);
      if (!identity) {
        logSecurityEvent('admin_login_failed', { requestId: request.requestId }, 'warn');
        return sendError(response, 401, 'INVALID_TOKEN', "Jeton d'accès incorrect");
      }
      // Seule une connexion administrateur remet le compteur à zéro : il protège aussi ADMIN_TOKEN.
      if (identity.actor.kind === 'admin') await clearFailedAttempts(database, clientDigest);
      const { sessionId, expiresAt } = await createAdminSession(
        database,
        identity.tokenFingerprint,
        now,
        identity.actor,
      );
      writeCookie(request, response, SESSION_COOKIE_NAME, sessionId, SESSION_DURATION_MS);
      logSecurityEvent('admin_login_succeeded', { requestId: request.requestId, role: identity.actor.kind });
      response.status(201).json({ data: toSessionView({ expiresAt, ...identity }) });
    }),
  );

  api.get(
    '/admin/session',
    asyncRoute(async (request, response) => {
      const session = await staffAccess.findSession(request);
      if (!session) return sendError(response, 401, 'UNAUTHORIZED', 'Aucune session active');
      response.json({ data: toSessionView(session) });
    }),
  );

  api.delete(
    '/admin/session',
    asyncRoute(async (request, response) => {
      await deleteAdminSession(database, readCookie(request, SESSION_COOKIE_NAME));
      writeCookie(request, response, SESSION_COOKIE_NAME, '', 0);
      logSecurityEvent('admin_logout', { requestId: request.requestId });
      response.status(204).end();
    }),
  );

  // ---------- Carte complète (utilisée par l'appli, qui calcule les itinéraires sur le téléphone) ----------

  api.get(
    '/campus-map',
    asyncRoute(async (request, response) => {
      const format = request.query.format ?? 'json';
      if (format !== 'json' && format !== 'geojson') {
        return sendError(response, 400, 'INVALID_FORMAT', 'format accepte json ou geojson');
      }
      const campusMap = await readCampusMap(database);
      if (format === 'geojson') {
        response.set('Content-Disposition', 'attachment; filename="campus-uac.geojson"');
        return response.type('application/geo+json').send(JSON.stringify(buildGeoJson(campusMap)));
      }
      response.set('Cache-Control', 'no-cache');
      response.json({ data: campusMap });
    }),
  );

  api.delete(
    '/campus-map',
    requireAdministrator,
    asyncRoute(async (request, response) => {
      if (request.query.confirm !== 'true') {
        throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Ajoutez ?confirm=true pour vider la carte');
      }
      await rewriteCampusMap(
        database,
        (campusMap) => ({ ...campusMap, places: [], paths: [], settings: { ...campusMap.settings, isDemo: false } }),
        getNow(),
        request.actor,
      );
      logSecurityEvent('campus_map_cleared', { requestId: request.requestId });
      response.status(204).end();
    }),
  );

  // ---------- Lieux ----------

  api.get(
    '/places',
    asyncRoute(async (request, response) => {
      const pagination = readPagination(request.query);
      const category = readFilter(request.query.category, PLACE_CATEGORIES, 'INVALID_CATEGORY', 'Catégorie inconnue');
      const search = String(request.query.search ?? '');
      response.json(toPage(await listPlaces(database, { ...pagination, category, search }), pagination));
    }),
  );

  api.get(
    '/places/:placeId',
    asyncRoute(async (request, response) => {
      const place = await findPlace(database, request.params.placeId);
      if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      response.json({ data: place });
    }),
  );

  api.post(
    '/places',
    requireStaff,
    asyncRoute(async (request, response) => {
      const fields = cleanPlace(request.body);
      const id = await insertWithFreshId(database, 'place', (connection, candidateId) =>
        createEntity(connection, 'place', { id: candidateId, ...fields }, { actor: request.actor }, getNow()),
      );
      logSecurityEvent('place_created', { requestId: request.requestId, resourceId: id });
      response.status(201).json({ data: { id, ...fields } });
    }),
  );

  api.put(
    '/places/:placeId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const replacement = cleanPlace(request.body);
      const place = await withTransaction(database, (connection) =>
        updateEntity(
          connection,
          'place',
          request.params.placeId,
          () => replacement,
          { actor: request.actor },
          getNow(),
        ),
      );
      if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      logSecurityEvent('place_updated', { requestId: request.requestId, resourceId: place.id });
      response.json({ data: place });
    }),
  );

  api.delete(
    '/places/:placeId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const isRemoved = await withTransaction(database, (connection) =>
        deleteEntity(connection, 'place', request.params.placeId, { actor: request.actor }, getNow()),
      );
      if (!isRemoved) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      logSecurityEvent('place_deleted', { requestId: request.requestId, resourceId: request.params.placeId });
      response.status(204).end();
    }),
  );

  // QR code « Vous êtes ici » : ouvre l'appli avec ce lieu comme point de départ.
  api.get(
    '/places/:placeId/qr-code',
    asyncRoute(async (request, response) => {
      const place = await findPlace(database, request.params.placeId);
      if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      const targetUrl = `${readBaseUrl(request, publicUrl)}/?ici=${encodeURIComponent(place.id)}`;
      await sendQrCode(response, targetUrl);
    }),
  );

  // ---------- Chemins ----------

  api.get(
    '/paths',
    asyncRoute(async (request, response) => {
      const pagination = readPagination({ 'sort-by': 'id', ...request.query });
      const type = readFilter(request.query.type, PATH_TYPES, 'INVALID_PATH_TYPE', 'Type de chemin inconnu');
      response.json(toPage(await listPaths(database, { ...pagination, type }), pagination));
    }),
  );

  api.get(
    '/paths/:pathId',
    asyncRoute(async (request, response) => {
      const path = await findPath(database, request.params.pathId);
      if (!path) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      response.json({ data: path });
    }),
  );

  api.post(
    '/paths',
    requireStaff,
    asyncRoute(async (request, response) => {
      const fields = cleanPath(request.body);
      const id = await insertWithFreshId(database, 'path', (connection, candidateId) =>
        createEntity(connection, 'path', { id: candidateId, ...fields }, { actor: request.actor }, getNow()),
      );
      logSecurityEvent('path_created', { requestId: request.requestId, resourceId: id });
      response.status(201).json({ data: { id, ...fields } });
    }),
  );

  // Mise à jour partielle : type, nom, caractère inondable. Le tracé ne change pas. La lecture verrouillée
  // d'updateEntity fait passer l'une après l'autre deux modifications partielles simultanées.
  api.patch(
    '/paths/:pathId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const body = request.body || {};
      const buildNext = (existing) =>
        cleanPath({
          type: body.type ?? existing.type,
          name: body.name ?? existing.name,
          isFloodProne: body.isFloodProne ?? existing.isFloodProne,
          coordinates: existing.coordinates,
        });
      const path = await withTransaction(database, (connection) =>
        updateEntity(connection, 'path', request.params.pathId, buildNext, { actor: request.actor }, getNow()),
      );
      if (!path) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      logSecurityEvent('path_updated', { requestId: request.requestId, resourceId: path.id });
      response.json({ data: path });
    }),
  );

  api.delete(
    '/paths/:pathId',
    requireStaff,
    asyncRoute(async (request, response) => {
      const isRemoved = await withTransaction(database, (connection) =>
        deleteEntity(connection, 'path', request.params.pathId, { actor: request.actor }, getNow()),
      );
      if (!isRemoved) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      logSecurityEvent('path_deleted', { requestId: request.requestId, resourceId: request.params.pathId });
      response.status(204).end();
    }),
  );

  // ---------- Contribution ouverte ----------

  api.use(createContributionRoutes({ database, publicUrl, getNow, getClientDigest: staffAccess.getClientDigest }));
  api.use(createReviewRoutes({ database, getNow, requireStaff }));
  api.use(createAdministrationRoutes({ database, publicUrl, getNow, requireAdministrator }));

  api.use((_request, response) => sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route inconnue'));

  app.use('/api/v1', api);
  app.use('/api', (_request, response) => sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route inconnue'));
  app.use('/shared', express.static(join(PROJECT_ROOT, 'shared')));
  app.use('/vendor/maplibre', express.static(join(PROJECT_ROOT, 'node_modules/maplibre-gl/dist'), { maxAge: '7d' }));
  app.use('/vendor/pmtiles', express.static(join(PROJECT_ROOT, 'node_modules/pmtiles/dist'), { maxAge: '7d' }));
  app.use(
    '/vendor/protomaps-basemaps',
    express.static(join(PROJECT_ROOT, 'node_modules/@protomaps/basemaps/dist/esm'), { maxAge: '7d' }),
  );
  // L'accueil n'est pas servi tel quel : il reçoit son adresse canonique, tirée de PUBLIC_URL.
  app.get(
    ['/', '/index.html'],
    asyncRoute(async (_request, response) => {
      const homePage = await readFile(join(PROJECT_ROOT, 'public/index.html'), 'utf8');
      response.set('Cache-Control', 'public, max-age=0').type('html').send(addCanonicalLink(homePage, publicUrl));
    }),
  );
  app.use(express.static(join(PROJECT_ROOT, 'public')));

  // Réponses d'erreur génériques : jamais de trace d'exécution envoyée au client.
  app.use((error, request, response, _next) => {
    if (error instanceof ValidationError) return sendError(response, 400, 'VALIDATION_ERROR', error.message);
    if (error instanceof ApiError) return sendError(response, error.status, error.code, error.message);
    if (error.type === 'entity.parse.failed') return sendError(response, 400, 'INVALID_JSON', 'JSON invalide');
    if (error.type === 'entity.too.large')
      return sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'Requête trop volumineuse');
    logError('server_error', error, { requestId: request.requestId });
    sendError(response, 500, 'INTERNAL_ERROR', 'Erreur interne');
  });

  return app;
}
