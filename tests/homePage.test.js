/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createDatabasePool } from '../server/database/connection.js';
import { addCanonicalLink } from '../server/homePage.js';

const PAGE = `<!doctype html>
<html lang="fr">
  <head>
    <title>Carte UAC</title>
  </head>
  <body></body>
</html>`;

const CANONICAL_LINK = '<link rel="canonical" href="https://carte.exemple/" />';

test("ajoute l'adresse canonique à la fin de l'en-tête", () => {
  const page = addCanonicalLink(PAGE, 'https://carte.exemple');
  assert.ok(page.includes(CANONICAL_LINK));
  assert.ok(page.indexOf('rel="canonical"') < page.indexOf('</head>'));
  assert.equal(page.match(/rel="canonical"/g).length, 1);
});

test("ne double pas la barre finale de l'adresse publique", () => {
  assert.ok(addCanonicalLink(PAGE, 'https://carte.exemple/').includes(CANONICAL_LINK));
});

test('renvoie la page telle quelle sans adresse publique ou sans en-tête', () => {
  assert.equal(addCanonicalLink(PAGE, ''), PAGE);
  assert.equal(addCanonicalLink('<p>Sans en-tête</p>', 'https://carte.exemple'), '<p>Sans en-tête</p>');
});

test("échappe l'adresse publique avant de l'écrire dans la page", () => {
  const page = addCanonicalLink(PAGE, 'https://carte.exemple/"><script>');
  assert.ok(!page.includes('<script>'));
  assert.ok(page.includes('href="https://carte.exemple/&quot;&gt;&lt;script&gt;/"'));
});

// La base n'est jamais sollicitée : l'accueil est une page statique.
async function withServer(publicUrl, run) {
  const unreachable = createDatabasePool({
    host: '127.0.0.1',
    port: 1,
    database: 'uac_map_test',
    user: 'personne',
    password: 'sans-objet',
  });
  const server = createApp({ database: unreachable, adminToken: 'jeton-de-test-1234', publicUrl }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await unreachable.end();
  }
}

test("sert l'accueil avec son adresse canonique, quels que soient les paramètres", async () => {
  await withServer('https://carte.exemple', async (baseUrl) => {
    for (const path of ['/', '/?ici=amphi-a', '/?ref=ailleurs', '/index.html']) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /^text\/html/, path);
      const page = await response.text();
      assert.ok(page.includes(CANONICAL_LINK), path);
      assert.ok(page.includes('<title>Carte UAC</title>'), path);
    }
  });
});

test("sert l'accueil sans adresse canonique quand l'adresse publique est vide", async () => {
  await withServer('', async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('rel="canonical"'));
  });
});

test('sert toujours les autres fichiers publics', async () => {
  await withServer('https://carte.exemple', async (baseUrl) => {
    const stylesheet = await fetch(`${baseUrl}/style.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    const qrPage = await (await fetch(`${baseUrl}/qr.html`)).text();
    assert.ok(!qrPage.includes('rel="canonical"'));
  });
});
