/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Fichier de démarrage pour les hébergements qui chargent l'application avec require() (CommonJS) :
// il charge le serveur, écrit en modules ES. En local, « npm start » lance directement server/index.js.
import('./server/index.js').catch((error) => {
  console.error(error);
  process.exit(1);
});
