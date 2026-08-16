/**
 * ════════════════════════════════════════════════════════════════
 *  HANDLERS SOCKET.IO — phase 2
 * ════════════════════════════════════════════════════════════════
 *
 *  Implémente le contrat de public/shared/events.js et le protocole de
 *  TOUR-RESILIENCE.md.
 *
 *  INVARIANTS
 *  ----------
 *  1. Aucun io.emit() global. Toute diffusion passe par
 *     io.to(room.code) — un salon ne voit jamais un autre.
 *
 *  2. L'identité vient d'un JETON, jamais d'un pseudo. Le PC présente
 *     le hostToken de la soirée, le téléphone le token du participant.
 *
 *  3. LE SERVEUR NE LANCE JAMAIS UN MORCEAU. L'audio est sur le PC.
 *     Quand un automatisme mûrit, on émet HOST_CUE vers le PC, qui
 *     exécute. Si le PC est absent, le signal est mémorisé et rejoué
 *     à son retour — c'est le seul blocage irréductible du protocole.
 *
 *  4. Tout minuteur passe par lib/room-timers.js, et tout changement
 *     de phase annule les minuteurs de la phase précédente.
 * ════════════════════════════════════════════════════════════════
 */

const EVENTS          = require('../public/shared/events');
const Rooms           = require('./rooms');
const Timers          = require('./lib/room-timers');
const partyRepo       = require('./repos/party.repo');
const notify          = require('./lib/notify');
const participantRepo = require('./repos/participant.repo');
const sessionRepo     = require('./repos/session.repo');

const { DELAYS } = Timers;

// Délai avant de figer les votes d'une manche. Doit dépasser la fenêtre
// de grâce de rooms.js (500 ms) pour laisser arriver les validations
// automatiques déclenchées par l'affichage du reveal.
const REVEAL_SETTLE_MS = 700;

function registerHandlers(io, socket) {

  // ═══════════════════════════════════════════════════════════
  //  RÉSOLUTION & GARDES
  // ═══════════════════════════════════════════════════════════

  const ack = (cb, payload) => { if (typeof cb === 'function') cb(payload); };

  /**
   * Répond à l'accusé de réception même en cas d'échec.
   *
   * Sans cela, une erreur dans un handler laisse le client attendre
   * indéfiniment sa réponse : la console se fige sans message, et rien
   * dans l'interface n'indique que quelque chose a échoué. Le dernier
   * argument d'un émetteur Socket.io est le callback, quand il existe.
   */
  function ackError(args, message) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb({ ok: false, error: message });
  }

  function currentRoom() {
    return socket.data.roomCode ? Rooms.getRoom(socket.data.roomCode) : null;
  }

  function attach(room, role) {
    if (socket.data.roomCode && socket.data.roomCode !== room.code) {
      socket.leave(socket.data.roomCode);
    }
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.role     = role;
  }

  /** N'exécute que si ce socket est le PC propriétaire du salon. */
  function asHost(fn) {
    return (...args) => {
      const room = currentRoom();
      if (!room || !Rooms.isHost(room, socket.id)) {
        return ackError(args, 'Salon introuvable ou droits insuffisants.');
      }
      return Promise.resolve(fn(room, ...args)).catch(err => {
        console.error(`[${room.code}] handler hôte :`, err.message);
        socket.emit(EVENTS.ERROR, err.message);
        ackError(args, err.message);
      });
    };
  }

  /** N'exécute que si ce socket est un joueur identifié du salon. */
  function asPlayer(fn) {
    return (...args) => {
      const room = currentRoom();
      if (!room) return ackError(args, 'Salon introuvable.');
      const player = Rooms.playerBySocket(room, socket.id);
      if (!player) return ackError(args, 'Tu n\'es pas dans ce salon.');
      return Promise.resolve(fn(room, player, ...args)).catch(err => {
        console.error(`[${room.code}] handler joueur :`, err.message);
        ackError(args, err.message);
      });
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  AUTOMATISMES
  // ═══════════════════════════════════════════════════════════

  /**
   * Émet un signal vers le PC. S'il est absent, on le mémorise sur le
   * salon : HOST_OPEN_ROOM le rejouera à la reconnexion. Sans cette
   * mémoire, une coupure de l'hôte au mauvais moment laisserait la
   * manche définitivement en suspens.
   */
  function cueHost(room, action, reason) {
    room.pendingCue = { action, reason, at: Date.now() };
    if (!room.hostSocketId) {
      console.log(`[${room.code}] cue « ${action} » mis en attente (hôte absent)`);
      return false;
    }
    io.to(room.hostSocketId).emit(EVENTS.HOST_CUE, { action, reason });
    return true;
  }

  function clearCue(room) {
    room.pendingCue = null;
  }

  /**
   * Réévalue l'auto-reveal. Appelé après chaque vote, chaque connexion
   * et chaque expiration du délai de grâce d'une déconnexion.
   */
  function evaluateReveal(room) {
    if (!room.round.active || room.round.revealed) return;

    // La progression des votes part au PC dans tous les cas : c'est une
    // information utile même quand l'auto-reveal est désactivé.
    const tally = Rooms.voteTally(room);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit(EVENTS.STATE_VOTE_PROGRESS, {
        voted: tally.voted, connected: tally.connected,
        pending: tally.pending, votes: Rooms.votesAsArray(room),
      });
    }
    if (!room.settings.autoReveal) return;
    if (!tally.complete) {
      Timers.clear(room.code, 'reveal');
      return;
    }
    // Court délai pour que le dernier votant voie sa validation.
    Timers.set(room.code, 'reveal', DELAYS.REVEAL_CUE_MS, () => {
      if (room.round.active && !room.round.revealed) {
        cueHost(room, 'reveal', 'tous les joueurs connectés ont voté');
      }
    });
  }

  /**
   * Réévalue l'auto-advance. Diffuse aussi la progression des « prêt »,
   * qui est une information utile même quand le seuil n'est pas atteint.
   */
  function evaluateAdvance(room) {
    // La progression est diffusée même pendant une manche : les joueurs
    // peuvent se déclarer prêts dès l'écran de révélation, et l'hôte
    // doit le voir arriver.
    const tally = Rooms.readyTally(room);
    io.to(room.code).emit(EVENTS.STATE_READY_PROGRESS, tally);

    if (room.round.active) return;              // pas encore en entracte
    if (!room.settings.autoAdvance) return;

    if (!tally.complete) {
      Timers.clear(room.code, 'advance');
      io.to(room.code).emit(EVENTS.STATE_COUNTDOWN, { seconds: null });
      return;
    }

    // Le décompte n'a de sens qu'AVANT LE PREMIER MORCEAU : il donne le
    // top de départ à une table qui bavarde encore. Entre deux manches,
    // il ne fait que ralentir — tout le monde est déjà attentif, et
    // trois secondes de silence passent pour un blocage.
    const first = room.playedTrackIds.size === 0;
    const delay = first ? DELAYS.ADVANCE_COUNTDOWN_MS : 0;

    if (first) {
      io.to(room.code).emit(EVENTS.STATE_COUNTDOWN, {
        seconds: Math.round(DELAYS.ADVANCE_COUNTDOWN_MS / 1000),
      });
    }

    Timers.set(room.code, 'advance', delay, () => {
      if (!room.round.active) cueHost(room, 'advance', 'tout le monde est prêt');
    });
  }

  /**
   * Ouvre l'entracte : remise à zéro des « prêt » et armement du délai
   * maximal. C'est ce délai qui rend l'interblocage impossible, quel
   * que soit le motif de l'absence.
   */
  function openIntermission(room) {
    Timers.clear(room.code, 'reveal');
    clearCue(room);
    // On NE remet PAS les « prêt » à zéro ici : les joueurs peuvent se
    // déclarer prêts dès l'écran de révélation, sans attendre que
    // l'hôte ait validé les points. Effacer à ce moment leur ferait
    // perdre un geste déjà fait et casserait le rythme.
    // La remise à zéro se fait au démarrage de la manche suivante
    // (Rooms.startRound).

    io.to(room.code).emit(EVENTS.STATE_INTERMISSION, {
      tracksPlayed: room.playedTrackIds.size,
      tracksTotal:  room.tracks.length,
      deadlineMs:   DELAYS.INTERMISSION_MAX_MS,
    });

    Timers.set(room.code, 'intermission', DELAYS.INTERMISSION_MAX_MS, () => {
      if (room.round.active || room.paused) return;
      console.log(`[${room.code}] entracte expiré — passage forcé`);
      cueHost(room, 'advance', 'délai d\'entracte dépassé');
    });

    evaluateAdvance(room);
  }

  /**
   * Réévaluation différée après une déconnexion.
   *
   * Le délai est la moitié utile du dispositif : réagir immédiatement
   * ferait partir la manche au nez d'un joueur dont le WiFi a hoqueté
   * trois secondes. Une reconnexion pendant ce délai annule tout.
   */
  function scheduleRegrade(room) {
    Timers.set(room.code, 'regrade', DELAYS.DISCONNECT_GRACE_MS, () => {
      io.to(room.code).emit(EVENTS.STATE_PLAYERS, Rooms.publicPlayers(room));
      evaluateReveal(room);
      evaluateAdvance(room);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  HOST → SERVEUR
  // ═══════════════════════════════════════════════════════════

  /**
   * Ouvre ou reprend le salon. Point d'entrée unique du PC : il n'y a
   * plus de « création » distincte, la soirée existe déjà en base.
   */
  socket.on(EVENTS.HOST_OPEN_ROOM, async ({ code, hostToken } = {}, cb) => {
    try {
      const party = await partyRepo.authenticateHost(code, hostToken);
      if (!party) return ack(cb, { ok: false, error: 'Soirée introuvable ou jeton invalide.' });
      if (party.state === 'collecte') {
        return ack(cb, { ok: false, error: 'La collecte est encore ouverte — verrouille d\'abord.' });
      }

      const { room, error } = await Rooms.openRoom(party, socket.id);
      if (error) return ack(cb, { ok: false, error });

      attach(room, 'host');

      // Reprise : ce que le serveur sait et que le PC a pu perdre.
      const pending = await sessionRepo.pendingForHost(party.id);

      ack(cb, {
        ok: true,
        state: Rooms.fullState(room),
        tracks: room.tracks,
        pending: {
          action: (room.pendingCue && room.pendingCue.action) || pending.pendingAction,
          round:  pending.round || null,
          votes:  Rooms.votesAsArray(room),
        },
      });

      io.to(room.code).emit(EVENTS.STATE_HOST_STATUS, { online: true });
      // Les participants encore sur l'écran d'attente passent au jeu.
      notify.roomChanged(room.code, true);
      console.log(`[${room.code}] hôte connecté`);
    } catch (err) {
      console.error('[HOST_OPEN_ROOM]', err);
      ack(cb, { ok: false, error: 'Erreur serveur à l\'ouverture du salon.' });
    }
  });

  socket.on(EVENTS.HOST_CLOSE_ROOM, asHost(async (room, _p, cb) => {
    Timers.clearAll(room.code);
    io.to(room.code).emit(EVENTS.STATE_ROOM_CLOSED, { reason: 'Le Host a fermé le salon.' });
    io.in(room.code).socketsLeave(room.code);
    await Rooms.closeRoom(room.code);
    notify.roomChanged(room.code, false);
    socket.data.roomCode = null;
    ack(cb, { ok: true });
  }));

  /** Lance une manche. Sans trackId, tirage parmi les non joués. */
  socket.on(EVENTS.HOST_START_ROUND, asHost(async (room, { trackId } = {}, cb) => {
    Timers.clear(room.code, 'advance');
    Timers.clear(room.code, 'intermission');
    io.to(room.code).emit(EVENTS.STATE_COUNTDOWN, { seconds: null });
    clearCue(room);

    const track = trackId
      ? room.tracks.find(t => t.id === trackId)
      : Rooms.pickNextTrack(room);

    if (!track) {
      // Le salon RESTE OUVERT : on affiche le podium sans déconnecter
      // personne. L'hôte peut revenir au lecteur, rejouer un morceau
      // écarté, ou fermer quand il le décide.
      io.to(room.code).emit(EVENTS.STATE_GAME_OVER, {
        standings: await sessionRepo.standings(room.sessionId),
      });
      return ack(cb, { ok: false, error: 'Playlist épuisée.', gameOver: true });
    }

    // Un morceau ne se joue qu'une fois par session : la contrainte
    // existe en base, mais mieux vaut un refus explicite qu'une erreur
    // SQL remontée jusqu'au client.
    if (room.playedTrackIds.has(track.id)) {
      return ack(cb, { ok: false, error: 'Ce morceau a déjà été joué.', alreadyPlayed: true });
    }

    const started = await Rooms.startRound(room, track.id);
    if (!started.ok) return ack(cb, { ok: false, error: started.reason });

    // Chaque joueur reçoit SA grille : sans lui-même, sans les
    // participants qui n'ont proposé aucun morceau.
    for (const p of Rooms.connectedPlayers(room)) {
      io.to(p.socketId).emit(EVENTS.STATE_ROUND_START, {
        trackId: track.id,
        options: Rooms.voteOptions(room, p.id),
      });
    }

    // Diffuser un décompte remis à zéro : sans cela les clients gardent
    // l'état « prêt » de la manche précédente et le bouton s'affiche
    // déjà coché au reveal suivant.
    evaluateAdvance(room);

    ack(cb, {
      ok: true,
      track,
      startOffsetMs: started.startOffsetMs,
      roundId: started.round.id,
    });
    console.log(`[${room.code}] manche ${started.round.order_no} — ${track.title}`);
  }));

  /** Consigne l'offset réellement joué (avance rapide de l'hôte). */
  socket.on(EVENTS.HOST_SET_OFFSET, asHost(async (room, { ms } = {}) => {
    if (!room.round.roundId || typeof ms !== 'number' || ms < 0) return;
    room.round.startOffsetMs = Math.round(ms);
    await sessionRepo.updateStartOffset(room.round.roundId, room.round.startOffsetMs);
  }));

  socket.on(EVENTS.HOST_REVEAL, asHost(async (room, answer = {}, cb) => {
    if (!room.round.active) return ack(cb, { ok: false, error: 'Aucune manche en cours.' });

    Timers.clear(room.code, 'reveal');
    clearCue(room);

    const votes = Rooms.revealAnswer(room, answer);
    io.to(room.code).emit(EVENTS.STATE_REVEAL, { answer, votes });

    // La fenêtre de grâce laisse arriver les votes auto-validés côté
    // client, envoyés à l'instant même du reveal. Une fois close, on
    // REDIFFUSE la liste complète : sans cela, un joueur qui avait
    // choisi sans valider voyait « tu n'as pas voté », et l'hôte
    // calculait les points sans lui.
    setTimeout(async () => {
      try {
        await Rooms.persistReveal(room);
        const finalVotes = Rooms.votesAsArray(room);
        if (finalVotes.length !== votes.length) {
          io.to(room.code).emit(EVENTS.STATE_REVEAL, { answer, votes: finalVotes, final: true });
          console.log(`[${room.code}] ${finalVotes.length - votes.length} vote(s) rattrapé(s) au reveal`);
        }
      } catch (err) {
        console.error(`[${room.code}] persistance du reveal :`, err.message);
      }
    }, REVEAL_SETTLE_MS);

    ack(cb, { ok: true, votes });
    console.log(`[${room.code}] reveal — ${answer.player} (${votes.length} votes)`);
  }));

  socket.on(EVENTS.HOST_APPLY_SCORES, asHost(async (room, { events } = {}, cb) => {
    if (!Array.isArray(events)) return ack(cb, { ok: false, error: 'Format invalide.' });
    const written = await Rooms.persistScores(room, events);
    io.to(room.code).emit(EVENTS.STATE_SCORES, Rooms.publicPlayers(room));
    ack(cb, { ok: true, written });
    console.log(`[${room.code}] ${written} delta(s) de score écrits`);
  }));

  /** Clôt la manche et ouvre l'entracte. */
  socket.on(EVENTS.HOST_NEXT_ROUND, asHost((room, _p, cb) => {
    Rooms.resetRound(room);
    openIntermission(room);
    ack(cb, { ok: true });
  }));

  /**
   * Repart pour une partie sur la même playlist.
   *
   * Ferme la session en cours et en ouvre une neuve : les morceaux
   * redeviennent jouables et les scores repartent de zéro, sans que
   * personne ait à se reconnecter. C'est ce qui manquait après le
   * dernier morceau — la soirée se terminait sur « plus aucun morceau
   * jouable » alors qu'on voulait enchaîner.
   *
   * La session précédente est CONSERVÉE en base : son classement reste
   * consultable, on n'efface pas une partie pour en commencer une autre.
   */
  socket.on(EVENTS.HOST_NEW_SESSION, asHost(async (room, _p, cb) => {
    const previous = await sessionRepo.standings(room.sessionId);
    await sessionRepo.close(room.sessionId);

    const { session } = await sessionRepo.open(room.partyId);
    room.sessionId = session.id;
    room.playedTrackIds.clear();
    room.round = { active: false, revealed: false, roundId: null, trackId: null,
                   votes: new Map(), answer: null, revealedAt: null, startOffsetMs: null };
    for (const p of room.players.values()) { p.score = 0; p.ready = false; }
    Timers.clearAll(room.code);

    io.to(room.code).emit(EVENTS.STATE_SCORES, Rooms.publicPlayers(room));
    openIntermission(room);
    ack(cb, { ok: true, previousStandings: previous, tracksTotal: room.tracks.length });
    console.log(`[${room.code}] nouvelle partie — session ${session.id}`);
  }));

  socket.on(EVENTS.HOST_PAUSE, asHost((room, { paused } = {}, cb) => {
    Rooms.setPaused(room, paused);
    io.to(room.code).emit(EVENTS.STATE_PAUSED, { paused: room.paused });

    if (room.paused) {
      // La pause gèle l'entracte : le décompte silencieux serait une
      // source de stress inutile pendant une vraie interruption.
      Timers.clear(room.code, 'advance');
      Timers.clear(room.code, 'intermission');
      io.to(room.code).emit(EVENTS.STATE_COUNTDOWN, { seconds: null });
    } else if (!room.round.active) {
      openIntermission(room);
    }
    ack(cb, { ok: true, paused: room.paused });
  }));

  /** Passe outre les « prêt » manquants (quelqu'un aux toilettes). */
  socket.on(EVENTS.HOST_FORCE_ADVANCE, asHost((room, _p, cb) => {
    Timers.clear(room.code, 'advance');
    Timers.clear(room.code, 'intermission');
    cueHost(room, 'advance', 'lancement forcé par l\'hôte');
    ack(cb, { ok: true });
  }));

  // ═══════════════════════════════════════════════════════════
  //  JOUEUR → SERVEUR
  // ═══════════════════════════════════════════════════════════

  /**
   * Abonnement au canal de la soirée.
   *
   * Émis dès le chargement de la page participant, quel que soit
   * l'écran affiché — y compris pendant la collecte, des semaines avant
   * la partie. Ne donne accès à AUCUNE donnée : c'est un simple canal
   * de notification, le client redemande ensuite ce qui le concerne via
   * /api/me. Un jeton valide reste exigé, pour qu'on ne puisse pas
   * écouter une soirée à laquelle on n'appartient pas.
   */
  socket.on(EVENTS.PLAYER_WATCH, async ({ token } = {}, cb) => {
    try {
      const me = await participantRepo.authenticate(token);
      if (!me) return ack(cb, { ok: false });
      socket.join(notify.channel(me.party_code));
      ack(cb, { ok: true, code: me.party_code, state: me.party_state });
    } catch (err) {
      console.error('[PLAYER_WATCH]', err.message);
      ack(cb, { ok: false });
    }
  });

  /**
   * Rejoint le salon avec son jeton de lien magique.
   *
   * Plus de pseudo, donc plus de conflit possible entre deux appareils :
   * l'identité est prouvée, pas déclarée. La reconnexion après coupure
   * n'a plus rien de particulier — c'est un join comme un autre.
   */
  socket.on(EVENTS.PLAYER_JOIN, async ({ token } = {}, cb) => {
    try {
      const me = await participantRepo.authenticate(token);
      if (!me) return ack(cb, { ok: false, error: 'Lien invalide ou expiré.', badToken: true });

      const room = Rooms.getRoom(me.party_code);
      if (!room) {
        return ack(cb, {
          ok: false,
          error: 'La partie n\'a pas encore commencé.',
          partyState: me.party_state,
          noRoom: true,
        });
      }

      const joined = Rooms.joinPlayer(room, me.id, socket.id, me);
      if (!joined.ok) return ack(cb, { ok: false, error: joined.reason });

      // Le socket précédent est un fantôme : on le sort du salon pour
      // qu'il cesse de recevoir les diffusions.
      if (joined.previousSocket && joined.previousSocket !== socket.id) {
        const ghost = io.sockets.sockets.get(joined.previousSocket);
        if (ghost) { ghost.leave(room.code); ghost.data.roomCode = null; }
      }

      attach(room, 'player');
      Timers.clear(room.code, 'regrade');   // un retour annule le sursis

      ack(cb, {
        ok: true,
        me: { id: me.id, name: joined.player.name, color: joined.player.color },
        state: Rooms.fullState(room),
        options: room.round.active ? Rooms.voteOptions(room, me.id) : [],
        myVote: (room.round.votes.get(me.id) || {}).votedId || null,
        ready: joined.player.ready,
        hostOnline: !!room.hostSocketId,
      });

      io.to(room.code).emit(EVENTS.STATE_PLAYERS, Rooms.publicPlayers(room));
      socket.emit(EVENTS.STATE_HOST_STATUS, { online: !!room.hostSocketId });

      // Recalcul immédiat : le retour d'un joueur peut débloquer un
      // décompte, ou au contraire le refermer.
      evaluateReveal(room);
      evaluateAdvance(room);

      console.log(`[${room.code}] ${joined.player.name} ${joined.reconnected ? 'de retour' : 'rejoint'}`);
    } catch (err) {
      console.error('[PLAYER_JOIN]', err);
      ack(cb, { ok: false, error: 'Erreur serveur.' });
    }
  });

  socket.on(EVENTS.PLAYER_VOTE, asPlayer((room, me, { votedId } = {}, cb) => {
    const res = Rooms.recordVote(room, me.id, votedId);
    ack(cb, res);
    if (!res.ok) return;
    evaluateReveal(room);
  }));

  socket.on(EVENTS.PLAYER_READY, asPlayer((room, me, { ready } = {}, cb) => {
    Rooms.setReady(room, me.id, ready !== false);
    ack(cb, { ok: true, ready: me.ready });
    io.to(room.code).emit(EVENTS.STATE_PLAYERS, Rooms.publicPlayers(room));
    evaluateAdvance(room);
  }));

  socket.on(EVENTS.PLAYER_LEAVE, asPlayer((room, me) => {
    me.connected = false;
    me.socketId  = null;
    socket.leave(room.code);
    socket.data.roomCode = null;
    io.to(room.code).emit(EVENTS.STATE_PLAYERS, Rooms.publicPlayers(room));
    scheduleRegrade(room);
  }));

  // ═══════════════════════════════════════════════════════════
  //  DÉCONNEXION
  // ═══════════════════════════════════════════════════════════

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (!room) return;

    const res = Rooms.markDisconnected(room, socket.id);
    if (!res) return;                    // socket fantôme déjà remplacé

    if (res.what === 'host') {
      io.to(room.code).emit(EVENTS.STATE_HOST_STATUS, { online: false });
      // Les minuteurs d'automatisme sont suspendus : sans PC, aucun
      // signal ne peut aboutir. Ils repartiront à sa reconnexion.
      Timers.clear(room.code, 'reveal');
      Timers.clear(room.code, 'advance');
      console.log(`[${room.code}] hôte déconnecté (salon conservé)`);
      return;
    }

    io.to(room.code).emit(EVENTS.STATE_PLAYERS, Rooms.publicPlayers(room));
    scheduleRegrade(room);
    console.log(`[${room.code}] ${res.player.name} déconnecté (sursis ${DELAYS.DISCONNECT_GRACE_MS / 1000} s)`);
  });
}

module.exports = registerHandlers;
