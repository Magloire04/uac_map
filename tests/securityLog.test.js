/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logSecurityEvent } from '../server/securityLog.js';

function captureStandardOutput(action) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    action();
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output);
}

test('retire jeton, IP et e-mail des événements journalisés', () => {
  const entry = captureStandardOutput(() =>
    logSecurityEvent('admin_login_failed', { requestId: 'abc', token: 's3cret', ip: '10.0.0.1', email: 'a@b.bj' }),
  );
  assert.deepEqual(Object.keys(entry).sort(), ['event', 'level', 'requestId', 'time']);
});
