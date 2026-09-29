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
- `security/detect-non-literal-fs-filename` : les chemins de fichiers viennent de la configuration du serveur (`DATA_FILE`), jamais d'une requête.

**À revoir** : si une route accepte un jour un nom de fichier ou une clé d'objet fournis par le client.

## 2026-09-29 · Réponses hors enveloppe

L'enveloppe `{ data, meta }` s'applique à toutes les réponses JSON. Deux réponses sont des fichiers et en sont exclues : l'export `GET /api/v1/campus-map?format=geojson` (GeoJSON standard, lisible par QGIS) et le QR code `GET /api/v1/places/{placeId}/qr-code` (image SVG).

## 2026-09-29 · Stockage en fichier JSON

Un fichier JSON unique, écrit de façon atomique et sérialisée, suffit pour un prototype avec une seule équipe de saisie. Migration prévue vers PostgreSQL/PostGIS quand plusieurs personnes saisiront en parallèle ou qu'un historique des modifications sera nécessaire.
