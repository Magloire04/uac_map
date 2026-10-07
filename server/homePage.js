/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

const escapeAttribute = (value) => value.replace(/[&<>"]/g, (character) => HTML_ENTITIES[character]);

// Ajoute à l'accueil la balise qui désigne son adresse propre. Sans elle, un moteur de recherche indexe l'adresse
// par laquelle il est arrivé, paramètres compris (« /?ici=… », « /?ref=… »). Sans adresse publique configurée,
// cas d'un poste local, la page est renvoyée telle quelle.
export function addCanonicalLink(page, publicUrl) {
  if (!publicUrl) return page;
  const headEnd = page.indexOf('</head>');
  if (headEnd === -1) return page;
  const canonicalUrl = `${publicUrl.replace(/\/+$/, '')}/`;
  const canonicalLink = `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}" />`;
  return `${page.slice(0, headEnd)}  ${canonicalLink}\n  ${page.slice(headEnd)}`;
}
