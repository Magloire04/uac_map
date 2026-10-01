# Carte UAC

[![CI](https://github.com/Magloire04/uac_map/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Magloire04/uac_map/actions/workflows/ci.yml)
[![Licence MPL-2.0](https://img.shields.io/badge/licence-MPL--2.0-blue.svg)](LICENSE)

Carte et guidage piéton du campus de l'Université d'Abomey-Calavi (UAC). On cherche « scolarité », « BU » ou « amphi 1000 », et l'appli trace le chemin à pied jusqu'à la bonne porte, avec des consignes en français et un guidage GPS. Elle s'ouvre dans le navigateur du téléphone, sans installation, et reste utilisable sans réseau une fois la carte chargée.

**En ligne :** [uacmap.bytechnum.com](https://uacmap.bytechnum.com) · version 0.3.1

| Itinéraire                                                                 | Mode collecte                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ![Itinéraire vers le restaurant universitaire](docs/images/itineraire.png) | ![Tracé d'un chemin en mode collecte](docs/images/collecte.png) |

## Fonctionnalités

### Visiteurs et étudiants

- Recherche qui accepte sigles, surnoms, absence d'accents et faute de frappe.
- Itinéraire jusqu'à l'entrée la plus proche, avec options sans escaliers et sans passages inondables.
- Consignes ancrées sur des repères et guidage GPS avec recalcul en cas d'écart.
- Départ au choix : GPS, QR code « Vous êtes ici » posé sur le campus, ou point touché sur la carte.

### Contributeurs, sans compte

- Rejoindre par le lien public ou son QR code, avec un pseudo facultatif.
- Proposer un lieu, corriger un lieu, tracer ou enregistrer un chemin, signaler une erreur.
- Présence sur le campus vérifiée par le serveur à chaque envoi.
- Suivre ses propositions et la note du relecteur ; « Oublier ce téléphone » efface tout.

### Équipe, en mode collecte

- Tracé des allées sur fond satellite, relevé en marchant, fiches de lieux avec leurs entrées.
- Relecture des propositions avec comparaison et aperçu sur la carte, confiance et blocage des téléphones.
- Historique de chaque modification, avec annulation.
- Administration : relecteurs nommés, liens de contribution, suspension ; QR codes, export GeoJSON, import OpenStreetMap.

## Démarrage rapide

Prérequis : Node.js 22.9 ou plus récent, MariaDB 11.4 (fourni par WampServer sous Windows) ou MySQL 8.

1. Créer les bases et leur utilisateur :

   ```sql
   CREATE DATABASE uac_map CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE DATABASE uac_map_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'uac_map'@'localhost' IDENTIFIED BY 'un-mot-de-passe-local';
   CREATE USER 'uac_map'@'127.0.0.1' IDENTIFIED BY 'un-mot-de-passe-local';
   GRANT ALL PRIVILEGES ON uac_map.* TO 'uac_map'@'localhost', 'uac_map'@'127.0.0.1';
   GRANT ALL PRIVILEGES ON uac_map_test.* TO 'uac_map'@'localhost', 'uac_map'@'127.0.0.1';
   ```

2. Installer, configurer et lancer :

   ```bash
   git clone https://github.com/Magloire04/uac_map.git
   cd uac_map
   npm install
   cp .env.example .env            # renseigner DATABASE_PASSWORD
   cp .env.test.example .env.test  # même mot de passe, base uac_map_test
   npm run database:migrate
   npm start
   ```

3. Ouvrir <http://localhost:3000>. Le premier lancement charge une carte de démonstration et écrit le jeton du mode collecte dans `data/.admin-token`.

Sous Windows, cloner avec `git clone -c core.autocrlf=input …` : Prettier exige des fins de ligne LF. Chaque variable de configuration est décrite dans `.env.example`.

## Commandes

| Commande                     | Rôle                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                | Serveur relancé à chaque modification                             |
| `npm run check`              | Lint, formatage et tests, comme la CI                             |
| `npm test`                   | Tests unitaires et d'intégration (base de `.env.test`)            |
| `npm run database:migrate`   | Applique les migrations manquantes                                |
| `npm run demo`               | Recharge la carte de démonstration                                |
| `npm run reset -- --oui`     | Vide la carte avant le relevé réel                                |
| `npm run import-osm`         | Importe chemins, bâtiments nommés et entrées depuis OpenStreetMap |
| `npm run import-perimeter`   | Importe le contour du campus, qui limite les contributions        |
| `npm run purge-contributors` | Supprime les contributeurs inactifs depuis 12 mois (chaque mois)  |

## Tester sur un téléphone

Le navigateur n'autorise le GPS que sur `https://` ou `localhost`.

- Même Wi-Fi : `HTTPS_ENABLED=true npm start`, puis ouvrir `https://<adresse-du-poste>:3443` sur le téléphone et accepter le certificat auto-signé.
- À plusieurs sur le campus : `npx cloudflared tunnel --url http://localhost:3000`, et relancer avec `PUBLIC_URL=<adresse du tunnel>` pour que les QR codes pointent au bon endroit.

## Mise en production

Hébergement cPanel avec Node.js 24 et MariaDB 11.4. Seule la branche `main` est déployée, et chaque version porte une étiquette. Installation, mise à jour, sauvegardes, restauration et ouverture de la contribution (périmètre, lien public, relecteurs, purge mensuelle) : [docs/deployment.md](docs/deployment.md).

## Architecture

```
public/   appli web : navigation, éditeur de carte, modes collecte et contribution, relecture, service worker
shared/   code commun au navigateur et au serveur : géométrie, présence, graphe piéton et A*, recherche, consignes
server/   API Express, accès à MariaDB (server/database/), journal de sécurité, import OpenStreetMap
scripts/  commandes de maintenance, déploiement et contrôles de CI
docs/     contrat OpenAPI, décisions, spécifications, déploiement
tests/    tests node:test
```

Le serveur fournit la carte complète ; le téléphone construit le graphe piéton et calcule lui-même les itinéraires. L'API est versionnée sous `/api/v1`, avec pour contrat [docs/openapi.yaml](docs/openapi.yaml) : un test vérifie que chaque route du contrat existe.

## Sécurité et données personnelles

- Le mode collecte s'ouvre avec un jeton d'administrateur ou de relecteur, échangé contre un cookie de session `HttpOnly`, `SameSite=Strict`, `Secure`. Les échecs répétés sont bloqués 15 minutes.
- Un contributeur n'a pas de compte : un secret aléatoire dans un cookie identifie son téléphone. La base ne garde que des empreintes des secrets, jetons, sessions et adresses des clients.
- La position sert au calcul d'itinéraire sur le téléphone. Elle ne part qu'avec une proposition, pour vérifier la présence sur le campus, et n'est jamais enregistrée.
- Un contributeur inactif depuis 12 mois est supprimé ; « Oublier ce téléphone » le supprime aussitôt. Ce qu'il a publié reste, attribué à « contributeur supprimé ».
- Toute insertion HTML passe par un gabarit qui échappe les valeurs, sous une politique CSP stricte. Le journal de sécurité ne contient ni jeton, ni adresse IP, ni pseudo.

Signaler une vulnérabilité : [SECURITY.md](SECURITY.md).

## Limites connues

- Précision GPS : environ 5 m à découvert, bien moins sous les arbres. Le cercle de précision est affiché ; les QR codes donnent un départ exact.
- Fonds de carte appelés directement chez OpenStreetMap et Esri : prévoir un fond auto-hébergé avant une diffusion à tous les étudiants.
- Un navigateur permet de simuler une position : la relecture, les limites d'envoi et le blocage traitent les abus.
- Pas encore de plans d'intérieur ni d'étages.

## Contribuer

Gitflow : `main` reçoit les versions publiées, `develop` le travail en cours. Branches, commits et Pull Requests : [CONTRIBUTING.md](CONTRIBUTING.md). Écarts assumés : [docs/decisions.md](docs/decisions.md).

## Licence

Code sous [Mozilla Public License 2.0](LICENSE) : utilisable partout, y compris dans un produit fermé, mais toute modification d'un fichier du projet reste publiée sous la même licence.

- Fond de plan et données importées : © contributeurs [OpenStreetMap](https://www.openstreetmap.org/copyright), licence ODbL. Une carte du campus construite à partir d'un import OSM et diffusée publiquement l'est sous ODbL.
- Imagerie satellite : © Esri, Maxar, Earthstar Geographics, selon les conditions d'utilisation d'Esri.
