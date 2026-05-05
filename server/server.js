/**
 * ════════════════════════════════════════════════════════════════
 *  SERVEUR BLIND TEST PARTY
 * ════════════════════════════════════════════════════════════════
 *
 *  Routes :
 *    GET /             → vue Host (protégée si HOST_PASSWORD défini)
 *    GET /login        → page de login Host
 *    POST /login       → validation du mot de passe
 *    POST /logout      → déconnexion Host
 *    GET /player       → vue Joueur (jamais protégée)
 *    GET /prepare      → outil de préparation (protégé comme le Host)
 *    GET /health       → healthcheck Render
 *    WS  /             → WebSocket Socket.io
 *
 *  Sécurité Host :
 *    Si HOST_PASSWORD est défini dans les variables d'environnement,
 *    l'accès à / et /prepare requiert un cookie de session valide.
 *    Si HOST_PASSWORD n'est PAS défini, aucune protection (mode local).
 *
 *    Test en local :
 *      HOST_PASSWORD=monmotdepasse npm start
 *
 *    Sur Render :
 *      Dashboard → ton service → Environment → Add Environment Variable
 *      Key: HOST_PASSWORD  Value: ton_mot_de_passe
 * ════════════════════════════════════════════════════════════════
 */

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');

const gameState        = require('./game-state');
const registerHandlers = require('./socket-handlers');

const PORT          = process.env.PORT          || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || null;

// Secret aléatoire pour signer les tokens — regénéré à chaque boot du serveur
// (invalide les sessions existantes, acceptable pour cet usage)
const SESSION_SECRET      = crypto.randomBytes(32).toString('hex');
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;  // 12h

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

// ─── Auth helpers ──────────────────────────────────────────────

function makeSessionToken() {
  const expires = Date.now() + SESSION_DURATION_MS;
  const payload = `host:${expires}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

function verifySessionToken(token) {
  if (!token) return false;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf8');
    const lastColon = raw.lastIndexOf(':');
    const payload = raw.slice(0, lastColon);
    const sig     = raw.slice(lastColon + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (sig !== expected) return false;
    const expires = parseInt(payload.split(':')[1], 10);
    return Date.now() < expires;
  } catch {
    return false;
  }
}

function requireHostAuth(req, res, next) {
  if (!HOST_PASSWORD) return next();
  if (verifySessionToken(req.cookies['host_session'])) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// ─── Page de login ─────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (!HOST_PASSWORD) return res.redirect('/');
  if (verifySessionToken(req.cookies['host_session'])) {
    return res.redirect(req.query.next || '/');
  }

  const error   = req.query.error === '1' ? '<p class="error">Mot de passe incorrect.</p>' : '';
  const nextUrl = req.query.next || '/';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Blind Test — Accès Host</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Outfit:wght@400;600&display=swap');
    :root{--bg:#080b10;--surface:#0f141c;--border:#1e2a3a;--accent:#00e5ff;--accent2:#ff6b6b;--text:#e8f0fe;--muted:#5a7080}
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:'Outfit',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:2.5rem 2rem;width:340px;box-shadow:0 30px 80px rgba(0,0,0,.7)}
    .logo{font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:.15em;color:var(--accent);text-shadow:0 0 20px rgba(0,229,255,.4);margin-bottom:.25rem}
    .logo span{color:var(--text)}
    .subtitle{font-size:.7rem;letter-spacing:.25em;color:var(--muted);text-transform:uppercase;margin-bottom:2rem}
    label{display:block;font-size:.65rem;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin-bottom:.35rem}
    input[type=password]{width:100%;background:#161d28;border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:'Outfit',sans-serif;font-size:1rem;padding:.65rem .9rem;outline:none;transition:border-color .2s;margin-bottom:1.25rem}
    input[type=password]:focus{border-color:var(--accent)}
    button{width:100%;background:var(--accent);border:none;border-radius:8px;color:#080b10;font-family:'Outfit',sans-serif;font-size:.95rem;font-weight:600;padding:.75rem;cursor:pointer;transition:background .18s}
    button:hover{background:#33eaff}
    .error{color:var(--accent2);font-size:.82rem;margin-bottom:1rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Blind<span>Test</span></div>
    <div class="subtitle">Accès présentateur</div>
    ${error}
    <form method="POST" action="/login">
      <input type="hidden" name="next" value="${nextUrl}"/>
      <label for="pwd">Mot de passe</label>
      <input type="password" id="pwd" name="password" autofocus autocomplete="current-password"/>
      <button type="submit">Entrer</button>
    </form>
  </div>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  if (!HOST_PASSWORD) return res.redirect('/');
  const { password, next } = req.body;
  const target = (next && next.startsWith('/')) ? next : '/';

  if (password !== HOST_PASSWORD) {
    return res.redirect('/login?error=1&next=' + encodeURIComponent(target));
  }

  const token = makeSessionToken();
  res.cookie('host_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   SESSION_DURATION_MS,
  });
  res.redirect(target);
});

app.post('/logout', (req, res) => {
  res.clearCookie('host_session');
  res.redirect('/login');
});

// ─── Routes principales ────────────────────────────────────────

app.get('/', requireHostAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'host', 'index.html'));
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player', 'index.html'));
});

app.get('/prepare', requireHostAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'prepare', 'index.html'));
});

// ─── Fichiers statiques ───────────────────────────────────────

app.use('/shared',  express.static(path.join(__dirname, '..', 'public', 'shared')));
app.use('/host',    express.static(path.join(__dirname, '..', 'public', 'host')));
app.use('/player',  express.static(path.join(__dirname, '..', 'public', 'player')));
app.use('/prepare', express.static(path.join(__dirname, '..', 'public', 'prepare')));

// ─── Healthcheck ──────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── WebSocket ────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Connexion : ${socket.id}`);
  registerHandlers(io, socket, gameState);

  socket.on('disconnect', () => {
    console.log(`[-] Déconnexion : ${socket.id}`);
    gameState.markDisconnected(socket.id);
    io.emit(require('../public/shared/events').STATE_PLAYERS, gameState.publicPlayers());
  });
});

server.listen(PORT, () => {
  const authMode = HOST_PASSWORD
    ? '🔒 Mot de passe actif'
    : '🔓 Sans protection (HOST_PASSWORD non défini)';
  console.log(`╔═══════════════════════════════════════════╗`);
  console.log(`║  🎵 Blind Test Party — server up          ║`);
  console.log(`║  Host    :  http://localhost:${PORT}         ║`);
  console.log(`║  Player  :  http://localhost:${PORT}/player  ║`);
  console.log(`║  Auth    :  ${authMode.padEnd(29)} ║`);
  console.log(`╚═══════════════════════════════════════════╝`);
});
