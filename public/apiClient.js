/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Accès à l'API v1. Les réponses suivent l'enveloppe { data, meta } en cas de succès
// et { error: { code, message, status } } en cas d'échec.

export const API_BASE_URL = '/api/v1';
// Au-delà, la requête est abandonnée : sur le réseau du campus, une réponse qui n'arrive pas ne doit pas bloquer l'écran.
const REQUEST_TIMEOUT_MS = 30 * 1000;

export class ApiRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Réseau coupé, serveur injoignable ou délai dépassé : même forme d'erreur qu'un refus de l'API, avec un message clair.
const createNetworkError = () =>
  new ApiRequestError(0, 'NETWORK_ERROR', 'Connexion impossible : vérifiez le réseau et réessayez.');

export async function callApi(method, path, body) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-cache',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw createNetworkError();
  }
  if (response.status === 204) return null;
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    // Corps qui n'est pas du JSON (page d'erreur du proxy) : seul le code HTTP compte. Toute autre erreur vient du
    // réseau ou du délai, pendant la lecture du corps.
    if (!(error instanceof SyntaxError)) throw createNetworkError();
    payload = null;
  }
  if (!response.ok) {
    const error = payload?.error;
    throw new ApiRequestError(
      response.status,
      error?.code || 'UNKNOWN_ERROR',
      error?.message || `Erreur ${response.status}`,
    );
  }
  return payload;
}
