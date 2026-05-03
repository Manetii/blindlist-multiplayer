/**
 * ════════════════════════════════════════════════════════════════
 *  HANDLERS SOCKET.IO
 * ════════════════════════════════════════════════════════════════
 *
 *  Implémente le contrat d'événements défini dans
 *  public/shared/events.js. Une fonction = un événement.
 *
 *  Convention de réponse :
 *    - Les events HOST_* ne sont acceptés que si le socket est
 *      identifié comme Host (via HOST_HELLO préalable).
 *    - Les events PLAYER_* sont acceptés si le socket est lié
 *      à un pseudo via PLAYER_JOIN.
 * ════════════════════════════════════════════════════════════════
 */

const EVENTS = require('../public/shared/events');

function registerHandlers(io, socket, gs) {

  // ═══════════════════════════════════════════════════════════
  //  HOST → SERVEUR
  // ═══════════════════════════════════════════════════════════

  /** Le Host se déclare. Premier event qu'il envoie. */
  socket.on(EVENTS.HOST_HELLO, () => {
    gs.setHost(socket.id);
    console.log(`[host] Host enregistré : ${socket.id}`);
    socket.emit(EVENTS.STATE_FULL, gs.fullState());
  });

  /** Le Host pousse la liste à jour des joueurs (création/suppression). */
  socket.on(EVENTS.HOST_PLAYERS_UPDATE, (players) => {
    if (!gs.isHost(socket.id)) return;
    gs.syncPlayersFromHost(players);
    io.emit(EVENTS.STATE_PLAYERS, gs.publicPlayers());
  });

  /** Le Host lance un morceau — les joueurs reçoivent l'écran de vote. */
  socket.on(EVENTS.HOST_TRACK_START, ({ trackId }) => {
    if (!gs.isHost(socket.id)) return;
    gs.startRound(trackId);
    io.emit(EVENTS.STATE_ROUND_START, { trackId });
    console.log(`[round] Manche démarrée — track ${trackId}`);
  });

  /** Le Host révèle la réponse — title, artist, player, art (URL ou base64). */
  socket.on(EVENTS.HOST_TRACK_REVEAL, (answer) => {
    if (!gs.isHost(socket.id)) return;
    gs.revealAnswer(answer);
    io.emit(EVENTS.STATE_REVEAL, {
      answer,
      votes: gs.publicVotes(),
    });
    console.log(`[round] Reveal : "${answer.title}" — ${answer.player} (${gs.publicVotes().length} votes)`);
  });

  /** Le Host attribue +1 à un joueur (legacy). */
  socket.on(EVENTS.HOST_AWARD_POINT, ({ pseudo }) => {
    if (!gs.isHost(socket.id)) return;
    gs.awardPoint(pseudo);
    io.emit(EVENTS.STATE_SCORES, gs.publicPlayers());
  });

  /** Applique un batch de points (nouveau scoring multi-joueurs).
   *  payload = { points: { "Alice": 1, "Bob": 2, ... } } */
  socket.on(EVENTS.HOST_APPLY_SCORES, ({ points }) => {
    if (!gs.isHost(socket.id)) return;
    if (!points || typeof points !== 'object') return;
    for (const [pseudo, n] of Object.entries(points)) {
      if (typeof n !== 'number' || n === 0) continue;
      const p = gs._state.players.get(pseudo);
      if (p) p.score = Math.max(0, p.score + n);
    }
    io.emit(EVENTS.STATE_SCORES, gs.publicPlayers());
    console.log(`[round] Scores appliqués :`, points);
  });

  /** Reset tous les scores à 0. */
  socket.on(EVENTS.HOST_RESET_SCORES, () => {
    if (!gs.isHost(socket.id)) return;
    for (const p of gs._state.players.values()) p.score = 0;
    io.emit(EVENTS.STATE_SCORES, gs.publicPlayers());
    console.log(`[match] Scores réinitialisés`);
  });

  /** Passage à la manche suivante (reset de l'état du round). */
  socket.on(EVENTS.HOST_NEXT_ROUND, () => {
    if (!gs.isHost(socket.id)) return;
    gs._state.round = {
      active:   false,
      revealed: false,
      trackId:  null,
      votes:    new Map(),
      answer:   null,
    };
    io.emit(EVENTS.STATE_ROUND_START, { trackId: null, reset: true });
  });

  // ═══════════════════════════════════════════════════════════
  //  JOUEUR → SERVEUR
  // ═══════════════════════════════════════════════════════════

  /** Un joueur quitte volontairement (= libère son pseudo).
   *  Ne supprime pas le joueur de la liste : seulement le slot connecté.
   *  Le Host pourra réutiliser le même pseudo, et un autre appareil pourra
   *  prendre le relais. Sert au bouton "Changer de pseudo" côté joueur. */
  socket.on(EVENTS.PLAYER_LEAVE, () => {
    const p = gs.playerBySocket(socket.id);
    if (!p) return;
    // Marque le slot comme libre (mais garde le joueur dans la liste)
    p.connected = false;
    p.socketId  = null;
    io.emit(EVENTS.STATE_PLAYERS, gs.publicPlayers());
    console.log(`[player] ${p.name} a quitté volontairement (slot libéré)`);
  });

  /** Un joueur rejoint avec un pseudo. */
  socket.on(EVENTS.PLAYER_JOIN, ({ pseudo }, ack) => {
    const result = gs.joinPlayer(socket.id, pseudo);
    if (!result.ok) {
      if (typeof ack === 'function') ack({ ok: false, error: result.reason });
      return;
    }
    if (typeof ack === 'function') {
      ack({ ok: true, reconnected: result.reconnected, state: gs.fullState() });
    }
    // Notifier tout le monde de la liste mise à jour (statut "connecté")
    io.emit(EVENTS.STATE_PLAYERS, gs.publicPlayers());
    console.log(`[player] ${pseudo} ${result.reconnected ? 'reconnecté' : 'rejoint'}`);
  });

  /** Un joueur vote pour un autre. */
  socket.on(EVENTS.PLAYER_VOTE, ({ votedPseudo }) => {
    const voter = gs.playerBySocket(socket.id);
    if (!voter) return;
    if (!gs.recordVote(voter.name, votedPseudo)) return;

    // Le Host voit en direct qui a voté pour qui
    if (gs._state.hostSocketId) {
      io.to(gs._state.hostSocketId).emit(EVENTS.STATE_VOTE_RECEIVED, {
        voter:        voter.name,
        votedPseudo,
        totalVotes:   gs._state.round.votes.size,
      });
    }
    console.log(`[vote] ${voter.name} → ${votedPseudo}`);
  });
}

module.exports = registerHandlers;
