/**
 * ════════════════════════════════════════════════════════════════
 *  PLAYER HEADER — bandeau permanent (pseudo + score)
 * ════════════════════════════════════════════════════════════════
 *
 *  Repris tel quel de la v1. Visible sur tous les écrans de jeu,
 *  masqué pendant la phase de collecte où il n'aurait rien à dire.
 * ════════════════════════════════════════════════════════════════
 */

window.PlayerHeader = (() => {
  const brandEl  = document.getElementById('pt-brand');
  const idEl     = document.getElementById('pt-id');
  const statusEl = document.getElementById('pt-status');
  const scoreEl_ = document.getElementById('pt-score');
  const dotEl    = document.getElementById('header-dot');
  const nameEl   = document.getElementById('header-name');
  const scoreEl  = document.getElementById('header-score');

  /**
   * Identité du joueur : elle remplace la marque dès qu'un nom est
   * revendiqué. Garder les deux aurait demandé une barre deux fois
   * plus haute sur l'écran le plus étroit du projet.
   */
  function setPseudo(pseudo, color) {
    if (!nameEl) return;
    nameEl.textContent = pseudo;
    dotEl.style.background = color;
    dotEl.style.boxShadow  = `0 0 .6rem ${color}`;
    if (brandEl) brandEl.classList.add('hidden');
    if (idEl) idEl.classList.remove('hidden');
    // Le bouton de sortie n'a de sens qu'une fois une identité prise.
    const leave = document.getElementById('pt-leave');
    if (leave) leave.classList.remove('hidden');
  }

  /** Nom et état du salon, côté droit. */
  function setRoom(opts) {
    if (window.RoomStatus) RoomStatus.render(statusEl, opts);
  }

  /**
   * En jeu, le score prend la place de l'état du salon : une fois la
   * partie lancée, « en ligne » n'apprend plus rien, alors que son
   * score est ce qu'on vérifie à chaque manche.
   */
  function showScore(on) {
    if (statusEl) statusEl.classList.toggle('hidden', !!on);
    if (scoreEl_) scoreEl_.classList.toggle('hidden', !on);
  }

  function setScore(n) {
    if (!scoreEl) return;
    // Le rebond n'est joué que si le score a changé : sinon chaque
    // rafraîchissement ferait clignoter le chiffre sans raison.
    if (scoreEl.textContent === String(n)) return;
    scoreEl.textContent = n;
    scoreEl.classList.add('bump');
    setTimeout(() => scoreEl.classList.remove('bump'), 400);
  }

  function hide() { showScore(false); }

  return { setPseudo, setScore, setRoom, showScore, hide };
})();
