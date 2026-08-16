# Blind Test Party — v2

Jeu de blind test multijoueur : les joueurs proposent des morceaux en
amont, puis devinent **qui a proposé quoi** pendant la soirée.

Cette version 2 apporte les salons multiples, la persistance en base et
la collecte des morceaux par les joueurs eux-mêmes.

> **État : serveur terminé et testé, interfaces à construire.**
> Les 122 tests passent contre un vrai PostgreSQL. Les pages de
> `public/` sont des placeholders, sauf `shared/events.js`.

---

## 1. Prérequis

| Élément | Version | Pourquoi |
|---|---|---|
| Node.js | ≥ 18 | `fetch` natif, utilisé par les tests |
| PostgreSQL | ≥ 14 | `gen_random_uuid()`, index partiels, `FILTER` |

Vérifier :

```bash
node --version      # v18+
psql --version      # 14+
```

---

## 2. Installation locale

### 2.1 — Dépendances

```bash
npm install
```

Quatre paquets seulement, plus un de développement :

| Paquet | Rôle |
|---|---|
| `express` | routes HTTP |
| `dotenv` | lecture du fichier `.env` |
| `socket.io` | temps réel |
| `pg` | client PostgreSQL |
| `cookie-parser` | session de la porte globale |
| `socket.io-client` *(dev)* | tests temps réel |

Pas d'ORM, pas de bundler, pas d'étape de build. Le code serveur est du
CommonJS, le code client des scripts classiques.

### 2.2 — Base de données

```bash
createdb blindtest
```

Ou depuis `psql` :

```sql
CREATE DATABASE blindtest;
```

Les extensions `pgcrypto` et `unaccent` sont créées par la migration —
inutile de les installer à la main, mais le rôle utilisé doit avoir le
droit de les créer (`SUPERUSER` en local, déjà accordé sur Render).

### 2.3 — Variables d'environnement

Le plus simple : copier `.env.example` en `.env` à la racine. Le serveur
le lit automatiquement, y compris pour les migrations et les tests.

```bash
cp .env.example .env      # puis éditer
```

Les variables définies dans le terminal restent prioritaires sur le
fichier — c'est ce qui permet à Render de fournir `DATABASE_URL` sans
qu'aucun `.env` ne soit déposé.

À défaut de fichier :

```powershell
# PowerShell (Windows) — valable pour la session en cours seulement
$env:DATABASE_URL = "postgres://postgres:motdepasse@127.0.0.1:5432/blindtest"
$env:ADMIN_PASSWORD = "secret"
```

```bash
# bash / zsh
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/blindtest"
export ADMIN_PASSWORD="secret"
```

| Variable | Obligatoire | Effet |
|---|---|---|
| `DATABASE_URL` | **oui** | Le serveur refuse de démarrer sans base joignable |
| `ADMIN_PASSWORD` | non | Sans elle, `/admin` — qui **supprime** toutes les soirées — est ouverte à tous |
| `PORT` | non | 3000 par défaut |
| `NODE_ENV` | non | `production` active le cookie `secure` (exige HTTPS) |

### 2.4 — Migration et démarrage

```bash
npm run migrate          # applique db/*.sql
npm run migrate:status   # état sans rien écrire
npm start
```

Le serveur refuse de démarrer si une migration est en attente, et
indique laquelle — plutôt que de laisser la première requête concernée
échouer en pleine utilisation.

Si `migrate` signale une migration « modifiée après application » alors
que la base est correcte (fins de ligne converties, commentaire
retouché), resynchronise les empreintes sans rejouer de SQL :

```bash
npm run migrate:repair
```

Une migration déjà appliquée ne se modifie jamais : on en ajoute une
nouvelle. La réparation ne sert qu'aux différences cosmétiques.

---

## 3. Vérifier que tout fonctionne

```bash
createdb blindtest_test
DATABASE_URL="postgres://postgres@127.0.0.1:5432/blindtest_test" npm run migrate
DATABASE_URL="postgres://postgres@127.0.0.1:5432/blindtest_test" npm test
```

Attendu : **122 OK, 0 échec**.

| Suite | Tests | Couvre |
|---|---|---|
| `lifecycle` | 31 | soirées, participants, paniers, verrouillage, manifeste |
| `session` | 35 | salon, manches, votes, scores, reprise après plantage |
| `realtime` | 21 | automatismes, minuteurs, déconnexions (vrais sockets) |
| `http` | 35 | routes, authentification, parcours complets |

Les tests écrivent réellement en base : **utiliser une base dédiée**,
jamais celle de production.

---

## 4. Arborescence

```
blindtest-party/
├── package.json
├── db/
│   └── 001_schema.sql          Schéma complet (tables, vues, contraintes)
│
├── server/
│   ├── server.js               Point d'entrée : routes, pages, WebSocket
│   ├── rooms.js                Le salon — projection RAM de la base
│   ├── socket-handlers.js      Protocole temps réel et automatismes
│   │
│   ├── db/
│   │   ├── index.js            Pool, query/one/many/tx
│   │   └── migrate.js          Runner de migrations
│   │
│   ├── lib/
│   │   ├── identity.js         Codes, jetons, normalisation des pseudos
│   │   ├── auth.js             Les trois régimes d'authentification
│   │   └── room-timers.js      Temporisations nommées par salon
│   │
│   ├── repos/
│   │   ├── party.repo.js       Soirées, transitions, verrouillage
│   │   ├── participant.repo.js Création, revendication, jetons
│   │   ├── track.repo.js       Paniers, doublons, manifeste, vérification
│   │   └── session.repo.js     Sessions, manches, votes, scores
│   │
│   └── test/
│       ├── lifecycle.test.js
│       ├── session.test.js
│       ├── realtime.test.js
│       └── http.test.js
│
├── public/
│   ├── shared/events.js        Contrat WebSocket (serveur ET client)
│   ├── home/                   Accueil        — À FAIRE
│   ├── login/                  Porte globale  — À FAIRE
│   ├── host/                   Console hôte   — À FAIRE
│   ├── player/                 Espace joueur  — À FAIRE
│   ├── prepare/                Vérification   — À FAIRE
│   └── admin/                  Supervision    — À FAIRE
│
├── docs/
│   ├── ECRANS.md               Inventaire des 22 écrans et transitions
│   └── TOUR-RESILIENCE.md      Protocole de tour, cas de déconnexion
│
└── _archive/phase1-client/     Modules clients de la v1 — NE PAS UTILISER
```

---

## 5. Modèle en deux couches

| | Soirée | Salon |
|---|---|---|
| Durée de vie | semaines | heures |
| Stockage | PostgreSQL | RAM |
| Contient | participants, morceaux, scores | sockets, votes en cours, écran |
| Purge | archivage à 90 jours | TTL de 3 h |

Une soirée traverse `collecte → verrouillee → prete → terminee →
archivee`. Depuis l'état `prete`, elle engendre un salon, qui la ramène
en `terminee` à sa fermeture.

Le salon est **hydraté** depuis la base à l'ouverture et n'y écrit qu'à
deux moments : le reveal (les votes) et la validation du scoring (les
deltas de points). Aucune écriture dans le chemin critique du jeu.

---

## 6. Les trois secrets

Ne jamais les confondre — c'est la faille la plus facile à introduire.

| Secret | Détenu par | Prouve | Transmis |
|---|---|---|---|
| `hostToken` | le **PC** de l'hôte | la propriété d'une soirée | en-tête `X-Host-Token` |
| `participantToken` | le **téléphone** | une identité de joueur | en-tête `X-Participant-Token` |
| `ADMIN_PASSWORD` | l'exploitant du serveur | l'accès à `/admin` | cookie signé |

**Il n'y a pas de mot de passe « hôte ».** Un secret unique partagé
entre tous ceux qui animent une soirée ne protégerait rien : chaque
soirée est protégée par son propre `hostToken`, généré à sa création et
connu du seul navigateur qui l'a créée. Créer une soirée est donc
ouvert ; c'est le jeton rendu à la création qui la protège ensuite.

`ADMIN_PASSWORD` reste nécessaire parce que `/admin` voit et supprime
**toutes** les soirées — un pouvoir qui ne peut pas dépendre d'un jeton
détenu par un seul navigateur.

Les deux jetons sont stockés **hachés** : une fuite de la base ne donne
ni la console ni les paniers. Ils ne sont lisibles en clair qu'une seule
fois, à leur création — le client doit les persister immédiatement.

Le `code` de soirée, lui, est **public** : il ne prouve rien et se dicte
à voix haute sans risque.

L'hôte utilise deux appareils avec deux rôles disjoints : son PC pilote
la partie, son téléphone joue comme n'importe quel participant. Il n'y
a donc aucun cas particulier « joueur hôte » dans le code.

---

## 7. API

### Console hôte — `/api/host` *(cookie + `X-Host-Token`)*

| Méthode | Route | Effet |
|---|---|---|
| POST | `/parties` | Crée une soirée → renvoie le `hostToken` **une seule fois** |
| GET | `/parties/:code` | Console : participants, complétion, session |
| PATCH | `/parties/:code/state` | Transition d'état |
| POST | `/parties/:code/participants` | Ajoute un nom (409 + suggestions si pris) |
| PATCH·DELETE | `…/participants/:id` | Renomme, supprime |
| POST | `…/participants/:id/release` | Libère une revendication |
| GET | `/parties/:code/duplicates` | Doublons à arbitrer |
| POST | `…/tracks/:id/exclude`·`restore` | Arbitrage |
| POST | `/parties/:code/lock`·`unlock` | Verrouille et numérote |
| GET | `/parties/:code/manifest` | Liste numérotée (`?format=csv`) |
| POST | `/parties/:code/reconcile` | Confronte le dossier au manifeste |
| GET | `/parties/:code/sessions` | Classements |

### Participant — `/api` *(`X-Participant-Token`, sauf `/join/*`)*

| Méthode | Route | Effet |
|---|---|---|
| GET | `/join/:code` | Liste des noms (publique) |
| POST | `/join/:code/claim/:id` | Revendique → renvoie le jeton |
| POST | `/join/:code/register` | Auto-inscription (si autorisée) |
| GET | `/me` | **Résolveur** : dit quel écran afficher |
| GET·POST | `/me/tracks` | Panier |
| DELETE | `/me/tracks/:id` | Retire un morceau |
| GET | `/me/results` | Classement final |

### Admin — `/api/admin` *(cookie)*

`GET /overview`, `GET /parties/:code`, `POST /parties/:code/close-room`,
`POST /parties/:code/archive`, `POST /maintenance/sweep`.

---

## 8. Déploiement (Render)

1. Créer un service **PostgreSQL** — `DATABASE_URL` est fourni
   automatiquement au service web lié.
2. Créer le service **Web** : `npm install` en build,
   `npm run migrate && npm start` en démarrage.
3. Définir `ADMIN_PASSWORD` et `NODE_ENV=production`.

Le filesystem de Render est éphémère — c'est précisément pourquoi tout
ce qui doit durer est en base et non dans un fichier.

`/health` renvoie 503 si la base ne répond pas, ce qui permet à Render
de détecter une instance dégradée.

---

## 9. Réseau local

Sur un téléphone, `localhost` désigne le téléphone. Il faut l'IP du PC :

```bash
ipconfig                     # Windows → « Adresse IPv4 »
ipconfig getifaddr en0       # macOS
hostname -I | awk '{print $1}'   # Linux
```

Puis ouvrir `http://192.168.x.x:3000`. **Ouvrir aussi la console hôte
par cette IP**, pas par `localhost` : les liens et QR codes générés
reprennent l'origine de la page.

Deux pièges classiques : le pare-feu bloque le port au premier
lancement, et `http://192.168.x.x` n'étant pas un contexte sécurisé,
`navigator.clipboard` y est indisponible (un repli manuel est prévu).

---

## 10. Reste à faire

1. **Espace participant** (`public/player`) — panier et recherche. C'est
   l'écran que tous verront ; il décide du taux de complétion.
2. **Console hôte** (`public/host`) — création, participants,
   complétion, arbitrage, manifeste, vérification.
3. **Écrans de jeu** — existent en v1, à porter du pseudo vers le jeton.
4. **Recherche multi-sources** — Spotify, iTunes, MusicBrainz.
5. **Accueil, login, admin.**

Voir `docs/ECRANS.md` pour l'inventaire détaillé et les transitions.
