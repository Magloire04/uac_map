# Contribuer à Carte UAC

Les conventions ci-dessous reprennent les standards de développement de l'ASIN (nommage, API, sécurité, Git et revue de code). Les adaptations propres au projet sont listées et justifiées dans [docs/decisions.md](docs/decisions.md).

## Branches (Gitflow)

| Branche     | Rôle                                                  | Part de   | Fusionne vers       |
| ----------- | ----------------------------------------------------- | --------- | ------------------- |
| `main`      | Versions publiées. Protégée, jamais de commit direct. | —         | —                   |
| `develop`   | Intégration, branche de travail par défaut. Protégée. | `main`    | `main` (release)    |
| `feature/*` | Nouvelle fonctionnalité                               | `develop` | `develop`           |
| `bugfix/*`  | Correctif non urgent                                  | `develop` | `develop`           |
| `release/*` | Stabilisation avant publication                       | `develop` | `main` et `develop` |
| `hotfix/*`  | Correctif urgent en production                        | `main`    | `main` et `develop` |

Nommage : `type/UAC-{numéro d'issue}-{description-en-kebab-case}`, tout en minuscules sauf le préfixe `UAC`. Le numéro d'issue GitHub est obligatoire.

```
feature/UAC-12-plans-interieurs
bugfix/UAC-15-accroche-jonction-en-t
hotfix/UAC-18-cookie-session-secure
release/2026-10-15
```

Aucun commit direct sur `main` ni `develop` : tout passe par une Pull Request.

## Commits (Conventional Commits)

Format : `type(scope): description`, en minuscules, sans point final, 72 caractères au maximum.

| Type       | Usage                                   | Exemple                                            |
| ---------- | --------------------------------------- | -------------------------------------------------- |
| `feat`     | Nouvelle fonctionnalité                 | `feat(collecte): enregistrement en marchant`       |
| `fix`      | Correction de bug                       | `fix(itineraire): jonction en t non raccordée`     |
| `docs`     | Documentation seule                     | `docs(api): ajout de la route des qr codes`        |
| `refactor` | Restructuration sans effet fonctionnel  | `refactor(graphe): extraction de l'index spatial`  |
| `test`     | Ajout ou correction de tests            | `test(recherche): cas des sigles`                  |
| `chore`    | Maintenance, dépendances, configuration | `chore(deps): mise à jour de maplibre-gl`          |
| `style`    | Formatage, sans logique                 | `style: passage de prettier`                       |
| `perf`     | Performance                             | `perf(graphe): index spatial pour les croisements` |

Changement cassant : `feat!: suppression de l'ancienne route /api/data`.

Le hook `commit-msg` installé par `npm install` refuse un message mal formé, ainsi qu'un message qui contient une signature ou un co-auteur ajouté automatiquement par un outil. La CI refait le même contrôle sur chaque PR.

## Pull Requests

- Cible : `develop` (sauf `hotfix/*` et `release/*`).
- Titre : `[UAC-12] Description courte` (60 caractères au maximum).
- Taille : moins de 400 lignes ; entre 400 et 1000, justifier dans la description ; au-delà, fractionner (refactoring à part, puis par couche : API, logique, interface).
- Description : le modèle proposé à l'ouverture (objectif, changements, tests, checklist) est obligatoire.
- La CI (`lint-et-tests` et `commits`) doit être verte avant fusion.
- Fusion par commit de fusion (pas de squash), branche supprimée après fusion.

### Revue de code

Ordre de lecture : comprendre le pourquoi, puis logique et cas limites, sécurité, maintenabilité, tests, et le style en dernier. On ne bloque jamais une PR pour du style : c'est le rôle d'ESLint et de Prettier.

Chaque commentaire porte un tag :

| Tag          | Sens                                  |
| ------------ | ------------------------------------- |
| `[must]`     | Bloquant, à corriger avant la fusion  |
| `[should]`   | Important, non bloquant à court terme |
| `[nit]`      | Détail                                |
| `[question]` | Demande de précision                  |
| `[praise]`   | Bonne pratique à saluer               |

Premier retour sous 4 heures ouvrables. On ne fusionne pas sa propre PR, sauf correctif urgent validé ; voir [docs/decisions.md](docs/decisions.md) pour la période où le projet n'a qu'un développeur.

## Code

### Nommage

- Fichiers : utilitaires et modules en camelCase (`collectMode.js`), dossiers et fichiers de configuration en kebab-case, tests suffixés `.test.js`.
- Identifiants en anglais ; textes affichés à l'utilisateur en français.
- Variables en camelCase, constantes en `CONSTANT_CASE`, booléens préfixés par `is`, `has` ou `can`.
- Fonctions nommées verbe + nom (`findRoute`, `buildSearchIndex`), gestionnaires d'événements en `handle…`.
- Aucune abréviation (`response` et non `res`, `error` et non `err`) ni nom vague (`data`, `temp`, `result`).

### API

- Ressources au pluriel, verbes HTTP pour les actions, deux niveaux d'imbrication au plus, filtres en paramètres de requête.
- Enveloppe unique : `{ data, meta }` en succès (`meta` obligatoire sur les listes), `{ error: { code, message, status } }` en échec.
- Toute évolution de l'API commence par [docs/openapi.yaml](docs/openapi.yaml). Un changement cassant impose une nouvelle version (`/api/v2`), annoncée trois mois avant la suppression de l'ancienne.

### Sécurité

- Aucune valeur externe concaténée dans une requête, une commande ou du HTML. Côté navigateur, toute insertion HTML passe par le gabarit `html` de `public/safeHtml.js` (la règle ESLint `no-unsanitized` bloque le reste).
- Contrôle d'accès côté serveur sur chaque route d'écriture (`requireAdmin`).
- Secrets uniquement dans `.env` ou le gestionnaire de secrets de l'hébergement, jamais dans le code ni dans Git. Chaque nouvelle variable est documentée dans `.env.example`.
- Journal : événements de sécurité oui (`logSecurityEvent`), jetons, mots de passe, adresses IP et données personnelles jamais.
- Réponses d'erreur génériques : aucune trace d'exécution renvoyée au client.

### Tests

- Un test par comportement, nommé par la phrase qui décrit ce comportement.
- Toute fonction à logique métier a ses tests : chemin nominal, cas limites, cas d'erreur.
- Un bug se corrige en écrivant d'abord le test qui le reproduit.

Avant d'ouvrir une PR : `npm run check`.

## Configuration du dépôt GitHub

Les réglages du dépôt (branche par défaut `develop`, fusion par commit de fusion, suppression des branches fusionnées, protection de `main` et `develop` avec CI obligatoire) sont décrits dans `scripts/github/configureRepository.sh`. Un administrateur les applique ou les rétablit avec :

```bash
gh auth login
scripts/github/configureRepository.sh
```
