/**
 * ════════════════════════════════════════════════════════════════
 *  GAME STATE — État local côté joueur
 * ════════════════════════════════════════════════════════════════
 *
 *  Miroir simplifié de l'état du serveur. Mis à jour à chaque
 *  événement reçu. Sert de source de vérité pour les écrans.
 * ════════════════════════════════════════════════════════════════
 */

const GameState = (() => {
  let players = [];
  let round = {
    active:   false,
    revealed: false,
    trackId:  null,
    answer:   null,
  };
  let matchStarted = false;

  // Si un joueur rejoint pendant qu'un tour est déjà commencé, on le marque
  // comme "late joiner" : il ne peut pas voter sur ce tour (puisqu'il n'a
  // pas entendu le morceau), il participera au prochain tour.
  // Reset au démarrage du tour suivant.
  let isLateJoiner = false;

  function setPlayers(list) {
    players = list || [];
    // Mettre à jour le score perso si visible
    const me = players.find(p => p.name === PlayerSocket.getMyPseudo());
    if (me) PlayerHeader.setScore(me.score);
  }

  function setRound(r) {
    round = r;
    // À chaque nouveau tour qui démarre, on lève le flag de late joiner
    if (round.active && !round.revealed) {
      // Cas particulier : si on était late joiner, c'est uniquement levé
      // au DÉMARRAGE d'un nouveau tour. Si l'event STATE_ROUND_START n'est
      // pas encore arrivé, on reste en late joiner. Le flag est levé
      // explicitement par onRoundStart() ci-dessous.
    }
  }

  /** Marque le joueur comme "late joiner" : il a rejoint après le début
   *  du tour en cours. Il restera en attente jusqu'au prochain tour. */
  function markLateJoiner() {
    isLateJoiner = true;
  }

  /** Appelé quand un nouveau tour démarre côté serveur (STATE_ROUND_START).
   *  On lève le flag de late joiner pour qu'il puisse jouer ce tour. */
  function onRoundStart() {
    isLateJoiner = false;
  }

  function applyFullState(state) {
    if (!state) return;
    setPlayers(state.players);
    setRound(state.round);
    matchStarted = !!state.matchStarted;
  }

  function isMatchStarted() { return matchStarted; }
  function setMatchStarted(v) { matchStarted = !!v; }

  /** Choisit l'écran à afficher selon l'état actuel reçu du serveur */
  function routeToCorrectScreen() {
    const me = PlayerSocket.getMyPseudo();
    if (!me) {
      Screens.show('join');
      return;
    }
    if (round.revealed && round.answer) {
      RevealScreen.render({ answer: round.answer, votes: round.votes || [] }, me);
      Screens.show('reveal');
      return;
    }
    if (round.active) {
      // Si on a rejoint en cours de tour → on attend le prochain tour
      if (isLateJoiner) {
        WaitingScreen.setLateMessage(true);
        // En late joiner pendant un tour, la partie est déjà commencée → pas de changement de pseudo
        WaitingScreen.setCanChangePseudo(false);
        Screens.show('waiting');
        return;
      }
      VoteScreen.render(players, me);
      Screens.show('vote');
      return;
    }
    WaitingScreen.setLateMessage(false);
    // Bouton "Changer de pseudo" disponible UNIQUEMENT avant le 1er tour
    WaitingScreen.setCanChangePseudo(!matchStarted);
    Screens.show('waiting');
  }

  function getPlayers() { return players; }
  function getRound()   { return round; }

  return {
    applyFullState,
    setPlayers, setRound,
    getPlayers, getRound,
    routeToCorrectScreen,
    markLateJoiner, onRoundStart,
    isMatchStarted, setMatchStarted,
  };
})();

window.GameState = GameState;
