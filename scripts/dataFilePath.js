/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_FILE = resolve(process.env.DATA_FILE || join(PROJECT_ROOT, 'data', 'campus.json'));
