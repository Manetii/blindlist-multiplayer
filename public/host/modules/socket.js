/**
 * ════════════════════════════════════════════════════════════════
 *  SOCKET CLIENT — Vue Host
 * ════════════════════════════════════════════════════════════════
 *
 *  Encapsule la connexion WebSocket. Expose une API qui correspond
 *  aux événements du contrat (events.js).
 *
 *  Méthodes émettrices :
 *    Host.Socket.publishPlayers()  → HOST_PLAYERS_UPDATE
 *    Host.Socket.startTrack(id)    → HOST_TRACK_START
 *    Host.Socket.reveal(answer)    → HOST_TRACK_REVEAL
 *    Host.Socket.awardPoint(name)  → HOST_AWARD_POINT
 *    Host.Socket.nextRound()       → HOST_NEXT_ROUND
 *
 *  Le module écoute aussi :
 *    STATE_PLAYERS         → met à jour le statut "connecté" des joueurs
 *    STATE_VOTE_RECEIVED   → affiche les votes reçus dans la sidebar
 * ════════════════════════════════════════════════════════════════ */

Host.Socket = (() => {
  let socket = null;
  // Map<playerName, votedFor>  — les votes de la manche courante
  const currentVotes = new Map();
  let connected = false;

  function connect() {
    if (socket) return;
    socket = io();

    socket.on('connect', () => {
      connected = true;
      console.log('[host-socket] connecté');
      socket.emit(EVENTS.HOST_HELLO);
      updateConnectionUI(true);

      // Republication auto des joueurs locaux au cas où le Host
      // a été rechargé : permet aux joueurs en retard de rejoindre
      // sans avoir à re-cliquer sur "Publier les joueurs".
      // Léger délai pour que HOST_HELLO soit traité avant.
      setTimeout(() => {
        if (Host.State.players.length > 0) {
          publishPlayers({ silent: true });
          console.log('[host-socket] Joueurs republiés automatiquement');
        }
      }, 200);
    });

    socket.on('disconnect', () => {
      connected = false;
      console.log('[host-socket] déconnecté');
      updateConnectionUI(false);
    });

    // ─── État reçu du serveur ────────────────────────────────
    socket.on(EVENTS.STATE_FULL, (state) => {
      // On synchronise les joueurs déjà connectés (utile au reload du Host)
      if (state.players && state.players.length) {
        mergeServerPlayersIntoState(state.players);
      }
    });

    socket.on(EVENTS.STATE_PLAYERS, (players) => {
      // Met à jour le statut "connecté" sur chaque joueur local
      players.forEach(serverP => {
        const local = Host.State.players.find(p => p.name === serverP.name);
        if (local) {
          local.connected = serverP.connected;
        }
      });
      Host.Players.render();
    });

    socket.on(EVENTS.STATE_VOTE_RECEIVED, (data) => {
      // data = { voter, votedPseudo, totalVotes }
      currentVotes.set(data.voter, data.votedPseudo);
      console.log(`[host-socket] Vote : ${data.voter} → ${data.votedPseudo} (${data.totalVotes} total)`);
      renderVotesPanel();
    });

    // Exposé pour debug console
    window.socket = socket;
  }

  /** Les joueurs reçus du serveur lors d'un reload du Host : on les fusionne. */
  function mergeServerPlayersIntoState(serverPlayers) {
    serverPlayers.forEach(sp => {
      if (!Host.State.players.find(p => p.name === sp.name)) {
        Host.State.players.push({
          name:      sp.name,
          color:     sp.color,
          score:     sp.score || 0,
          connected: sp.connected,
        });
      }
    });
    Host.Players.render();
  }

  // ─── ÉMETTEURS ─────────────────────────────────────────────

  /** Envoie la liste des joueurs au serveur (déclenché par "Publier les joueurs"). */
  function publishPlayers(opts) {
    opts = opts || {};
    if (!connected) {
      if (!opts.silent) flashStatus('Pas connecté au serveur', 'error');
      return;
    }
    const payload = Host.State.players.map(p => ({
      name:  p.name,
      color: p.color,
    }));
    socket.emit(EVENTS.HOST_PLAYERS_UPDATE, payload);
    if (!opts.silent) flashStatus(`✓ ${payload.length} joueur(s) publié(s)`, 'success');
  }

  /** Lance une nouvelle manche : reset des votes + push aux joueurs. */
  function startTrack(trackId) {
    if (!connected) return;
    currentVotes.clear();
    renderVotesPanel();
    socket.emit(EVENTS.HOST_TRACK_START, { trackId });
  }

  /** Révèle la réponse aux joueurs. answer = { title, artist, player, art }. */
  function reveal(answer) {
    if (!connected) return;
    socket.emit(EVENTS.HOST_TRACK_REVEAL, answer);
  }

  /** Attribue +1 à un joueur (legacy, plus utilisé par le scoring). */
  function awardPoint(playerName) {
    if (!connected) return;
    socket.emit(EVENTS.HOST_AWARD_POINT, { pseudo: playerName });
  }

  /** Applique un batch de points calculés selon les règles de scoring. */
  function applyScores(points) {
    if (!connected) return;
    socket.emit(EVENTS.HOST_APPLY_SCORES, { points });
  }

  /** Remet tous les scores à 0 côté serveur. */
  function resetScores() {
    if (!connected) return;
    socket.emit(EVENTS.HOST_RESET_SCORES);
  }

  /** Reset de la manche (les joueurs reviennent en "En attente"). */
  function nextRound() {
    if (!connected) return;
    currentVotes.clear();
    renderVotesPanel();
    socket.emit(EVENTS.HOST_NEXT_ROUND);
  }

  // ─── UI : état de connexion ─────────────────────────────────

  function updateConnectionUI(isConnected) {
    const dot = document.getElementById('conn-dot');
    const lbl = document.getElementById('conn-label');
    if (!dot || !lbl) return;
    if (isConnected) {
      dot.style.background = '#06d6a0';
      dot.style.boxShadow  = '0 0 8px #06d6a0';
      lbl.textContent      = 'En ligne';
    } else {
      dot.style.background = '#ff6b6b';
      dot.style.boxShadow  = '0 0 8px #ff6b6b';
      lbl.textContent      = 'Hors ligne';
    }
  }

  function flashStatus(msg, kind) {
    const el = document.getElementById('publish-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `publish-status ${kind || ''}`;
    setTimeout(() => { el.textContent = ''; el.className = 'publish-status'; }, 2500);
  }

  // ─── Panneau "Votes reçus" ──────────────────────────────────

  function renderVotesPanel() {
    const el = document.getElementById('votes-panel');
    if (!el) return;

    if (currentVotes.size === 0) {
      el.innerHTML = '<div class="empty-mini">Aucun vote pour cette manche…</div>';
      return;
    }

    el.innerHTML = Array.from(currentVotes.entries()).map(([voter, voted]) => {
      const voterP = Host.State.players.find(p => p.name === voter);
      const votedP = Host.State.players.find(p => p.name === voted);
      const voterColor = voterP ? voterP.color : '#5a7080';
      const votedColor = votedP ? votedP.color : '#5a7080';
      return `
        <div class="vote-row">
          <span class="vote-voter" style="color:${voterColor}">${SharedUtils.esc(voter)}</span>
          <span class="vote-arrow">→</span>
          <span class="vote-voted" style="color:${votedColor}">${SharedUtils.esc(voted)}</span>
        </div>
      `;
    }).join('');
  }

  function getCurrentVotes() {
    return new Map(currentVotes);
  }

  return {
    connect,
    publishPlayers, startTrack, reveal, awardPoint, applyScores, resetScores, nextRound,
    renderVotesPanel, getCurrentVotes,
  };
})();
