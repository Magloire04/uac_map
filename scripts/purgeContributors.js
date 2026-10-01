/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Supprime les contributeurs inactifs depuis 12 mois (conservation des données personnelles), avec les mêmes
// effets que « Oublier ce téléphone ». Lancée chaque mois par cron : npm run purge-contributors

import { CONTRIBUTOR_RETENTION_MONTHS, purgeInactiveContributors } from '../server/database/contributorRepository.js';
import { runWithDatabase } from './runWithDatabase.js';

await runWithDatabase(async (database) => {
  const now = new Date();
  const inactiveSince = new Date(now);
  inactiveSince.setUTCMonth(inactiveSince.getUTCMonth() - CONTRIBUTOR_RETENTION_MONTHS);
  const deletedCount = await purgeInactiveContributors(database, inactiveSince, now);
  console.log(`${deletedCount} contributeur(s) inactif(s) depuis ${CONTRIBUTOR_RETENTION_MONTHS} mois supprimé(s).`);
});
