/**
 * ════════════════════════════════════════════════════════════════
 *  SOCKET CLIENT — Vue Joueur
 * ════════════════════════════════════════════════════════════════
 *
 *  Encapsule la connexion WebSocket et expose une API simple :
 *    PlayerSocket.connect()
 *    PlayerSocket.join(pseudo) → Promise<{ok, error?, state?}>
 *    PlayerSocket.vote(votedPseudo)
 *    PlayerSocket.on(event, callback)
 * ════════════════════════════════════════════════════════════════
 */

const PlayerSocket = (() => {
  let socket    = null;
  let myPseudo  = null;
  const handlers = new Map();

  function connect() {
    if (socket) return socket;
    socket = io();

    socket.on('connect', () => {
      console.log('[player-socket] connecté');
      emit('connected');
      // Si on avait un pseudo (reload de page), on tente la reconnexion auto
      const stored = sessionStorage.getItem('blindtest:pseudo');
      if (stored) {
        join(stored).then(r => {
          if (r.ok) {
            myPseudo = stored;
            emit('reconnected', { pseudo: stored, state: r.state });
          } else {
            sessionStorage.removeItem('blindtest:pseudo');
          }
        });
      }
    });

    socket.on('disconnect', () => {
      console.log('[player-socket] déconnecté');
      emit('disconnected');
    });

    // Forward des événements serveur vers les handlers internes
    [
      EVENTS.STATE_FULL,
      EVENTS.STATE_PLAYERS,
      EVENTS.STATE_SCORES,
      EVENTS.STATE_ROUND_START,
      EVENTS.STATE_REVEAL,
      EVENTS.ERROR,
    ].forEach(evt => {
      socket.on(evt, (payload) => emit(evt, payload));
    });

    return socket;
  }

  /** Rejoint avec un pseudo. Retourne une Promise qui résout le ack du serveur. */
  function join(pseudo) {
    return new Promise((resolve) => {
      socket.emit(EVENTS.PLAYER_JOIN, { pseudo }, (resp) => {
        if (resp && resp.ok) {
          myPseudo = pseudo;
          sessionStorage.setItem('blindtest:pseudo', pseudo);
        }
        resolve(resp || { ok: false, error: 'Pas de réponse du serveur' });
      });
    });
  }

  function vote(votedPseudo) {
    socket.emit(EVENTS.PLAYER_VOTE, { votedPseudo });
  }

  /** Prévient le serveur qu'on quitte volontairement (libère le slot pseudo).
   *  À appeler avant forgetPseudo() pour permettre à un autre appareil de
   *  prendre le relais. */
  function leave() {
    if (!socket) return;
    socket.emit(EVENTS.PLAYER_LEAVE);
  }

  function getMyPseudo() {
    return myPseudo;
  }

  /** Oublie le pseudo localement (sessionStorage + variable). Synonyme de
   *  logout, nommé pour clarifier l'intention côté UI. */
  function forgetPseudo() {
    sessionStorage.removeItem('blindtest:pseudo');
    myPseudo = null;
  }

  function logout() {
    forgetPseudo();
  }

  // ─── Pub/sub interne ─────────────────────────────────────────
  function on(event, cb) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(cb);
  }
  function emit(event, payload) {
    (handlers.get(event) || []).forEach(cb => {
      try { cb(payload); } catch (e) { console.error(e); }
    });
  }

  return { connect, join, vote, leave, getMyPseudo, forgetPseudo, logout, on };
})();

window.PlayerSocket = PlayerSocket;
