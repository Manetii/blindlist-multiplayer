/**
 * ════════════════════════════════════════════════════════════════
 *  GAME — Pilotage du déroulement du jeu
 * ════════════════════════════════════════════════════════════════
 *
 *  Sépare la navigation libre dans la playlist (preview pour le Host)
 *  du lancement officiel d'un tour de jeu (push aux joueurs).
 *
 *  startNewRound()  : tire un morceau au hasard parmi les non joués,
 *                     le charge ET le push aux joueurs
 *  resetPlayed()    : remet à zéro la liste des morceaux joués
 *  markCurrentAsPlayed() : appelé en interne lors du reveal
 * ════════════════════════════════════════════════════════════════ */

Host.Game = (() => {

  /** Tire au hasard un index parmi les morceaux non joués. -1 si aucun. */
  function pickRandomUnplayed() {
    const S = Host.State;
    const candidates = [];
    for (let i = 0; i < S.tracks.length; i++) {
      if (!S.tracks[i].played) candidates.push(i);
    }
    if (candidates.length === 0) return -1;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /** Lance un nouveau tour : charge un morceau au hasard + push joueurs. */
  function startNewRound() {
    const S = Host.State;
    if (!S.tracks.length) {
      flashGameStatus('Aucun morceau dans la playlist', 'error');
      return;
    }
    const idx = pickRandomUnplayed();
    if (idx === -1) {
      flashGameStatus('Tous les morceaux ont été joués — réinitialise pour rejouer', 'error');
      return;
    }

    // Charge avec autoplay
    Host.Controls.loadTrack(idx, true);

    // Push aux joueurs APRÈS le chargement
    if (Host.Socket) Host.Socket.startTrack(`track-${idx}`);

    // Marquer le tour comme actif (cache "Lancer un nouveau tour", montre "Révéler")
    if (Host.Match) Host.Match.markRoundStarted();

    flashGameStatus(`Tour lancé !`, 'success');
    updateGameButtons();
  }

  /** Marque le morceau courant comme joué. Appelé par Reveal.awardPoint / close. */
  function markCurrentAsPlayed() {
    const S = Host.State;
    if (S.currentIdx === -1) return;
    S.tracks[S.currentIdx].played = true;
    Host.Playlist.render();
    updateGameButtons();
    if (Host.Storage) Host.Storage.autoSave();
    // Si on est en partie, vérifier si c'était le dernier morceau
    if (Host.Match) Host.Match.checkAutoEnd();
  }

  /** Réinitialise tous les morceaux pour rejouer une partie. */
  function resetPlayed() {
    const S = Host.State;
    if (!S.tracks.length) return;
    if (!confirm('Réinitialiser tous les morceaux comme non joués ?')) return;
    S.tracks.forEach(t => { t.played = false; });
    Host.Playlist.render();
    updateGameButtons();
    if (Host.Storage) Host.Storage.autoSave();
    flashGameStatus(`Tous les morceaux sont à nouveau jouables`, 'success');
  }

  /**
   * Reset complet : efface tout (joueurs, morceaux, scores, morceaux joués,
   * configs sauvegardées). À utiliser quand on veut repartir totalement de zéro.
   * Demande une confirmation explicite vu l'irréversibilité.
   */
  function resetAll() {
    const S = Host.State;
    const totalP = S.players ? S.players.length : 0;
    const totalT = S.tracks  ? S.tracks.length  : 0;

    const ok = confirm(
      `⚠ Reset complet\n\n` +
      `Tu vas effacer :\n` +
      `  • ${totalP} joueur${totalP > 1 ? 's' : ''} et leurs scores\n` +
      `  • ${totalT} morceau${totalT > 1 ? 'x' : ''} (avec leur état joué)\n` +
      `  • Toutes les configurations sauvegardées\n\n` +
      `Cette action est irréversible. Continuer ?`
    );
    if (!ok) return;

    // Stop la lecture éventuelle
    if (Host.Controls) Host.Controls.stopAndClear();

    // Vider la mémoire
    S.players = [];
    S.tracks  = [];
    S.currentIdx = -1;

    // Vider la persistance localStorage
    if (Host.Storage && Host.Storage.clearAll) Host.Storage.clearAll();

    // Rafraîchir tous les rendus
    if (Host.Players)  Host.Players.render();
    if (Host.Playlist) Host.Playlist.render();
    if (Host.Socket)   Host.Socket.publishPlayers();
    updateGameButtons();
    flashGameStatus('Tout a été réinitialisé', 'success');
  }

  /** Met à jour le compteur "X / Y morceaux restants" et état des boutons. */
  function updateGameButtons() {
    const S = Host.State;
    const remaining = S.tracks.filter(t => !t.played).length;
    const total = S.tracks.length;

    const remainingEl = document.getElementById('remaining-count');
    if (remainingEl) {
      if (total === 0) {
        remainingEl.textContent = 'Aucun morceau chargé';
      } else if (remaining === 0) {
        remainingEl.textContent = `Tous joués (${total} / ${total})`;
      } else {
        remainingEl.textContent = `${remaining} / ${total} morceau${total > 1 ? 'x' : ''} restant${remaining > 1 ? 's' : ''}`;
      }
    }

    const btnLaunch = document.getElementById('btn-launch-round');
    const btnReset  = document.getElementById('btn-reset-played');
    if (btnLaunch) btnLaunch.disabled = (remaining === 0) || (Host.Match && !Host.Match.isInGame());
    if (btnReset)  btnReset.disabled  = (S.tracks.filter(t => t.played).length === 0);
  }

  /** Petit flash de statut sous le bouton "Lancer un tour". */
  function flashGameStatus(msg, kind) {
    const el = document.getElementById('game-status');
    if (!el) return;
    el.textContent = msg;
    el.className = `game-status ${kind || ''}`;
    setTimeout(() => { el.textContent = ''; el.className = 'game-status'; }, 2500);
  }

  return { startNewRound, resetPlayed, resetAll, markCurrentAsPlayed, updateGameButtons };
})();
