/**
 * ════════════════════════════════════════════════════════════════
 *  MATCH — Cycle de vie d'une partie
 * ════════════════════════════════════════════════════════════════
 *
 *  3 états possibles :
 *    PRE_GAME   — Configuration libre (clic playlist, edit, etc.)
 *    IN_GAME    — Partie en cours (playlist verrouillée)
 *    FINISHED   — Tous les morceaux joués, écran final
 *
 *  Transitions :
 *    PRE_GAME → IN_GAME  via startMatch() (avec confirmation)
 *    IN_GAME  → PRE_GAME via endMatch()    (avec confirmation)
 *    IN_GAME  → FINISHED auto quand tous les morceaux sont joués
 *    FINISHED → PRE_GAME via dismissEndScreen() (ou nouveau Reset)
 * ════════════════════════════════════════════════════════════════ */

Host.Match = (() => {

  const STATES = {
    PRE_GAME: 'pre_game',
    IN_GAME:  'in_game',
    FINISHED: 'finished',
  };

  let current = STATES.PRE_GAME;
  let roundActive = false;   // true quand un tour est en cours (entre Lancer et Reveal)

  // ─── Indices (titre, artiste, pochette) ──────────────────
  // hideIndicesByDefault : option configurée en PRE_GAME, persistée
  // indicesHidden        : état courant (peut être toggle pendant un tour)
  let hideIndicesByDefault = false;
  let indicesHidden        = false;

  // ─── Comportement au reveal ──────────────────────────────
  // Si true : on saute automatiquement au moment clé pendant le reveal.
  // Si false : la musique continue depuis sa position actuelle.
  let jumpToKeyMomentOnReveal = true;

  // ─── Règles de scoring (modifiables en PRE_GAME) ─────────
  // Trouveur : toujours actif (+1 par bonne réponse pour le voteur).
  // Bluffeur : +1 par joueur bluffé (= qui a voté pour le non-owner).
  // Confirmation : owner gagne +1 par joueur ne votant pas pour lui.
  let ruleBluffer      = true;
  let ruleConfirmation = false;

  // ─── State queries ─────────────────────────────────────────
  function isPreGame()  { return current === STATES.PRE_GAME; }
  function isInGame()   { return current === STATES.IN_GAME; }
  function isFinished() { return current === STATES.FINISHED; }
  function getState()   { return current; }
  function isRoundActive() { return roundActive; }
  function areIndicesHidden() { return indicesHidden; }
  function getHideIndicesByDefault() { return hideIndicesByDefault; }
  function getJumpToKeyMomentOnReveal() { return jumpToKeyMomentOnReveal; }
  function getRuleBluffer()      { return ruleBluffer; }
  function getRuleConfirmation() { return ruleConfirmation; }
  function getScoringRules() {
    return { bluffer: ruleBluffer, confirmation: ruleConfirmation };
  }

  /** Marque qu'un tour est en cours (appelé par Game.startNewRound). */
  function markRoundStarted() {
    roundActive = true;
    // Au lancement d'un tour, applique l'option par défaut
    indicesHidden = hideIndicesByDefault;
    apply();
  }

  /** Marque la fin du tour (appelé par Reveal après validation des points). */
  function markRoundEnded() {
    roundActive = false;
    indicesHidden = false;   // au reveal, on ne cache plus rien
    apply();
  }

  /** Toggle manuel du floutage pendant un tour. */
  function toggleIndices() {
    indicesHidden = !indicesHidden;
    apply();
  }

  /** Configure l'option par défaut (depuis la checkbox PRE_GAME). */
  function setHideIndicesByDefault(value) {
    hideIndicesByDefault = !!value;
    try {
      localStorage.setItem('blindtest:hideIndicesDefault', hideIndicesByDefault ? '1' : '0');
    } catch (e) {}
  }

  function setJumpToKeyMomentOnReveal(value) {
    jumpToKeyMomentOnReveal = !!value;
    try {
      localStorage.setItem('blindtest:jumpOnReveal', jumpToKeyMomentOnReveal ? '1' : '0');
    } catch (e) {}
  }

  function setRuleBluffer(value) {
    ruleBluffer = !!value;
    try {
      localStorage.setItem('blindtest:ruleBluffer', ruleBluffer ? '1' : '0');
    } catch (e) {}
  }

  function setRuleConfirmation(value) {
    ruleConfirmation = !!value;
    try {
      localStorage.setItem('blindtest:ruleConfirmation', ruleConfirmation ? '1' : '0');
    } catch (e) {}
  }

  // ─── Démarrage avec dialogue de confirmation ───────────────
  function showStartDialog() {
    const playerCount = Host.State.players.filter(p => p.connected).length;
    const totalPlayers = Host.State.players.length;
    const trackCount   = Host.State.tracks.length;

    if (trackCount === 0) {
      alert('Charge au moins un morceau avant de démarrer la partie.');
      return;
    }

    const dialog = document.getElementById('match-start-dialog');
    if (!dialog) return;

    document.getElementById('msd-players-connected').textContent = playerCount;
    document.getElementById('msd-players-total').textContent     = totalPlayers;
    document.getElementById('msd-tracks').textContent            = trackCount;

    // Avertissement si peu de joueurs connectés
    const warn = document.getElementById('msd-warning');
    if (playerCount === 0) {
      warn.textContent = '⚠ Aucun joueur n\'est encore connecté.';
      warn.style.display = 'block';
    } else if (playerCount < totalPlayers) {
      warn.textContent = `⚠ ${totalPlayers - playerCount} joueur(s) pas encore connecté(s).`;
      warn.style.display = 'block';
    } else {
      warn.style.display = 'none';
    }

    dialog.classList.add('open');
  }

  function closeStartDialog() {
    const d = document.getElementById('match-start-dialog');
    if (d) d.classList.remove('open');
  }

  function confirmStart() {
    closeStartDialog();
    setState(STATES.IN_GAME);
    // Enchaîne directement sur le premier tour (plus de phase "En attente")
    if (Host.Game) {
      // Petite tempo pour laisser l'UI s'actualiser proprement
      setTimeout(() => Host.Game.startNewRound(), 100);
    }
  }

  // ─── Terminer la partie (manuel) ──────────────────────────
  function endMatchManual() {
    if (!confirm('Terminer la partie ? Les scores seront affichés et tu reviendras au mode configuration.')) return;
    setState(STATES.FINISHED);
  }

  // ─── Fin de partie auto (tous les morceaux joués) ─────────
  function checkAutoEnd() {
    if (!isInGame()) return;
    const remaining = Host.State.tracks.filter(t => !t.played).length;
    if (Host.State.tracks.length > 0 && remaining === 0) {
      setState(STATES.FINISHED);
    }
  }

  // ─── Sortie de l'écran final, retour PRE-GAME ─────────────
  function dismissEndScreen() {
    // Arrête les confettis lancés par renderEndScreen
    if (Host.Confetti) Host.Confetti.stopConfetti();
    // Coupe la musique proprement
    if (Host.Controls) Host.Controls.stopAndClear();
    setState(STATES.PRE_GAME);
  }

  // ─── State machine ─────────────────────────────────────────
  function setState(newState) {
    if (current === newState) return;
    const previous = current;
    current = newState;
    // Reset roundActive sur transition d'état
    roundActive = false;
    console.log(`[match] ${previous} → ${newState}`);
    apply();

    // Side effects
    if (newState === STATES.FINISHED) {
      renderEndScreen();
    }
    if (newState === STATES.IN_GAME && previous === STATES.PRE_GAME) {
      // Au passage en partie :
      // - fermer le panneau Playlist (anti-spoil)
      // - couper la musique de preview en cours (le 1er tour va la remplacer)
      // - activer l'anonymisation par défaut (anti-spoil si on ouvre la playlist)
      if (Host.Panels) Host.Panels.close('playlist');
      if (Host.Controls) Host.Controls.stopAndClear();
      if (Host.Playlist) Host.Playlist.setAnonymized(true);
    }
    if (newState === STATES.PRE_GAME && previous !== STATES.PRE_GAME) {
      // Retour en config : on désactive l'anonymisation pour qu'on puisse
      // tout voir/éditer normalement
      if (Host.Playlist) Host.Playlist.setAnonymized(false);
    }
  }

  /** Met à jour le DOM selon l'état courant. */
  function apply() {
    document.body.classList.toggle('match-pre-game',  isPreGame());
    document.body.classList.toggle('match-in-game',   isInGame());
    document.body.classList.toggle('match-finished',  isFinished());
    document.body.classList.toggle('match-round-active', isInGame() && roundActive);
    document.body.classList.toggle('match-round-idle',   isInGame() && !roundActive);
    document.body.classList.toggle('indices-hidden',     indicesHidden);

    // Mise à jour de l'icône du bouton 👁 (œil ouvert vs fermé)
    const btn = document.getElementById('btn-toggle-indices');
    if (btn) {
      btn.title = indicesHidden ? "Afficher les indices" : "Cacher les indices";
      const icoOpen   = btn.querySelector('.eye-open');
      const icoClosed = btn.querySelector('.eye-closed');
      if (icoOpen)   icoOpen.style.display   = indicesHidden ? 'none' : 'block';
      if (icoClosed) icoClosed.style.display = indicesHidden ? 'block' : 'none';
    }

    // Mise à jour des checkboxes Options de partie
    const cb = document.getElementById('chk-hide-indices');
    if (cb) cb.checked = hideIndicesByDefault;
    const cbJump = document.getElementById('chk-jump-on-reveal');
    if (cbJump) cbJump.checked = jumpToKeyMomentOnReveal;
    const cbBluff = document.getElementById('chk-rule-bluffer');
    if (cbBluff) cbBluff.checked = ruleBluffer;
    const cbConf = document.getElementById('chk-rule-confirm');
    if (cbConf) cbConf.checked = ruleConfirmation;

    // Le panneau Playlist doit redevenir éditable / ne plus l'être
    if (Host.Playlist) Host.Playlist.render();

    // Mettre à jour les boutons (le module game gère son propre état)
    if (Host.Game) Host.Game.updateGameButtons();
  }

  function init() {
    // Restaurer les options de partie depuis localStorage
    try {
      const savedHide = localStorage.getItem('blindtest:hideIndicesDefault');
      if (savedHide === '1') hideIndicesByDefault = true;

      // Pour jumpOnReveal : true par défaut (cocher), donc on ne le passe à false
      // que si explicitement enregistré à false
      const savedJump = localStorage.getItem('blindtest:jumpOnReveal');
      if (savedJump === '0') jumpToKeyMomentOnReveal = false;

      // Bluffeur : true par défaut, false uniquement si explicitement décoché
      const savedBluffer = localStorage.getItem('blindtest:ruleBluffer');
      if (savedBluffer === '0') ruleBluffer = false;

      // Confirmation : false par défaut, true uniquement si activé
      const savedConfirm = localStorage.getItem('blindtest:ruleConfirmation');
      if (savedConfirm === '1') ruleConfirmation = true;
    } catch (e) {}

    // Démarrage en mode PRE-GAME par défaut
    current = STATES.PRE_GAME;
    apply();
  }

  // ─── Écran de fin de partie ────────────────────────────────
  function renderEndScreen() {
    const wrap = document.getElementById('end-screen');
    if (!wrap) return;

    // Tri par score décroissant
    const ranked = [...Host.State.players].sort((a, b) => b.score - a.score);
    const maxScore = ranked.length ? ranked[0].score : 0;
    const winners  = ranked.filter(p => p.score === maxScore && maxScore > 0);
    // Couleur d'animation : celle du gagnant principal (s'il y en a un seul)
    // ou null pour un mix de couleurs si égalité
    const animColor = winners.length === 1 ? winners[0].color : null;

    const podium = ranked.map((p, i) => {
      const isWinner = p.score === maxScore && maxScore > 0;
      return `
        <div class="end-row ${isWinner ? 'winner' : ''}">
          <span class="end-rank">${i + 1}</span>
          <span class="end-dot" style="background:${p.color}"></span>
          <span class="end-name">${SharedUtils.esc(p.name)}</span>
          <span class="end-score">${p.score}</span>
        </div>
      `;
    }).join('');

    wrap.innerHTML = `
      <div class="end-card">
        <div class="end-trophy">🏆</div>
        <h1 class="end-title">Fin de la partie</h1>
        <p class="end-subtitle">Voici les scores finaux</p>
        <div class="end-list">${podium}</div>
        <div class="end-footer">
          <button class="btn primary" onclick="Host.Match.dismissEndScreen()">
            Retour au mode configuration
          </button>
        </div>
      </div>
    `;

    // Lance les confettis en continu — ils s'arrêteront via dismissEndScreen
    // (qui repasse en PRE_GAME, déclenchant l'arrêt par observation du state).
    if (Host.Confetti && maxScore > 0) {
      Host.Confetti.startConfetti(animColor);
    }
  }

  return {
    STATES,
    isPreGame, isInGame, isFinished, getState, isRoundActive,
    init,
    markRoundStarted, markRoundEnded,
    showStartDialog, closeStartDialog, confirmStart,
    endMatchManual, checkAutoEnd, dismissEndScreen,
    // floutage
    areIndicesHidden, getHideIndicesByDefault,
    toggleIndices, setHideIndicesByDefault,
    // moment clé au reveal
    getJumpToKeyMomentOnReveal, setJumpToKeyMomentOnReveal,
    // règles de scoring
    getRuleBluffer, setRuleBluffer,
    getRuleConfirmation, setRuleConfirmation,
    getScoringRules,
  };
})();
