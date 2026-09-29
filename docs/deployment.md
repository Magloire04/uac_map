# Déploiement

L'application tourne sur un hébergement cPanel mutualisé (CloudLinux, LiteSpeed), à l'adresse `https://uacmap.bytechnum.com`. Seule la branche `main` est déployée. Dans ce document, `<compte>` désigne l'identifiant du compte cPanel (affiché dans « Informations générales » de cPanel, et dans la variable `$USER` en SSH).

## 1. Installation initiale

À faire une seule fois, dans l'ordre.

### 1.1 Base de données

1. cPanel, Database Wizard.
2. Base : `uacmap` (cPanel la nomme `<compte>_uacmap`).
3. Utilisateur : `uacmap` (nommé `<compte>_uacmap`), mot de passe généré par le bouton Password Generator, rangé dans un gestionnaire de mots de passe.
4. Droits : ALL PRIVILEGES, sur cette base uniquement. Ce compte héberge d'autres sites : l'utilisateur de la carte ne doit avoir aucun droit sur leurs bases.

### 1.2 Code

1. cPanel, Git Version Control, Create.
2. Clone URL : `https://github.com/Magloire04/uac_map.git`. Repository Path : `/home/<compte>/uac_map`, hors de `public_html`.
3. En SSH : `git -C ~/uac_map checkout main`.

### 1.3 Application Node.js

1. Vérifier que `uacmap.bytechnum.com` figure dans la liste « URL de l'application » de Setup Node.js App. Sinon, déclarer d'abord le sous-domaine dans l'hébergement Spaceship.
2. Setup Node.js App, Créer une application :
   - Version de Node.js : 24.21.0
   - Mode d'application : Production
   - Racine de l'application : `uac_map`
   - URL de l'application : `uacmap.bytechnum.com`
   - Fichier de démarrage de l'application : `app.cjs`
3. Aucune variable n'est à saisir dans cet écran : la configuration est dans le fichier `.env` (1.5).
4. Noter la commande affichée en haut de la page de l'application (« source /home/<compte>/nodevenv/uac_map/24/bin/activate && cd /home/<compte>/uac_map »). Elle ouvre l'environnement Node en SSH.

### 1.4 Dépendances

Dans Setup Node.js App, bouton « Run NPM Install », ou en SSH, dans l'environnement Node :

```bash
npm install --omit=dev
```

Ne jamais créer de dossier `node_modules` à la main ni lancer `npm ci` : CloudLinux range les dépendances dans l'environnement de l'application et relie `node_modules` à cet emplacement.

### 1.5 Fichier `.env`

En SSH, dans l'environnement Node :

```bash
cd ~/uac_map
cp .env.example .env
chmod 600 .env
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"   # jeton du mode collecte
nano .env
```

| Variable            | Valeur                                      |
| ------------------- | ------------------------------------------- |
| `NODE_ENV`          | `production`                                |
| `DATABASE_HOST`     | `localhost`                                 |
| `DATABASE_PORT`     | `3306`                                      |
| `DATABASE_NAME`     | `<compte>_uacmap`                           |
| `DATABASE_USER`     | `<compte>_uacmap`                           |
| `DATABASE_PASSWORD` | Mot de passe de l'étape 1.1                 |
| `ADMIN_TOKEN`       | Jeton généré ci-dessus                      |
| `PUBLIC_URL`        | `https://uacmap.bytechnum.com`              |
| `TRUST_PROXY`       | `loopback`, à ajuster à l'étape 2 si besoin |
| `HTTPS_ENABLED`     | `false`                                     |

Le serveur lit ce fichier au démarrage sans écraser une variable déjà définie, et les commandes (`npm run …`) le lisent aussi.

### 1.6 Schéma, puis démarrage

```bash
npm run database:migrate
```

Puis, dans Setup Node.js App, bouton RESTART. Au premier démarrage en production, la carte est vide : la démonstration n'est jamais chargée automatiquement.

### 1.7 Identifiants des sauvegardes

```bash
cat > ~/.uac_map.my.cnf <<'FIN'
[client]
user=<compte>_uacmap
password=<mot de passe de l'étape 1.1>
FIN
chmod 600 ~/.uac_map.my.cnf
~/uac_map/scripts/deployment/backupDatabase.sh
```

Le fichier est dédié à la carte : le `~/.my.cnf` éventuel du compte n'est pas touché. La dernière commande doit afficher `Sauvegarde : /home/<compte>/backups/uac_map/uac_map-…sql.gz`.

### 1.8 Sauvegarde quotidienne

cPanel, Tâches Cron, ajouter :

- Fréquence : `0 3 * * *`
- Commande : `/home/<compte>/uac_map/scripts/deployment/backupDatabase.sh >> /home/<compte>/backups/uac_map/sauvegarde.log 2>&1`

## 2. Vérifications après installation

1. `https://uacmap.bytechnum.com/api/v1/health` affiche `{"data":{"status":"ok"}}`.
2. Sur téléphone, la carte s'affiche et le GPS fonctionne.
3. Connexion au mode collecte avec le jeton : dans les outils du navigateur (Application, Cookies), le cookie `uac_admin_session` est marqué Secure.
4. Blocage : depuis un téléphone en 4G, saisir dix fois un faux jeton. La onzième tentative affiche « Trop de tentatives ». Pendant ce temps, un ordinateur en Wi-Fi peut toujours se connecter. Si l'ordinateur est bloqué lui aussi, LiteSpeed ne transmet pas l'adresse du client depuis une adresse locale : essayer `TRUST_PROXY=1` dans `.env`, redémarrer et refaire le test.
5. Créer un lieu, redémarrer l'application (RESTART) : le lieu est toujours là et la session reste ouverte.
6. Le QR code d'un lieu, scanné, ouvre `https://uacmap.bytechnum.com/?ici=<identifiant>`.
7. Télécharger une sauvegarde (Gestionnaire de fichiers, `backups/uac_map`) et la réimporter en local (section 4).

## 3. Mise à jour

Après la fusion d'une version dans `main` :

```bash
~/uac_map/scripts/deployment/updateProduction.sh
```

Le script sauvegarde la base, récupère `main`, installe les dépendances, applique les migrations et redémarre l'application. Il s'arrête à la première erreur. Si le chemin de l'environnement Node diffère de `~/nodevenv/uac_map/24/bin/activate`, le préciser : `NODE_ENVIRONMENT_ACTIVATE=<chemin> ~/uac_map/scripts/deployment/updateProduction.sh`.

## 4. Sauvegardes et restauration

- Les exports sont dans `~/backups/uac_map/`, un par nuit et un avant chaque mise à jour, conservés 14 jours.
- Ils restent sur le même serveur que la base : télécharger le plus récent chaque semaine (Gestionnaire de fichiers).

Restaurer en production (application arrêtée dans Setup Node.js App) :

```bash
gunzip -c ~/backups/uac_map/uac_map-AAAAMMJJ-HHMM.sql.gz | mysql --defaults-file=$HOME/.uac_map.my.cnf <compte>_uacmap
```

Vérifier un export en local (WampServer, MariaDB sur le port 3307) :

```bash
mariadb -h 127.0.0.1 -P 3307 -u root -e "CREATE DATABASE uac_map_restauration CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gunzip -c uac_map-AAAAMMJJ-HHMM.sql.gz | mariadb -h 127.0.0.1 -P 3307 -u root uac_map_restauration
```

## 5. En cas de problème

| Symptôme                                                             | Cause probable                                                  | Action                                                                                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Page d'erreur de l'hébergeur                                         | L'application refuse de démarrer                                | Lire le fichier `stderr.log` à la racine de l'application : il commence par « Démarrage impossible : » suivi de la raison |
| « Variables d'environnement manquantes »                             | `.env` incomplet                                                | Compléter `.env`, puis RESTART                                                                                            |
| « Schéma de la base en retard »                                      | Migrations non appliquées                                       | `npm run database:migrate` dans l'environnement Node, puis RESTART                                                        |
| « Base de données injoignable »                                      | Identifiants ou nom de base erronés                             | Vérifier `DATABASE_*` dans `.env`                                                                                         |
| Tout le monde bloqué après des échecs de connexion                   | `TRUST_PROXY` inadapté                                          | Voir la vérification 4 de la section 2                                                                                    |
| Sauvegarde : « SSL is required, but the server does not support it » | Le client MariaDB exige TLS, le serveur local ne le propose pas | Ajouter une ligne `skip-ssl` dans `~/.uac_map.my.cnf`                                                                     |
