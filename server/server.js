/**
 * ════════════════════════════════════════════════════════════════
 *  SERVEUR BLIND TEST PARTY
 * ════════════════════════════════════════════════════════════════
 *
 *  Express sert les fichiers statiques (host + player + shared).
 *  Socket.io gère la communication temps réel.
 *
 *  Routes :
 *    GET /         → vue Host (interface du présentateur)
 *    GET /player   → vue Joueur (interface mobile)
 *    GET /shared/* → fichiers partagés (events.js, utils.js)
 *    WS  /         → WebSocket Socket.io
 * ════════════════════════════════════════════════════════════════
 */

const express     = require('express');
const http        = require('http');
const { Server }  = require('socket.io');
const path        = require('path');

const gameState        = require('./game-state');
const registerHandlers = require('./socket-handlers');

const PORT = process.env.PORT || 3000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }, // dev — durcir pour la prod si besoin
});

// ─── Routes principales (déclarées AVANT les statics pour garantir le 200) ───
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'host', 'index.html'));
});

app.get('/player', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player', 'index.html'));
});

app.get('/prepare', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'prepare', 'index.html'));
});

// ─── Fichiers statiques ───
app.use('/shared',  express.static(path.join(__dirname, '..', 'public', 'shared')));
app.use('/host',    express.static(path.join(__dirname, '..', 'public', 'host')));
app.use('/player',  express.static(path.join(__dirname, '..', 'public', 'player')));
app.use('/prepare', express.static(path.join(__dirname, '..', 'public', 'prepare')));

// ─── Healthcheck (utile pour Render) ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── WebSocket : on délègue aux handlers ───
io.on('connection', (socket) => {
  console.log(`[+] Connexion : ${socket.id}`);
  registerHandlers(io, socket, gameState);

  socket.on('disconnect', () => {
    console.log(`[-] Déconnexion : ${socket.id}`);
    gameState.markDisconnected(socket.id);
    // Notifier les autres clients
    io.emit(require('../public/shared/events').STATE_PLAYERS, gameState.publicPlayers());
  });
});

server.listen(PORT, () => {
  console.log(`╔═══════════════════════════════════════╗`);
  console.log(`║  🎵 Blind Test Party — server up      ║`);
  console.log(`║  Host    :  http://localhost:${PORT}     ║`);
  console.log(`║  Player  :  http://localhost:${PORT}/player  ║`);
  console.log(`╚═══════════════════════════════════════╝`);
});
