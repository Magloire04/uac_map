/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Construction de HTML sûr (protection XSS, OWASP A03).
// Le gabarit html`...` échappe toute valeur interpolée, sauf les fragments déjà produits par html`...`.
// La règle ESLint no-unsanitized refuse toute insertion HTML qui ne passe pas par ce gabarit.

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

class SafeHtml {
  constructor(markup) {
    this.markup = markup;
  }

  toString() {
    return this.markup;
  }
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
}

function renderValue(value) {
  if (value instanceof SafeHtml) return value.markup;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let markup = strings[0];
  values.forEach((value, index) => {
    markup += renderValue(value) + strings[index + 1];
  });
  return new SafeHtml(markup);
}
