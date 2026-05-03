/**
 * ════════════════════════════════════════════════════════════════
 *  APP — Point d'entrée Vue Joueur
 * ════════════════════════════════════════════════════════════════
 *
 *  Orchestre tous les modules et câble les événements WebSocket
 *  vers les écrans correspondants.
 * ════════════════════════════════════════════════════════════════
 */

(function bootstrap() {
  // 1) Init des écrans (mapping data-screen)
  Screens.init();
  Screens.show('join');
  VoteScreen.init();

  // 2) Connexion WebSocket
  PlayerSocket.connect();

  // 3) Câblage des événements
  PlayerSocket.on(EVENTS.STATE_FULL, (state) => {
    GameState.applyFullState(state);
    JoinScreen.render(state.players);
  });

  PlayerSocket.on(EVENTS.STATE_PLAYERS, (players) => {
    GameState.setPlayers(players);
    if (Screens.getCurrent() === 'join') {
      JoinScreen.render(players);
    }
  });

  PlayerSocket.on(EVENTS.STATE_SCORES, (players) => {
    GameState.setPlayers(players);
  });

  PlayerSocket.on(EVENTS.STATE_ROUND_START, ({ trackId, reset }) => {
    GameState.setRound({
      active:   trackId != null,
      revealed: false,
      trackId,
      answer:   null,
      votes:    [],
    });
    // Un nouveau tour démarre : on lève le flag de late joiner pour
    // que les joueurs en retard puissent participer maintenant.
    GameState.onRoundStart();
    // La partie a forcément commencé (au moins un tour lancé) → on
    // verrouille le pseudo (plus de changement possible).
    if (trackId) GameState.setMatchStarted(true);

    const me = PlayerSocket.getMyPseudo();
    if (!me) return;
    if (reset || !trackId) {
      WaitingScreen.setLateMessage(false);
      WaitingScreen.setCanChangePseudo(!GameState.isMatchStarted());
      Screens.show('waiting');
      return;
    }
    VoteScreen.render(GameState.getPlayers(), me);
    Screens.show('vote');
    if ('vibrate' in navigator) navigator.vibrate([20, 60, 20]);
  });

  PlayerSocket.on(EVENTS.STATE_REVEAL, ({ answer, votes }) => {
    // Auto-validation : si le joueur avait une sélection en attente non
    // validée, on l'envoie automatiquement avant la bascule reveal.
    let autoVoted = null;
    if (typeof VoteScreen.flushPendingVote === 'function') {
      autoVoted = VoteScreen.flushPendingVote();
    }

    const me = PlayerSocket.getMyPseudo();
    let mergedVotes = votes || [];

    // Si on a auto-voté juste à l'instant, on l'injecte dans la liste locale
    // pour que RevealScreen voie qu'on a voté (le serveur en aura aussi
    // connaissance via le PLAYER_VOTE qu'on vient d'envoyer).
    if (autoVoted && me) {
      const alreadyHas = mergedVotes.some(v => v.voter === me);
      if (!alreadyHas) {
        mergedVotes = [...mergedVotes, { voter: me, voted: autoVoted }];
        console.log('[reveal] Vote auto-validé fusionné localement :', { voter: me, voted: autoVoted });
      }
    }

    console.log('[reveal] votes utilisés pour le rendu :', mergedVotes);

    GameState.setRound({
      active:   true,
      revealed: true,
      answer,
      votes: mergedVotes,
    });
    if (!me) return;
    RevealScreen.render({ answer, votes: mergedVotes }, me);
    Screens.show('reveal');
  });

  PlayerSocket.on(EVENTS.ERROR, (msg) => {
    console.warn('[server error]', msg);
  });

  // 4) Reconnexion auto si pseudo en sessionStorage
  PlayerSocket.on('reconnected', ({ pseudo, state }) => {
    const color = (state.players.find(p => p.name === pseudo) || {}).color || '#00e5ff';
    PlayerHeader.setPseudo(pseudo, color);
    GameState.applyFullState(state);
    GameState.routeToCorrectScreen();
  });

  PlayerSocket.on('disconnected', () => {
    document.getElementById('connection-banner').classList.add('visible');
  });

  // Quand on revient en ligne (Socket.io reconnecte automatiquement)
  PlayerSocket.on('connected', () => {
    setTimeout(() => {
      document.getElementById('connection-banner').classList.remove('visible');
    }, 100);
  });
})();
