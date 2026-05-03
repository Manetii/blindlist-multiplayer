/**
 * ════════════════════════════════════════════════════════════════
 *  PANELS — Gestion des panneaux latéraux Joueurs/Playlist
 * ════════════════════════════════════════════════════════════════
 *
 *  Trois éléments d'UI à gérer :
 *    - Panneau Joueurs (gauche) : ouvre/ferme indépendamment
 *    - Panneau Playlist (droite) : ouvre/ferme indépendamment
 *    - Bouton Mode TV : ferme les deux panneaux d'un coup
 *
 *  L'état est sauvegardé en localStorage pour persister les choix.
 *
 *  Sur mobile (<900px) : les deux panneaux sont fermés par défaut
 *  et passent en plein écran (overlay) au lieu de glisser sur le côté.
 * ════════════════════════════════════════════════════════════════ */

Host.Panels = (() => {

  const KEY = 'blindtest:panels';
  const MOBILE_BREAKPOINT = 900;

  let state = {
    players:  false,    // panneau joueurs ouvert
    playlist: false,    // panneau playlist ouvert
  };

  function isMobile() {
    return window.innerWidth < MOBILE_BREAKPOINT;
  }

  function init() {
    // Restaure l'état précédent (sauf sur mobile où on force fermé)
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved && typeof saved === 'object' && !isMobile()) {
        state.players  = !!saved.players;
        state.playlist = !!saved.playlist;
      }
    } catch (e) {}

    apply();

    // Resize listener — sur passage mobile/desktop on ferme tout
    let lastIsMobile = isMobile();
    window.addEventListener('resize', () => {
      const cur = isMobile();
      if (cur !== lastIsMobile) {
        lastIsMobile = cur;
        if (cur) {
          // Passage mobile : on ferme tout
          state.players  = false;
          state.playlist = false;
          apply();
        }
      }
    });
  }

  function toggle(panel) {
    if (panel !== 'players' && panel !== 'playlist') return;
    state[panel] = !state[panel];
    save();
    apply();
  }

  function close(panel) {
    if (state[panel]) {
      state[panel] = false;
      save();
      apply();
    }
  }

  function closeAll() {
    state.players  = false;
    state.playlist = false;
    save();
    apply();
  }

  function openPanel(panel) {
    state[panel] = true;
    save();
    apply();
  }

  /** Mode TV toggle : si quelque chose est ouvert → tout fermer (Mode TV).
   *  Sinon → ouvrir les 2 panneaux. */
  function toggleAll() {
    if (isAnyOpen()) {
      closeAll();
    } else {
      state.players  = true;
      state.playlist = true;
      save();
      apply();
    }
  }

  function isOpen(panel) {
    return !!state[panel];
  }

  function isAnyOpen() {
    return state.players || state.playlist;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  /** Applique l'état actuel sur le DOM (classes + boutons). */
  function apply() {
    document.body.classList.toggle('panel-players-open',  state.players);
    document.body.classList.toggle('panel-playlist-open', state.playlist);
    document.body.classList.toggle('panels-all-closed',   !isAnyOpen());

    // Mettre à jour les onglets
    const tabPlayers  = document.getElementById('tab-players');
    const tabPlaylist = document.getElementById('tab-playlist');
    if (tabPlayers)  tabPlayers.classList.toggle('active',  state.players);
    if (tabPlaylist) tabPlaylist.classList.toggle('active', state.playlist);

    // Bouton Mode TV : reflète l'état (icône TV vs panneaux)
    const btnTV = document.getElementById('btn-mode-tv');
    if (btnTV) {
      btnTV.classList.toggle('active', !isAnyOpen());
      btnTV.title = isAnyOpen()
        ? "Mode TV : fermer tous les panneaux"
        : "Sortir du Mode TV : ouvrir les panneaux";
    }
  }

  return {
    init, toggle, close, closeAll, openPanel, toggleAll,
    isOpen, isAnyOpen,
  };
})();
