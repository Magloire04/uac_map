/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Accès à l'API v1. Les réponses suivent l'enveloppe { data, meta } en cas de succès
// et { error: { code, message, status } } en cas d'échec.

export const API_BASE_URL = '/api/v1';

export class ApiRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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
    });
  } catch {
    // Réseau coupé ou serveur injoignable : même forme d'erreur qu'un refus de l'API, avec un message clair.
    throw new ApiRequestError(0, 'NETWORK_ERROR', 'Connexion impossible : vérifiez le réseau et réessayez.');
  }
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
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
