/**
 * ════════════════════════════════════════════════════════════════
 *  SERVEUR BLIND TEST PARTY — phase 2
 * ════════════════════════════════════════════════════════════════
 *
 *  PAGES
 *    /                 accueil : créer / rejoindre / reprendre
 *    /login            accès administration (si ADMIN_PASSWORD défini)
 *    /h                console hôte (PC)
 *    /h/:code          console d'une soirée
 *    /admin            supervision                 — protégée
 *    /j/:code          choisir son nom dans la liste
 *    /p/:code/:token   espace participant (lien magique)
 *    /r/:code          entrée joueur par QR
 *
 *  API
 *    /api/host/*       console hôte      (X-Host-Token)
 *    /api/*            participant       (X-Participant-Token)
 *    /api/admin/*      supervision       (ADMIN_PASSWORD)
 *
 *  Les pages ne portent AUCUN secret. Les jetons circulent en en-tête,
 *  jamais en query string : une URL finit dans les logs, l'historique
 *  et l'en-tête Referer. Le lien magique fait exception par nécessité —
 *  c'est le prix de l'absence de mot de passe — d'où le noindex posé
 *  sur ces pages.
 * ════════════════════════════════════════════════════════════════
 */

const express      = require('express');
const http         = require('http');
const path         = require('path');
const cookieParser = require('cookie-parser');
const { Server }   = require('socket.io');

const db     = require('./db');
const Rooms  = require('./rooms');
const auth   = require('./lib/auth');
const registerHandlers = require('./socket-handlers');
const notify           = require('./lib/notify');

const hostRoutes   = require('./routes/host.routes');
const playerRoutes = require('./routes/player.routes');
const adminRoutes  = require('./routes/admin.routes');
const searchRoutes = require('./routes/search.routes');

const PORT   = process.env.PORT || 3000;

/**
 * Origine publique du service, pour le contrôle CORS en production.
 * Render fournit RENDER_EXTERNAL_URL automatiquement ; APP_ORIGIN
 * permet de la surcharger sur un autre hébergeur.
 */
const PUBLIC_ORIGIN = (process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || '')
  .replace(/\/$/, '');
const PUBLIC = path.join(__dirname, '..', 'public');

const app    = express();
const server = http.createServer(app);
/**
 * CORS des WebSocket.
 *
 * En développement on accepte tout : l'hôte ouvre sa console sur
 * localhost pendant que les téléphones passent par l'IP locale, deux
 * origines différentes pour le même serveur.
 *
 * En production, les clients sont servis par ce serveur : aucune autre
 * origine n'a de raison légitime d'ouvrir un socket. Restreindre évite
 * qu'un site tiers pilote un salon depuis le navigateur d'un visiteur.
 */
const io     = new Server(server, {
  cors: process.env.NODE_ENV === 'production'
    ? { origin: (origin, cb) => cb(null, !origin || origin === PUBLIC_ORIGIN), credentials: true }
    : { origin: '*' },
  // Détection des sockets morts. Les valeurs par défaut (25 s + 20 s)
  // laissent un fantôme occuper une place près de 45 s — bien au-delà
  // du sursis de 10 s sur lequel reposent les décomptes.
  pingInterval: 8000,
  pingTimeout:  10000,
});

app.set('trust proxy', 1);
app.set('port', PORT);            // Render / reverse proxy
// 4 Mo : une vignette de pochette pèse ~30 Ko, et un appariement peut
// en porter plusieurs dizaines d'un coup.
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// ─── Porte globale ─────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (!auth.ADMIN_PASSWORD) return res.redirect('/');
  if (auth.verifySessionToken(req.cookies.host_session)) {
    return res.redirect(safeNext(req.query.next));
  }
  res.sendFile(path.join(PUBLIC, 'login', 'index.html'));
});

app.post('/login', (req, res) => {
  if (!auth.ADMIN_PASSWORD) return res.redirect('/');
  const target = safeNext(req.body.next);

  if (req.body.password !== auth.ADMIN_PASSWORD) {
    return res.redirect('/login?error=1&next=' + encodeURIComponent(target));
  }
  res.cookie('host_session', auth.makeSessionToken('admin'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: auth.SESSION_DURATION_MS,
  });
  res.redirect(target);
});

app.post('/logout', (req, res) => {
  res.clearCookie('host_session');
  res.redirect('/login');
});

/** Empêche une redirection ouverte via ?next=https://ailleurs. */
function safeNext(value) {
  const v = String(value || '/');
  return v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

// ─── API ───────────────────────────────────────────────────────

app.use('/api/host',  hostRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api',       searchRoutes);
app.use('/api',       playerRoutes);

// ─── Pages ─────────────────────────────────────────────────────

const page = (dir) => (req, res) => res.sendFile(path.join(PUBLIC, dir, 'index.html'));

app.get('/', page('home'));

// Pages hôte OUVERTES : la console ne montre rien sans le hostToken
// que le navigateur détient, et l'API le vérifie à chaque requête.
app.get('/h',        page('host'));
app.get('/h/:code',  page('host'));
// Console de jeu : plus spécifique que /h/:code, donc déclarée après —
// Express retient la première route qui correspond, et /h/:code ne
// capture pas un second segment.
app.get('/h/:code/play', page('play'));
// /prepare a été supprimée : la vérification des fichiers se fait dans
// la console, et la page ne servait plus qu'un placeholder en production.
app.get('/admin',    auth.requireAdminPage, page('admin'));

/**
 * Pages participant. Aucune validation du code ni du jeton ici : le
 * serveur HTTP ne doit pas révéler quels codes existent. La
 * vérification se fait par l'API une fois la page chargée.
 */
const noIndex = (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
};

app.get('/j/:code',        page('player'));
app.get('/r/:code',        page('player'));
app.get('/p/:code/:token', noIndex, page('player'));
app.get('/player',         page('player'));

// ─── Statique ──────────────────────────────────────────────────

for (const dir of ['shared', 'home', 'host', 'play', 'player', 'admin', 'login']) {
  app.use(`/${dir}`, express.static(path.join(PUBLIC, dir)));
}

// ─── Santé ─────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const dbOk = await db.ping().catch(() => false);
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    db: dbOk,
    ...Rooms.stats(),
  });
});

// ─── Erreurs ───────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Route inconnue.' }));

app.use((err, req, res, _next) => {
  // Les erreurs de contrainte remontent avec un code PostgreSQL : on
  // les traduit plutôt que de renvoyer un 500 opaque.
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Cette valeur existe déjà.' });
  }
  if (err.code === '22P02' || err.code === '23514') {
    return res.status(400).json({ error: 'Donnée invalide.' });
  }
  console.error('[http]', err.stack || err.message);
  res.status(500).json({ error: 'Erreur serveur.' });
});

// ─── WebSocket ─────────────────────────────────────────────────

notify.attach(io);

io.on('connection', (socket) => {
  registerHandlers(io, socket);
});

// ─── Démarrage ─────────────────────────────────────────────────

async function start() {
  // Refuser de démarrer sans base plutôt que d'accepter des requêtes
  // qui échoueront toutes une par une.
  const dbOk = await db.ping().catch(() => false);
  if (!dbOk) {
    console.error('[boot] Base inaccessible. Vérifie DATABASE_URL.');
    process.exit(1);
  }

  // Une migration en retard ne se manifeste sinon qu'à la première
  // requête concernée, sous la forme d'un « la colonne X n'existe
  // pas » en pleine utilisation. Autant le dire tout de suite, avec
  // la commande à taper.
  try {
    const pending = (await require('./db/migrate').status())
      .filter(m => m.state !== 'appliquée');
    if (pending.length) {
      console.error(
        `\n[boot] ${pending.length} migration(s) en attente :\n` +
        pending.map(m => `         ${m.state.padEnd(22)} ${m.name}`).join('\n') +
        '\n\n       Lance : npm run migrate\n'
      );
      process.exit(1);
    }
  } catch (err) {
    console.warn('[boot] Impossible de vérifier les migrations :', err.message);
  }

  // Un défaut de configuration silencieux est pire qu'une erreur : sans
  // ADMIN_PASSWORD, quiconque anime une partie peut supprimer toutes
  // les soirées. On le dit fort.
  if (!auth.ADMIN_PASSWORD) {
    console.warn(
      '\n⚠  ADMIN_PASSWORD non défini : /admin s\'ouvre SANS MOT DE PASSE.\n' +
      '   Cette page voit et supprime toutes les soirées du serveur.\n' +
      '   Ajoute ADMIN_PASSWORD=… dans ton fichier .env, puis redémarre.\n'
    );
  }

  Rooms.startSweeper();

  server.listen(PORT, () => {
    const adminGate = auth.ADMIN_PASSWORD ? 'mot de passe actif' : 'SANS PROTECTION';
    // Largeur intérieure fixe : le padEnd des lignes précédentes se
    // décalait dès que le numéro de port changeait de longueur.
    const W = 44;
    const line = (s) => '║ ' + s.padEnd(W - 2) + '║';
    console.log('╔' + '═'.repeat(W) + '╗');
    // Pas d'émoji ici : sa largeur d'affichage varie d'un terminal à
    // l'autre (une ou deux colonnes), et aucun calcul de remplissage
    // n'est alors correct partout.
    console.log(line('BLIND TEST PARTY'));
    console.log(line(''));
    console.log(line(`Accueil   http://localhost:${PORT}`));
    console.log(line(`Console   http://localhost:${PORT}/h`));
    console.log(line(`Admin     ${adminGate}`));
    console.log('╚' + '═'.repeat(W) + '╝');
  });
}

/** Arrêt propre : Render envoie SIGTERM avant de tuer le process. */
function shutdown(signal) {
  console.log(`\n[boot] ${signal} — arrêt en cours…`);
  Rooms.stopSweeper();
  io.close();
  server.close(() => {
    db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

if (require.main === module) start();

module.exports = { app, server, io, start };
