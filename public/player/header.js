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
  const headerEl = document.getElementById('player-header');
  const dotEl    = document.getElementById('header-dot');
  const nameEl   = document.getElementById('header-name');
  const scoreEl  = document.getElementById('header-score');

  function setPseudo(pseudo, color) {
    if (!headerEl) return;
    nameEl.textContent = pseudo;
    dotEl.style.background = color;
    dotEl.style.boxShadow  = `0 0 12px ${color}`;
    headerEl.classList.add('visible');
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

  function hide() { if (headerEl) headerEl.classList.remove('visible'); }

  return { setPseudo, setScore, hide };
})();
