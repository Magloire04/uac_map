/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PLACE_CATEGORIES } from '/shared/search.js';
import { html } from '/safeHtml.js';
import { callApi } from '/apiClient.js';

const qrGrid = document.getElementById('qr-grid');
const nameFilter = document.getElementById('name-filter');
const categoryFilter = document.getElementById('category-filter');

categoryFilter.insertAdjacentHTML(
  'beforeend',
  html`${Object.entries(PLACE_CATEGORIES).map(([code, label]) => html`<option value="${code}">${label}</option>`)}`,
);

const { data: campusMap } = await callApi('GET', '/campus-map');
const places = campusMap.places.slice().sort((first, second) => first.name.localeCompare(second.name, 'fr'));

// Le lien public de contribution, s'il existe, a son affiche en tête de page.
const publicLink = await callApi('GET', '/contribution/public-link')
  .then(({ data }) => data)
  .catch(() => null);

const contributionCard = publicLink
  ? html`<article class="qr-card is-contribution">
      <div class="qr-card-title">CONTRIBUEZ À LA CARTE</div>
      <div class="qr-card-name">Ajoutez un lieu, un chemin, signalez une erreur</div>
      <img src="/api/v1/contribution/public-link/qr-code" alt="QR code du lien de contribution" />
      <div class="qr-card-help">Scannez sur le campus : chaque proposition est relue avant publication</div>
    </article>`
  : '';

function renderQrCards() {
  const nameQuery = nameFilter.value.trim().toLowerCase();
  const visiblePlaces = places.filter(
    (place) =>
      (!categoryFilter.value || place.category === categoryFilter.value) &&
      (!nameQuery || place.name.toLowerCase().includes(nameQuery)),
  );
  const qrCards = visiblePlaces.length
    ? html`${visiblePlaces.map(
        (place) =>
          html`<article class="qr-card">
            <div class="qr-card-title">VOUS ÊTES ICI</div>
            <div class="qr-card-name">${place.name}</div>
            <img
              src="/api/v1/places/${encodeURIComponent(place.id)}/qr-code"
              alt="QR code du lieu ${place.name}"
              loading="lazy"
            />
            <div class="qr-card-help">Scannez pour être guidé vers n'importe quel lieu du campus</div>
          </article>`,
      )}`
    : html`<p>Aucun lieu.</p>`;
  qrGrid.innerHTML = html`${contributionCard}${qrCards}`;
}

nameFilter.addEventListener('input', renderQrCards);
categoryFilter.addEventListener('change', renderQrCards);
document.getElementById('print-button').addEventListener('click', () => window.print());
renderQrCards();

if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  const warning = document.createElement('p');
  warning.className = 'warning';
  warning.textContent =
    "Attention : ces QR codes pointent vers « localhost » et ne marcheront pas sur un autre téléphone. Démarrez le serveur avec PUBLIC_URL=https://votre-adresse avant d'imprimer.";
  document.getElementById('page-header').append(warning);
}
