# Fond de carte auto-hébergé

- Statut : proposée, en relecture
- Issue : #35
- Date : 2026-10-01
- S'appuie sur : [2026-09-30-contribution-ouverte.md](2026-09-30-contribution-ouverte.md) (version 0.3.1 en ligne)

## 1. Intention

Le fond de plan est aujourd'hui téléchargé par chaque visiteur, image par image, sur les serveurs de tuiles d'OpenStreetMap, et la vue satellite sur ceux d'Esri. Cela pose trois problèmes :

- les serveurs d'OpenStreetMap sont tenus par des bénévoles et réservés à un usage léger : une application très utilisée peut être bloquée, comme l'a montré l'incident de la version 0.3.1 (#30) ;
- la carte dépend de deux services extérieurs sans garantie ;
- l'adresse IP de chaque visiteur part chez ces deux tiers.

Ce projet sert le fond de plan depuis le serveur de l'application, sous forme de tuiles vectorielles tirées d'OpenStreetMap, pour le campus et 3 km autour. La vue satellite, utile pour tracer les allées, est réservée aux modes collecte et contribution.

## 2. Décisions de conception

| Sujet               | Décision                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format              | Un fichier PMTiles de tuiles vectorielles, extrait des builds Protomaps (données OpenStreetMap), niveaux de zoom 11 à 15                                         |
| Zone                | Le campus et environ 3 km autour : 1,2 Mo. La carte ne permet pas d'en sortir                                                                                    |
| Chargement          | Le fichier entier est téléchargé une fois, puis lu en mémoire. Pas de lecture par morceaux                                                                       |
| Hébergement         | Le fichier, les polices et les icônes sont versionnés dans le dépôt et servis par l'application. Aucun appel extérieur pour le plan                              |
| Style               | Style « light » de Protomaps, libellés en français, sans la couche des lieux OpenStreetMap : seuls les lieux de l'application apparaissent                       |
| Vue satellite       | Toujours chez Esri, mais seulement dans les modes collecte et contribution. Les visiteurs n'appellent plus Esri                                                  |
| Mise à jour du fond | Une commande régénère le fichier, les polices et les icônes. Elle se lance à la main, sur un poste de développement, quand on veut des données OSM plus récentes |

## 3. Hors périmètre

- Vue satellite auto-hébergée ou clé d'accès Esri.
- Mise à jour automatique et périodique du fond de carte.
- Fond de carte au-delà de la zone, mode sombre.
- Plans d'intérieur.

## 4. Le fichier de fond de carte

- Zone, en degrés (ouest, sud, est, nord) : `2.3104, 6.3822, 2.3736, 6.4500`. Elle prolonge d'environ 3 km de chaque côté le périmètre du campus importé en production. Elle est définie une seule fois, dans `shared/basemap.js`, et sert à la fois à l'extraction et à la limite de navigation.
- Source : le build quotidien de Protomaps, `https://build.protomaps.com/AAAAMMJJ.pmtiles`, dérivé d'OpenStreetMap et de Natural Earth, schéma de tuiles version 4.
- Extraction : `pmtiles extract` avec la zone ci-dessus, `--minzoom=11` et `--maxzoom=15`. La carte ne pouvant pas sortir de la zone, rien n'est affichable en dessous du zoom 12 ; les zooms plus petits, un tiers du fichier, ne sont pas extraits. Au-delà du zoom 15, MapLibre agrandit les tuiles vectorielles sans perte de netteté.
- Résultat : `public/basemap/campus.pmtiles`, environ 1,2 Mo, données du jour du build. Le fichier est versionné dans le dépôt : `git pull` suffit à le mettre en production.

### Régénération

Nouvelle commande `npm run build-basemap -- --date AAAAMMJJ` (par défaut, le build de la veille), dans `scripts/buildBasemap.js` :

1. lance `pmtiles extract` vers `public/basemap/campus.pmtiles` ;
2. télécharge les polices et les icônes (section 5) depuis le dépôt `protomaps/basemaps-assets`, à un commit fixé ;
3. affiche le poids des fichiers produits.

Elle demande l'outil `pmtiles` (binaire officiel de `protomaps/go-pmtiles`, dans le `PATH` ou indiqué par `PMTILES_BIN`) et un accès à Internet. Elle n'est lancée ni par la CI ni en production. Après une régénération, la version du cache de l'appli du service worker change (section 8).

## 5. Polices et icônes

- Polices Noto Sans Regular, Medium et Italic, au format PBF utilisé par MapLibre, pour les plages de caractères 0-255, 256-511, 512-767, 768-1023, 7680-7935 et 8192-8447. Elles couvrent le français et les lettres des noms fon et yoruba (ɔ, ɛ, ẹ, ọ, accents combinés). 18 fichiers dans `public/basemap/fonts/<police>/<plage>.pbf`.
- Icônes du style « light » : `light.json`, `light.png`, `light@2x.json`, `light@2x.png` dans `public/basemap/sprites/`. Sans la couche des lieux OSM, elles servent surtout aux cartouches des routes (RNIE 2).
- Licences jointes : `OFL.txt` pour les polices, la licence MIT des icônes.

## 6. Affichage dans le navigateur

- `public/index.html` charge `/vendor/pmtiles/pmtiles.js` (version prête pour le navigateur, sans dépendance) avant `app.js`. Le style est produit à l'exécution par `@protomaps/basemaps`, servi depuis `/vendor/protomaps-basemaps/index.js`. Aucune étape de construction.
- Au démarrage, `app.js` télécharge `campus.pmtiles` une fois et enregistre le protocole `pmtiles://` de MapLibre sur une source qui lit ce fichier en mémoire. La carte s'affiche aussitôt : couches de l'application, recherche et itinéraires n'attendent pas le fond.
- Style de la carte, construit par une fonction de `shared/basemap.js` :
  - couches Protomaps `light` en français, sauf celle dont la couche source est `pois` ;
  - polices et icônes servies depuis l'origine du site ;
  - source raster satellite d'Esri, couche cachée par défaut, placée au-dessus du fond et sous les couches de l'application ;
  - mention « © OpenStreetMap · Protomaps », et « Imagerie © Esri, Maxar, Earthstar Geographics » en vue satellite.
- Navigation : `maxBounds` reprend la zone. On ne peut ni s'en éloigner ni dézoomer au point d'en voir le bord. Le zoom maximal (20,5) ne change pas. Un visiteur dont le GPS est hors zone garde le comportement actuel : l'application lui propose de toucher la carte pour choisir son départ.
- Si le fichier ne se charge pas (premier passage sans réseau, erreur du serveur), la carte reste utilisable sur un fond uni et un message s'affiche une fois : « Fond de carte indisponible : les lieux et les itinéraires restent utilisables. »

## 7. Vue satellite

- Le bouton des calques est caché hors des modes collecte et contribution.
- À l'ouverture d'un de ces modes, l'éditeur affiche le bouton et passe en vue satellite (comportement actuel). Le bouton bascule entre plan et satellite.
- À la fermeture du mode, la carte revient au plan et le bouton disparaît.

## 8. Hors ligne

- Cache de l'appli en v4 : il ajoute `campus.pmtiles`, `/vendor/pmtiles/pmtiles.js`, `/vendor/protomaps-basemaps/index.js` et les quatre fichiers d'icônes. Après une première visite, le fond de toute la zone est disponible sans réseau, y compris les quartiers jamais affichés.
- Les polices sont mises en cache à leur première utilisation par la règle actuelle (réseau d'abord, cache en secours, pour les fichiers du site).
- Le cache des tuiles ne concerne plus que le satellite : `server.arcgisonline.com` seul, cache `uac-map-tiles-v3`. L'ancien cache, qui contient les tuiles OSM, est supprimé à l'activation.

## 9. Serveur et sécurité

- `server/app.js` sert `node_modules/pmtiles/dist` sous `/vendor/pmtiles` et `node_modules/@protomaps/basemaps/dist/esm` sous `/vendor/protomaps-basemaps`, avec la même durée de cache que MapLibre. Le dossier `public/basemap` est servi par la règle existante des fichiers publics.
- Politique de sécurité du contenu : `https://tile.openstreetmap.org` disparaît de `img-src` et `connect-src`. `https://server.arcgisonline.com` reste, pour le satellite des modes.
- Nouvelles dépendances : `pmtiles` (4.5) et `@protomaps/basemaps` (5.7), versions figées par `package-lock.json`.

## 10. Organisation du code

- `shared/basemap.js` : la zone (`BASEMAP_BOUNDS`), le retrait de la couche des lieux OSM et la construction du style à partir des couches Protomaps, de l'origine du site et de la source satellite. Fonctions pures, testées dans Node.
- `public/app.js` : chargement du fichier, enregistrement du protocole, style, `maxBounds`, message en cas d'échec, visibilité du bouton des calques.
- `public/mapEditor.js` : affichage du bouton et retour au plan à la fermeture.
- `public/sw.js` : caches v4 et v3, liste de l'appli.
- `scripts/buildBasemap.js`, `public/basemap/` : régénération et fichiers produits.

## 11. Tests

- Unitaires (`shared/basemap.js`) :
  - la zone est valide, contient le centre du campus, et chacun de ses bords est à plus de 3,4 km de ce centre ;
  - la couche `pois` est retirée, les autres restent dans le même ordre, la liste d'origine n'est pas modifiée ;
  - le style n'appelle que l'origine du site, sauf la source satellite ; la couche satellite est cachée par défaut et placée après les couches du fond ;
  - les arguments de `pmtiles extract` reprennent la zone, les zooms minimal et maximal et la date ; l'en-tête du fichier versionné correspond à la zone et aux zooms.
- Intégration : le serveur sert `campus.pmtiles` (en-tête `PMTiles`), une police, une icône, les deux bibliothèques ; la politique de sécurité ne cite plus `tile.openstreetmap.org`.
- Navigateur, au format mobile puis ordinateur :
  - aucune requête vers un autre domaine sur la page d'un visiteur ;
  - plan affiché avec rues, bâtiments et quartiers en français, sans icônes de commerces ;
  - impossible de sortir de la zone ;
  - bouton des calques absent pour un visiteur, présent en modes collecte et contribution, retour au plan à la sortie ;
  - après une visite, en mode avion, rechargement : fond complet sur toute la zone ;
  - fichier de fond bloqué : message affiché, itinéraire toujours calculé.

## 12. Découpage et mise en ligne

1. Zone, style et tests (`shared/basemap.js`), commande de régénération, fichiers du fond, dépendances, routes du serveur et politique de sécurité.
2. Affichage dans le navigateur, vue satellite réservée aux modes, service worker.
3. Documentation (`README.md`, `docs/decisions.md`) et version 0.4.0.

Mise en ligne par `scripts/deployment/updateProduction.sh` : le fichier de fond arrive avec le code, aucune commande à lancer sur le serveur.

## 13. Critères d'acceptation

1. `npm run check` passe en local et la CI est verte.
2. Sur la page d'un visiteur, l'onglet Réseau du navigateur ne montre aucune requête vers un autre domaine.
3. Le plan montre les rues, les bâtiments et les quartiers en français, sans les icônes de lieux OpenStreetMap, et l'on ne peut pas sortir de la zone.
4. Le bouton des calques n'apparaît qu'en modes collecte et contribution ; quitter un mode ramène au plan.
5. Après une première visite, la carte s'affiche entièrement hors ligne, y compris sur des quartiers jamais affichés.
6. La politique de sécurité du contenu ne cite plus `tile.openstreetmap.org`.
7. La mention « © OpenStreetMap · Protomaps » est visible.
8. `npm run build-basemap` régénère le fichier, les polices et les icônes.
9. En production, après la mise à jour, les critères 2 à 7 sont vérifiés sur `uacmap.bytechnum.com`.

## 14. Risques

| Risque                                                                    | Parade                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Les builds quotidiens de Protomaps ne restent en ligne que quelques jours | La commande prend la date en paramètre ; à défaut, Planetiler et l'extrait Bénin de Geofabrik produisent le même fichier |
| Données figées au jour du build                                           | Régénérer quand le quartier change ; le relevé du campus, lui, vit dans l'application                                    |
| 1,2 Mo à télécharger au premier passage sur un réseau mobile              | Les couches de l'application, la recherche et les itinéraires n'attendent pas le fond                                    |
| Le dépôt grossit d'environ 2 Mo à chaque régénération                     | Régénérations rares                                                                                                      |
| Style et tuiles de versions incompatibles                                 | Versions figées ; vérification dans le navigateur à chaque mise à jour des bibliothèques                                 |
| Caractère absent des plages de polices fournies                           | Plages choisies pour le français, le fon et le yoruba ; une plage manquante n'efface qu'un caractère, pas le libellé     |
| Satellite appelé chez Esri sans clé                                       | Trafic limité à l'équipe et aux contributeurs ; à revoir si l'usage grandit                                              |

## 15. Licences et mentions

- Données : © contributeurs OpenStreetMap (ODbL), via le schéma Protomaps (BSD). Natural Earth (domaine public) ne sert qu'aux petits zooms, qui ne sont pas extraits.
- Polices Noto Sans : SIL Open Font License. Icônes : licence MIT (tangrams/icons).
- Bibliothèques : `pmtiles` et `@protomaps/basemaps` sous licence BSD-3-Clause.
- Le README reprend ces mentions dans sa section « Licence ».
