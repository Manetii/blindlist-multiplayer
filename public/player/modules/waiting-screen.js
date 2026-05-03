/**
 * ════════════════════════════════════════════════════════════════
 *  WAITING SCREEN — Écran d'attente entre les tours
 * ════════════════════════════════════════════════════════════════
 *
 *  Adapte le titre/sous-titre selon le contexte :
 *    - mode "normal" : "En attente / Le Host va lancer le prochain morceau"
 *    - mode "late joiner" : "Tu participeras au prochain tour"
 *
 *  Affiche un bouton "Changer de pseudo" UNIQUEMENT si la partie
 *  n'a pas encore commencé (= aucun tour lancé). Une fois la partie
 *  démarrée, le pseudo est figé (pour ne pas casser les scores).
 * ════════════════════════════════════════════════════════════════
 */

const WaitingScreen = (() => {
  const titleEl = document.getElementById('waiting-title');
  const subEl   = document.getElementById('waiting-sub');
  const btnEl   = document.getElementById('btn-change-pseudo');

  const NORMAL = {
    title: 'En attente',
    sub:   'Le Host va lancer le prochain morceau…',
  };

  const LATE = {
    title: '⏳ Trop tard pour ce tour',
    sub:   'Tu as rejoint après le début. Tu joueras au prochain tour.',
  };

  /** Définit si on doit afficher le message "late joiner" ou le message normal. */
  function setLateMessage(isLate) {
    const cfg = isLate ? LATE : NORMAL;
    if (titleEl) titleEl.textContent = cfg.title;
    if (subEl)   subEl.textContent   = cfg.sub;
  }

  /** Affiche ou cache le bouton Changer de pseudo. */
  function setCanChangePseudo(canChange) {
    if (!btnEl) return;
    btnEl.style.display = canChange ? 'inline-flex' : 'none';
  }

  /** Comportement du bouton : prévient le serveur, oublie le pseudo localement,
   *  retourne à l'écran de sélection. */
  function onChangePseudo() {
    if (!confirm("Changer de pseudo et revenir à la sélection ?")) return;
    if (typeof PlayerSocket.leave === 'function') {
      PlayerSocket.leave();
    }
    PlayerSocket.forgetPseudo();
    if (typeof PlayerHeader.hide === 'function') PlayerHeader.hide();
    Screens.show('join');
  }

  if (btnEl) btnEl.addEventListener('click', onChangePseudo);

  return { setLateMessage, setCanChangePseudo };
})();

window.WaitingScreen = WaitingScreen;
