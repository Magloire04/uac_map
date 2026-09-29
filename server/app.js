/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import express from 'express';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { logSecurityEvent, logError } from './securityLog.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS,
  createClientDigest,
  createTokenDigest,
  createTokenFingerprint,
  isSameSecret,
  readCookie,
} from './adminSessions.js';
import { withTransaction } from './database/connection.js';
import {
  createAdminSession,
  deleteAdminSession,
  findAdminSessionExpiration,
} from './database/adminSessionRepository.js';
import { clearFailedAttempts, isClientBlocked, recordFailedAttempt } from './database/failedLoginAttemptRepository.js';
import {
  deletePath,
  deletePlace,
  findPath,
  findPlace,
  generateId,
  insertPath,
  insertPlace,
  listPaths,
  listPlaces,
  readCampusMap,
  replacePlace,
  rewriteCampusMap,
  updatePathAttributes,
} from './database/campusMapRepository.js';
import { cleanPlace, cleanPath, ValidationError } from '../shared/validate.js';
import { PLACE_CATEGORIES } from '../shared/search.js';
import { PATH_TYPES } from '../shared/graph.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TILE_HOSTS = ['https://tile.openstreetmap.org', 'https://server.arcgisonline.com'];
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MIN_ADMIN_TOKEN_LENGTH = 18;
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

// Erreur métier transportée jusqu'au gestionnaire d'erreurs, qui produit l'enveloppe standard.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sendError = (response, status, code, message) =>
  response.status(status).json({ error: { code, message, status } });

function setSecurityHeaders(_request, response, next) {
  response.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `img-src 'self' data: blob: ${TILE_HOSTS.join(' ')}`,
      `connect-src 'self' ${TILE_HOSTS.join(' ')}`,
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
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

function readPagination(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const limit = Number.parseInt(query.limit ?? String(DEFAULT_PAGE_LIMIT), 10);
  if (!Number.isInteger(page) || page < 1)
    throw new ApiError(400, 'INVALID_PAGE', 'Le paramètre page doit être un entier ≥ 1');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ApiError(400, 'INVALID_LIMIT', `Le paramètre limit doit être compris entre 1 et ${MAX_PAGE_LIMIT}`);
  }
  const sortBy = query['sort-by'] ?? 'name';
  if (!['id', 'name'].includes(sortBy)) throw new ApiError(400, 'INVALID_SORT', 'sort-by accepte id ou name');
  const order = query.order ?? 'asc';
  if (!['asc', 'desc'].includes(order)) throw new ApiError(400, 'INVALID_ORDER', 'order accepte asc ou desc');
  return { page, limit, sortBy, order };
}

// Filtre facultatif à valeur unique : absent ou vide, il est ignoré ; répété (?type=a&type=b), il est refusé.
function readFilter(value, allowedValues, errorCode, message) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !Object.hasOwn(allowedValues, value)) throw new ApiError(400, errorCode, message);
  return value;
}

const toPage = ({ items, total }, { page, limit }) => ({ data: items, meta: { page, limit, total } });

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
  const tokenDigest = createTokenDigest(adminToken);
  const tokenFingerprint = createTokenFingerprint(adminToken);
  const getClientDigest = (request) => createClientDigest(request.ip, adminToken);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use(setSecurityHeaders);
  app.use(assignRequestId);
  app.use(express.json({ limit: '1mb' }));

  const writeSessionCookie = (request, response, sessionId, maxAgeMs) => {
    const attributes = [
      `${SESSION_COOKIE_NAME}=${sessionId}`,
      'Path=/api',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (request.secure) attributes.push('Secure');
    response.append('Set-Cookie', attributes.join('; '));
  };

  const asyncRoute = (handler) => (request, response, next) =>
    Promise.resolve(handler(request, response, next)).catch(next);

  // Accès au mode collecte : cookie de session (appli web) ou en-tête Bearer avec le jeton (scripts).
  const requireAdmin = asyncRoute(async (request, response, next) => {
    const now = getNow();
    const sessionId = readCookie(request, SESSION_COOKIE_NAME);
    if (await findAdminSessionExpiration(database, sessionId, tokenFingerprint, now)) return next();
    const header = request.get('authorization') || '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (bearerToken) {
      const clientDigest = getClientDigest(request);
      if (!(await isClientBlocked(database, clientDigest, now)) && isSameSecret(bearerToken, tokenDigest)) {
        await clearFailedAttempts(database, clientDigest);
        return next();
      }
      await recordFailedAttempt(database, clientDigest, now);
    }
    logSecurityEvent(
      'admin_access_denied',
      { requestId: request.requestId, method: request.method, path: request.path },
      'warn',
    );
    sendError(response, 401, 'UNAUTHORIZED', 'Session du mode collecte absente ou expirée');
  });

  const api = express.Router();

  api.get('/health', (_request, response) => response.json({ data: { status: 'ok' } }));

  // ---------- Session du mode collecte ----------

  api.post(
    '/admin/session',
    asyncRoute(async (request, response) => {
      const now = getNow();
      const clientDigest = getClientDigest(request);
      if (await isClientBlocked(database, clientDigest, now)) {
        logSecurityEvent('admin_login_blocked', { requestId: request.requestId }, 'warn');
        return sendError(response, 429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives, réessayez dans 15 minutes');
      }
      if (!isSameSecret(request.body?.token, tokenDigest)) {
        await recordFailedAttempt(database, clientDigest, now);
        logSecurityEvent('admin_login_failed', { requestId: request.requestId }, 'warn');
        return sendError(response, 401, 'INVALID_TOKEN', "Jeton d'accès incorrect");
      }
      await clearFailedAttempts(database, clientDigest);
      const { sessionId, expiresAt } = await createAdminSession(database, tokenFingerprint, now);
      writeSessionCookie(request, response, sessionId, SESSION_DURATION_MS);
      logSecurityEvent('admin_login_succeeded', { requestId: request.requestId });
      response.status(201).json({ data: { expiresAt: expiresAt.toISOString() } });
    }),
  );

  api.get(
    '/admin/session',
    asyncRoute(async (request, response) => {
      const sessionId = readCookie(request, SESSION_COOKIE_NAME);
      const expiresAt = await findAdminSessionExpiration(database, sessionId, tokenFingerprint, getNow());
      if (!expiresAt) return sendError(response, 401, 'UNAUTHORIZED', 'Aucune session active');
      response.json({ data: { expiresAt: expiresAt.toISOString() } });
    }),
  );

  api.delete(
    '/admin/session',
    asyncRoute(async (request, response) => {
      await deleteAdminSession(database, readCookie(request, SESSION_COOKIE_NAME));
      writeSessionCookie(request, response, '', 0);
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
    requireAdmin,
    asyncRoute(async (request, response) => {
      if (request.query.confirm !== 'true') {
        throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Ajoutez ?confirm=true pour vider la carte');
      }
      await rewriteCampusMap(
        database,
        (campusMap) => ({ ...campusMap, places: [], paths: [], settings: { ...campusMap.settings, isDemo: false } }),
        getNow(),
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
    requireAdmin,
    asyncRoute(async (request, response) => {
      const fields = cleanPlace(request.body);
      const id = await insertWithFreshId(database, 'place', (connection, candidateId) =>
        insertPlace(connection, { id: candidateId, ...fields }, getNow()),
      );
      logSecurityEvent('place_created', { requestId: request.requestId, resourceId: id });
      response.status(201).json({ data: { id, ...fields } });
    }),
  );

  api.put(
    '/places/:placeId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const replacement = cleanPlace(request.body);
      const place = await withTransaction(database, (connection) =>
        replacePlace(connection, request.params.placeId, replacement, getNow()),
      );
      if (!place) throw new ApiError(404, 'PLACE_NOT_FOUND', 'Lieu inexistant');
      logSecurityEvent('place_updated', { requestId: request.requestId, resourceId: place.id });
      response.json({ data: place });
    }),
  );

  api.delete(
    '/places/:placeId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const isRemoved = await withTransaction(database, (connection) =>
        deletePlace(connection, request.params.placeId, getNow()),
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
      const baseUrl = (publicUrl || `${request.protocol}://${request.get('host')}`).replace(/\/$/, '');
      const targetUrl = `${baseUrl}/?ici=${encodeURIComponent(place.id)}`;
      const svg = await QRCode.toString(targetUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      response.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
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
    requireAdmin,
    asyncRoute(async (request, response) => {
      const fields = cleanPath(request.body);
      const id = await insertWithFreshId(database, 'path', (connection, candidateId) =>
        insertPath(connection, { id: candidateId, ...fields }, getNow()),
      );
      logSecurityEvent('path_created', { requestId: request.requestId, resourceId: id });
      response.status(201).json({ data: { id, ...fields } });
    }),
  );

  // Mise à jour partielle : type, nom, caractère inondable. Le tracé ne change pas.
  api.patch(
    '/paths/:pathId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const body = request.body || {};
      const path = await withTransaction(database, async (connection) => {
        const existing = await findPath(connection, request.params.pathId);
        if (!existing) return null;
        const { type, name, isFloodProne } = cleanPath({
          type: body.type ?? existing.type,
          name: body.name ?? existing.name,
          isFloodProne: body.isFloodProne ?? existing.isFloodProne,
          coordinates: existing.coordinates,
        });
        return updatePathAttributes(connection, existing.id, { type, name, isFloodProne }, getNow());
      });
      if (!path) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      logSecurityEvent('path_updated', { requestId: request.requestId, resourceId: path.id });
      response.json({ data: path });
    }),
  );

  api.delete(
    '/paths/:pathId',
    requireAdmin,
    asyncRoute(async (request, response) => {
      const isRemoved = await withTransaction(database, (connection) =>
        deletePath(connection, request.params.pathId, getNow()),
      );
      if (!isRemoved) throw new ApiError(404, 'PATH_NOT_FOUND', 'Chemin inexistant');
      logSecurityEvent('path_deleted', { requestId: request.requestId, resourceId: request.params.pathId });
      response.status(204).end();
    }),
  );

  api.use((_request, response) => sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route inconnue'));

  app.use('/api/v1', api);
  app.use('/api', (_request, response) => sendError(response, 404, 'ROUTE_NOT_FOUND', 'Route inconnue'));
  app.use('/shared', express.static(join(PROJECT_ROOT, 'shared')));
  app.use('/vendor/maplibre', express.static(join(PROJECT_ROOT, 'node_modules/maplibre-gl/dist'), { maxAge: '7d' }));
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
