/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callApi } from '../public/apiClient.js';

const NETWORK_ERROR = {
  status: 0,
  code: 'NETWORK_ERROR',
  message: 'Connexion impossible : vérifiez le réseau et réessayez.',
};
const timeoutReason = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

// Délai de la requête piloté par le test : AbortSignal.timeout renvoie un signal que le test déclenche lui-même.
function controlTimeout(testContext) {
  const controller = new AbortController();
  const timeout = testContext.mock.method(AbortSignal, 'timeout', () => controller.signal);
  return { controller, timeout };
}

test('une requête sans réponse dans le délai devient une erreur réseau', async (testContext) => {
  const { controller, timeout } = controlTimeout(testContext);
  let fetchOptions;
  testContext.mock.method(globalThis, 'fetch', (url, options) => {
    fetchOptions = options;
    if (!options.signal) return Promise.reject(new Error('requête sans délai'));
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    });
  });
  const request = callApi('GET', '/campus-map');
  controller.abort(timeoutReason());
  await assert.rejects(request, NETWORK_ERROR);
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(timeout.mock.calls[0].arguments[0], 30000);
  assert.equal(fetchOptions.signal, controller.signal);
});

test("une réponse dont le corps n'arrive pas dans le délai devient une erreur réseau", async (testContext) => {
  const { controller } = controlTimeout(testContext);
  testContext.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = new ReadableStream({
      start(stream) {
        if (options.signal) options.signal.addEventListener('abort', () => stream.error(options.signal.reason));
        else stream.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const request = callApi('GET', '/campus-map');
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(timeoutReason());
  await assert.rejects(request, NETWORK_ERROR);
});

test('une erreur sans corps JSON garde son code HTTP', async (testContext) => {
  controlTimeout(testContext);
  testContext.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
  await assert.rejects(callApi('GET', '/campus-map'), { status: 502, code: 'UNKNOWN_ERROR', message: 'Erreur 502' });
});
