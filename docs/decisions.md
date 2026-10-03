# Décisions et écarts documentés

Tout écart aux conventions de [CONTRIBUTING.md](../CONTRIBUTING.md) est une décision : datée, justifiée, et révisée quand son contexte change.

## 2026-09-29 · Préfixe de branche `UAC-{numéro d'issue}`

**Règle d'origine** : le nom de branche porte le numéro du ticket Jira (`type/{PROJET}-{ticket}-{description}`).
**Décision** : le projet n'utilise pas Jira ; le suivi passe par les issues GitHub. Les branches et les titres de PR portent donc le préfixe `UAC-` suivi du numéro d'issue (`feature/UAC-12-plans-interieurs`, `[UAC-12] Plans intérieurs`). La traçabilité avec le backlog est conservée.
Exception pour l'import initial : les issues n'étaient pas encore ouvertes, les numéros `UAC-1` à `UAC-4` renvoient directement aux PR #1 à #4, qui décrivent chacune leur objectif et leurs critères.
**À revoir** : si le projet rejoint un outil de suivi existant.

## 2026-09-29 · Approbation de PR non exigée tant que le projet a un seul développeur

**Règle d'origine** : au moins une approbation explicite, jamais de fusion de sa propre PR.
**Décision** : GitHub interdit d'approuver sa propre PR. Avec un seul développeur, exiger une approbation bloquerait toute fusion. Les branches `main` et `develop` restent protégées (PR obligatoire, CI verte obligatoire, pas de poussée forcée ni de suppression), mais le nombre d'approbations requises est fixé à 0.
**À revoir** : dès l'arrivée d'un deuxième contributeur, passer à 1 approbation obligatoire sur `develop` et `main`.

## 2026-09-29 · Import initial du prototype en quatre PR de plus de 400 lignes

**Règle d'origine** : PR de moins de 400 lignes, justification entre 400 et 1000, fractionnement au-delà.
**Décision** : le prototype existait avant le dépôt. Il est versé en quatre PR empilées, une par couche (socle et outillage, moteur d'itinéraire, API, appli web). Certaines dépassent 1000 lignes ; les découper davantage produirait des morceaux qui ne se testent pas seuls (par exemple l'appli web sans son mode collecte, qui partage la même page). Chaque description de PR signale le dépassement.
**À revoir** : ne s'applique qu'à l'import initial. Les évolutions suivantes respectent la limite.

## 2026-09-29 · Règles ESLint de sécurité désactivées

- `security/detect-object-injection` : signale chaque accès `tableau[index]`, y compris sur des index calculés par le code. Aucun de ces accès n'utilise une clé venant d'une requête HTTP ; les clés externes (catégories, types de chemin) sont vérifiées avec `Object.hasOwn` dans `shared/validate.js`.
- `security/detect-non-literal-fs-filename` : les chemins de fichiers sont fixés dans le code (dossier `data/`, fichiers de migration), jamais tirés d'une requête.

**À revoir** : si une route accepte un jour un nom de fichier ou une clé d'objet fournis par le client.

## 2026-09-29 · Réponses hors enveloppe

L'enveloppe `{ data, meta }` s'applique à toutes les réponses JSON. Deux réponses sont des fichiers et en sont exclues : l'export `GET /api/v1/campus-map?format=geojson` (GeoJSON standard, lisible par QGIS) et les QR codes `GET /api/v1/places/{placeId}/qr-code` et `GET /api/v1/contribution/public-link/qr-code` (images SVG).

## 2026-09-29 · Stockage en fichier JSON (remplacée)

**Remplacée** par la décision « MariaDB plutôt que PostgreSQL » ci-dessous.

Un fichier JSON unique, écrit de façon atomique et sérialisée, suffit pour un prototype avec une seule équipe de saisie. Migration prévue vers PostgreSQL/PostGIS quand plusieurs personnes saisiront en parallèle ou qu'un historique des modifications sera nécessaire.

## 2026-09-29 · MariaDB plutôt que PostgreSQL

**Contexte** : la décision « Stockage en fichier JSON » prévoyait PostgreSQL/PostGIS quand plusieurs personnes saisiraient en parallèle ou qu'un historique serait nécessaire. Ces deux besoins arrivent avec la mise en ligne puis la contribution ouverte.
**Décision** : MariaDB 11.4, avec un SQL compatible MySQL 8. L'hébergement retenu (cPanel mutualisé) fournit et administre MariaDB, et WampServer fournit la même version en local. PostgreSQL demanderait un serveur à installer et à sécuriser soi-même ; les itinéraires restent calculés sur le téléphone, donc PostGIS n'apporte rien aujourd'hui. Détail : [specs/2026-09-29-mysql-et-mise-en-ligne.md](specs/2026-09-29-mysql-et-mise-en-ligne.md).
**À revoir** : si des requêtes spatiales côté serveur deviennent nécessaires.

## 2026-09-30 · Contribution ouverte : choix de réalisation

Détail : [specs/2026-09-30-contribution-ouverte.md](specs/2026-09-30-contribution-ouverte.md).

- **Annulation par comparaison d'état** : une modification s'annule si l'élément est encore dans l'état qu'elle a laissé. On remonte ainsi l'historique pas à pas ; une opération en masse n'empêche l'annulation que si elle a réellement changé l'élément.
- **Limites d'envoi comptées avant la validation** : un envoi refusé compte aussi, pour qu'un robot ne puisse pas essayer sans fin.
- **Relecteurs par session seulement** : l'en-tête `Authorization: Bearer` reste réservé à `ADMIN_TOKEN` (scripts). Le compteur d'échecs de connexion n'est remis à zéro que par une connexion administrateur : un jeton de relecteur ne sert pas à deviner `ADMIN_TOKEN`.
- **Cookie contributeur renouvelé à chaque appel** : les 180 jours courent depuis la dernière visite, pour qu'un contributeur actif ne perde ni sa confiance ni son droit à l'oubli.
- **Journal** : l'événement `admin_action_forbidden` (refus 403 d'une action réservée à l'administrateur) s'ajoute à la liste de la spécification.
- **Interface** : un module par onglet du panneau de relecture, et un éditeur (`mapEditor.js`) partagé par le mode collecte et la contribution.

**À revoir** : le compteur d'échecs de connexion est partagé par adresse IP entre l'administrateur et les relecteurs ; derrière le Wi-Fi du campus, dix échecs bloquent tout le monde 15 minutes. Un compteur par type de jeton serait à étudier si cela arrive.

## 2026-10-01 · Referer envoyé aux serveurs de tuiles

`Referrer-Policy: strict-origin-when-cross-origin` remplace `same-origin`. Les serveurs de tuiles OpenStreetMap refusent une requête faite depuis une page web sans en-tête `Referer` et renvoient l'image « Access blocked ». Seule l'origine `https://uacmap.bytechnum.com/` part vers un autre domaine, jamais le chemin ni les paramètres de l'adresse (`?ici=…`, `?contribuer=…`). Le cache des tuiles du service worker passe en v2 pour oublier les images de blocage déjà enregistrées.

## 2026-10-01 · Fond de carte auto-hébergé

Détail : [specs/2026-10-01-fond-de-carte-auto-heberge.md](specs/2026-10-01-fond-de-carte-auto-heberge.md).

- **Fichier entier plutôt que lecture par morceaux** : l'extrait du campus pèse moins de 2 Mo. Le télécharger une fois et le lire en mémoire évite les requêtes partielles, que le service worker ne sait pas garder, et rend tout le fond disponible hors ligne.
- **Style produit dans le navigateur** : `@protomaps/basemaps` génère les couches au chargement, sans étape de construction, comme le reste de l'appli.
- **Sans la couche des lieux OpenStreetMap** : seuls les lieux de l'application, relus par l'équipe, apparaissent.
- **Fichier versionné dans le dépôt** : `git pull` le met en production ; une régénération alourdit le dépôt d'environ 2 Mo, ce qui reste rare.
- **Satellite réservé aux modes d'édition** : il sert à tracer les allées ; les visiteurs n'appellent plus aucun domaine extérieur.

**À revoir** : la vue satellite appelle Esri sans clé ; acceptable avec le seul trafic de l'équipe et des contributeurs.

## 2026-10-02 · Vue satellite rouverte aux visiteurs

Le bouton des calques et la vue satellite d'Esri, réservés aux modes d'édition depuis la version 0.4.0, redeviennent accessibles à tous. Esri n'est appelé que lorsqu'un visiteur active le satellite : le plan reste servi par le site, et l'adresse IP du visiteur ne part chez Esri qu'à ce moment. Les modes d'édition s'ouvrent toujours sur le satellite ; à la sortie, la carte reprend le fond choisi avant l'ouverture. Aucune imagerie libre ne couvre le campus (OpenAerialMap vide, images de satellites libres de 10 à 30 m) et les conditions d'Esri interdisent de la copier : un satellite sans tiers demanderait un survol par drone ou l'achat d'une image.

**À revoir** : Esri est appelé sans clé et le trafic des visiteurs s'y ajoute à celui de l'équipe. Si l'usage grandit, créer une clé d'accès gratuite chez Esri ou passer à une imagerie propre.
