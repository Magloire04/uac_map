/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Outils communs aux routeurs de l'API : erreurs normalisées, pagination, filtres, cookies.

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_IDENTIFIER_LENGTH = 64;

// Erreur métier transportée jusqu'au gestionnaire d'erreurs, qui produit l'enveloppe standard.
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const sendError = (response, status, code, message) =>
  response.status(status).json({ error: { code, message, status } });

export const asyncRoute = (handler) => (request, response, next) =>
  Promise.resolve(handler(request, response, next)).catch(next);

export function readPage(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const limit = Number.parseInt(query.limit ?? String(DEFAULT_PAGE_LIMIT), 10);
  if (!Number.isInteger(page) || page < 1)
    throw new ApiError(400, 'INVALID_PAGE', 'Le paramètre page doit être un entier ≥ 1');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ApiError(400, 'INVALID_LIMIT', `Le paramètre limit doit être compris entre 1 et ${MAX_PAGE_LIMIT}`);
  }
  return { page, limit };
}

export function readOrder(query) {
  const order = query.order ?? 'asc';
  if (!['asc', 'desc'].includes(order)) throw new ApiError(400, 'INVALID_ORDER', 'order accepte asc ou desc');
  return order;
}

export function readPagination(query) {
  const page = readPage(query);
  const sortBy = query['sort-by'] ?? 'name';
  if (!['id', 'name'].includes(sortBy)) throw new ApiError(400, 'INVALID_SORT', 'sort-by accepte id ou name');
  return { ...page, sortBy, order: readOrder(query) };
}

// Filtre facultatif à valeur unique : absent ou vide, il est ignoré ; répété (?type=a&type=b), il est refusé.
// allowedValues : liste des valeurs admises, ou objet dont les clés sont les valeurs admises.
export function readFilter(value, allowedValues, errorCode, message) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new ApiError(400, errorCode, message);
  const isAllowed = Array.isArray(allowedValues) ? allowedValues.includes(value) : Object.hasOwn(allowedValues, value);
  if (!isAllowed) throw new ApiError(400, errorCode, message);
  return value;
}

// Identifiant passé en filtre (?contributor-id=…) : facultatif, une seule valeur, 64 caractères au plus.
export function readIdentifierFilter(value, errorCode, message) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_IDENTIFIER_LENGTH) throw new ApiError(400, errorCode, message);
  return value;
}

export const toPage = ({ items, total }, { page, limit }) => ({ data: items, meta: { page, limit, total } });

// Adresse publique de l'appli : PUBLIC_URL si elle est définie, sinon celle de la requête.
export const readBaseUrl = (request, publicUrl) =>
  (publicUrl || `${request.protocol}://${request.get('host')}`).replace(/\/$/, '');

// Cookie httpOnly limité à l'API, SameSite=Strict, Secure dès que la requête arrive en HTTPS.
export function writeCookie(request, response, name, value, maxAgeMs) {
  const attributes = [
    `${name}=${value}`,
    'Path=/api',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (request.secure) attributes.push('Secure');
  response.append('Set-Cookie', attributes.join('; '));
}
