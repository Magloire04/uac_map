/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Auteurs des modifications : administrateur, relecteur, contributeur ou commande de maintenance.

export const ADMIN_ACTOR = Object.freeze({ kind: 'admin', id: null });
export const COMMAND_ACTOR = Object.freeze({ kind: 'command', id: null });
export const reviewerActor = (reviewerId) => ({ kind: 'reviewer', id: reviewerId });
export const contributorActor = (contributorId) => ({ kind: 'contributor', id: contributorId });
