/**
 * ════════════════════════════════════════════════════════════════
 *  KEYBOARD — Raccourcis clavier globaux
 * ════════════════════════════════════════════════════════════════
 *
 *  Espace : play/pause
 *  Entrée : action principale (Démarrer / Lancer / Révéler selon état)
 *  T      : toggle Mode TV (ferme tous les panneaux)
 *  J      : toggle panneau Joueurs
 *  P      : toggle panneau Playlist
 *  K      : aller au moment clé
 *  M      : définir le moment clé ici
 *  H      : toggle masquage des indices (en partie)
 *  ?      : afficher l'aide raccourcis
 *  Esc    : fermer overlay / modale / panneau
 *
 *  Ignore les événements quand on est dans un INPUT/SELECT/TEXTAREA.
 * ════════════════════════════════════════════════════════════════ */

Host.Keyboard = (() => {

  /** Action principale selon l'état du Match. */
  function triggerMainAction() {
    if (!Host.Match) return;
    if (Host.Match.isFinished()) {
      Host.Match.dismissEndScreen();
      return;
    }
    if (Host.Match.isPreGame()) {
      Host.Match.showStartDialog();
      return;
    }
    if (Host.Match.isRoundActive()) {
      Host.Reveal.open();
    } else {
      Host.Game.startNewRound();
    }
  }

  function showHelp() {
    const lines = [
      'Raccourcis clavier :',
      '',
      '  Espace   Play / Pause',
      '  Entrée   Démarrer la partie / Lancer un tour / Révéler la réponse',
      '  T        Mode TV (ferme tous les panneaux)',
      '  J        Panneau Joueurs',
      '  P        Panneau Playlist',
      '  K        Aller au moment clé',
      '  M        Définir le moment clé',
      '  H        Cacher / afficher les indices (en partie)',
      '  ?        Cette aide',
      '  Echap    Fermer overlay / modale / panneau',
    ];
    alert(lines.join('\n'));
  }

  function init() {
    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const dialogOpen = document.querySelector('.match-dialog-overlay.open');
      // Si un dialogue est ouvert, on ne traite que Esc et Entrée
      if (dialogOpen && e.code !== 'Escape' && e.code !== 'Enter') return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          Host.Controls.togglePlay();
          break;
        case "Enter":
          e.preventDefault();
          if (dialogOpen) {
            Host.Match.confirmStart();
          } else {
            triggerMainAction();
          }
          break;
        case "KeyT":
          e.preventDefault();
          Host.Panels.toggleAll();
          break;
        case "KeyJ":
          e.preventDefault();
          Host.Panels.toggle('players');
          break;
        case "KeyP":
          e.preventDefault();
          Host.Panels.toggle('playlist');
          break;
        case "KeyK":
          e.preventDefault();
          Host.Controls.jumpToKeyMoment(true);
          break;
        case "KeyM":
          e.preventDefault();
          Host.Controls.setKeyMoment();
          break;
        case "KeyH":
          if (Host.Match.isInGame()) {
            e.preventDefault();
            Host.Match.toggleIndices();
          }
          break;
        case "Slash":
          if (e.shiftKey) {
            e.preventDefault();
            showHelp();
          }
          break;
        case "Escape":
          if (dialogOpen) {
            Host.Match.closeStartDialog();
            return;
          }
          if (document.querySelector('.modal-overlay.open')) {
            Host.EditModal.close();
            return;
          }
          if (document.querySelector('.overlay.open')) {
            Host.Reveal.close();
            return;
          }
          if (Host.Panels.isAnyOpen()) {
            Host.Panels.closeAll();
          }
          break;
      }
    });
  }

  return { init, triggerMainAction, showHelp };
})();
