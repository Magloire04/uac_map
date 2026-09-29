/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createProjector } from '../shared/geo.js';

export const CAMPUS_CENTER = [2.341985, 6.416091];
const projector = createProjector(CAMPUS_CENTER[1]);
const planeCenter = projector.toPlane(CAMPUS_CENTER);

// Position à partir d'un décalage en mètres vers l'est et le nord du centre du campus.
export const offsetPosition = (eastMeters, northMeters) =>
  projector.toLonLat([planeCenter[0] + eastMeters, planeCenter[1] + northMeters]);

export const createTestPath = (id, type, offsets, extra = {}) => ({
  id,
  type,
  coordinates: offsets.map(([eastMeters, northMeters]) => offsetPosition(eastMeters, northMeters)),
  ...extra,
});
