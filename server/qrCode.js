/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// QR codes servis en SVG : « Vous êtes ici » d'un lieu, lien de contribution public.

import QRCode from 'qrcode';

export async function sendQrCode(response, targetUrl) {
  const svg = await QRCode.toString(targetUrl, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  response.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
}
