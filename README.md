# Carte UAC

[![CI](https://github.com/Magloire04/uac_map/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Magloire04/uac_map/actions/workflows/ci.yml)
[![Licence MPL-2.0](https://img.shields.io/badge/licence-MPL--2.0-blue.svg)](LICENSE)

Carte et guidage piéton pour le campus de l'Université d'Abomey-Calavi (UAC). On tape « scolarité », « BU » ou « amphi 1000 », et l'appli trace le chemin à pied jusqu'à la bonne porte, avec des consignes en français et un guidage GPS. Elle fonctionne dans le navigateur du téléphone, sans installation, et continue sans réseau une fois la carte chargée.

> **Statut : prototype.** Le moteur d'itinéraire, l'API et le mode collecte fonctionnent. Les données du campus restent à relever sur le terrain : au premier lancement, un réseau **fictif** sert de démonstration.

| Itinéraire                                                                 | Mode collecte : tracé d'un chemin                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ![Itinéraire vers le restaurant universitaire](docs/images/itineraire.png) | ![Tracé d'un chemin en mode collecte](docs/images/collecte.png) |

## Fonctionnalités

**Pour les visiteurs et les étudiants**

- Recherche qui accepte les sigles, les surnoms, l'absence d'accents et une faute de frappe.
- Itinéraire à pied jusqu'à l'entrée la plus proche du bâtiment, avec options sans escaliers et sans passages inondables.
- Consignes ancrées sur des repères : « Tournez à droite, au niveau de la BU ».
- Guidage GPS avec distance restante, précision affichée et recalcul automatique en cas d'écart.
- Point de départ au choix : GPS, QR code « Vous êtes ici » posé sur le campus, ou point touché sur la carte.
- Lien partageable vers un lieu, fonctionnement hors ligne (appli installable).

**Pour l'équipe qui relève la carte (mode collecte)**

- Tracé des allées sur fond satellite, avec accroche automatique aux chemins existants.
- Enregistrement d'un sentier en marchant (trace GPS filtrée, lissée et raccordée au réseau).
- Fiches de lieux avec alias, description, accès et une ou plusieurs portes d'entrée.
- Impression des QR codes, export GeoJSON, import des données déjà présentes dans OpenStreetMap.

## Démarrage rapide

Prérequis : Node.js 22.9 ou plus récent.

```bash
git clone https://github.com/Magloire04/uac_map.git
cd uac_map
npm install
npm start
```

Ouvrez http://localhost:3000. Le jeton d'accès au mode collecte est écrit dans `data/.admin-token` au premier lancement (il n'apparaît jamais dans les journaux).

Pour personnaliser la configuration, copiez `.env.example` en `.env` : chaque variable y est documentée.

| Commande                 | Rôle                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `npm run dev`            | Serveur relancé à chaque modification                             |
| `npm test`               | Tests unitaires et d'intégration                                  |
| `npm run lint`           | ESLint, règles de sécurité en erreur bloquante                    |
| `npm run format`         | Formatage Prettier                                                |
| `npm run check`          | Lint, formatage et tests, comme la CI                             |
| `npm run reset -- --oui` | Vide la carte avant la vraie collecte                             |
| `npm run demo`           | Recharge le jeu de démonstration                                  |
| `npm run import-osm`     | Importe chemins, bâtiments nommés et entrées depuis OpenStreetMap |

## Tester sur un téléphone

Les navigateurs n'autorisent le GPS que sur une page `https://` ou sur `localhost`.

1. **Même Wi-Fi, certificat auto-signé** : `HTTPS_ENABLED=true npm start`, puis ouvrez sur le téléphone l'adresse `https://192.168.x.x:3443` affichée dans le terminal et acceptez l'avertissement de certificat. Le GPS fonctionne, le mode hors ligne ne s'active pas.
2. **Tunnel HTTPS public**, pour tester à plusieurs sur le campus : `npx cloudflared tunnel --url http://localhost:3000`, puis relancez le serveur avec `PUBLIC_URL=https://….trycloudflare.com` pour que les QR codes pointent vers la bonne adresse.

Depuis un endroit éloigné du campus, l'appli le détecte et propose de toucher la carte pour choisir le point de départ.

## Relever le campus

1. Videz la démonstration (menu > Mode collecte > menu > Vider la carte) ou lancez `npm run import-osm` pour partir de ce qu'OpenStreetMap connaît déjà.
2. **Tracer un chemin** sur le fond satellite. Un point posé près d'un chemin existant s'y accroche : c'est ce qui relie le réseau. Tracez aussi les raccourcis réellement empruntés et marquez escaliers et passages inondables.
3. **Enregistrer en marchant** les sentiers cachés sous les arbres (seuls les relevés GPS à ± 15 m ou mieux sont gardés).
4. **Ajouter un lieu** : centre du bâtiment, nom, catégorie, sigles et surnoms, puis chaque porte avec une note (« porte côté parking, 1er étage à gauche »).
5. **Vérifier** en demandant des itinéraires entre lieux éloignés : un trajet absurde signale presque toujours deux chemins non raccordés.
6. **Imprimer les QR codes** (menu > Imprimer les QR codes) pour les portails, carrefours et halls.

## Architecture

```
public/    appli web : app.js (navigation), collectMode.js (mode collecte), sw.js (hors ligne)
shared/    code commun navigateur et serveur : géométrie, graphe piéton et A*, recherche, consignes, validation
server/    API Express, stockage, sessions du mode collecte, journal de sécurité, import OpenStreetMap
scripts/   commandes de maintenance et contrôles de CI
docs/      contrat OpenAPI, décisions d'architecture, captures
tests/     tests node:test
```

Le serveur expose la carte complète ; le téléphone construit le graphe piéton (quelques millisecondes à l'échelle du campus) et calcule les itinéraires lui-même. La position de l'utilisateur ne quitte donc jamais son appareil.

L'API est versionnée sous `/api/v1`. Son contrat de référence est [`docs/openapi.yaml`](docs/openapi.yaml), lisible dans [Swagger Editor](https://editor.swagger.io/) ou Redoc. Un test vérifie que chaque route du contrat existe dans le serveur.

## Sécurité et données personnelles

- Le mode collecte s'ouvre avec un jeton échangé contre un cookie de session `HttpOnly`, `SameSite=Strict`, `Secure` en HTTPS. Les échecs répétés sont bloqués 15 minutes.
- Le journal de sécurité (une ligne JSON par événement) ne contient ni jeton, ni adresse IP, ni donnée personnelle.
- Toute insertion HTML côté navigateur passe par un gabarit qui échappe les valeurs ; une règle ESLint bloque les autres.
- L'appli ne collecte aucune donnée personnelle : pas de compte visiteur, calcul d'itinéraire sur le téléphone.

Signaler une vulnérabilité : voir [SECURITY.md](SECURITY.md).

## Limites connues

- **Précision GPS** : environ 5 m à découvert sur un téléphone courant, bien moins sous les arbres ou entre bâtiments. Le cercle de précision est toujours affiché ; les QR codes donnent un départ exact.
- **Fonds de carte** : tuiles OpenStreetMap et imagerie Esri appelées directement. Acceptable pour un prototype, pas pour une diffusion à tous les étudiants : prévoir un fond vectoriel auto-hébergé avant le lancement public.
- **Stockage** : un fichier JSON sur un seul serveur, à remplacer par PostgreSQL/PostGIS quand plusieurs équipes saisiront en même temps.
- Un seul jeton partagé pour le mode collecte, pas de comptes nominatifs ni d'historique des modifications.
- Pas encore de plans d'intérieur ni d'étages navigables.

## Contribuer

Le projet suit Gitflow : `main` reçoit uniquement les versions publiées, `develop` est la branche de travail. Nommage des branches, format des commits, taille et description des PR : tout est dans [CONTRIBUTING.md](CONTRIBUTING.md). Les écarts assumés par rapport à ces règles sont listés dans [docs/decisions.md](docs/decisions.md).

## Licence

Le code est distribué sous [Mozilla Public License 2.0](LICENSE) : chacun peut l'utiliser, y compris dans un produit fermé, mais toute modification d'un fichier du projet doit rester publiée sous la même licence.

Les données cartographiques ont leurs propres conditions :

- fond de plan et données importées : © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright), licence ODbL. Une carte du campus construite à partir d'un import OSM et diffusée publiquement doit l'être sous ODbL ;
- imagerie satellite : © Esri, Maxar, Earthstar Geographics, soumise aux conditions d'utilisation d'Esri.
