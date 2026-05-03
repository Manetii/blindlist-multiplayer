/**
 * ════════════════════════════════════════════════════════════════
 *  PLAYER HEADER — Bandeau permanent (pseudo + score)
 * ════════════════════════════════════════════════════════════════
 *
 *  Visible en haut sur tous les écrans sauf "join".
 * ════════════════════════════════════════════════════════════════
 */

const PlayerHeader = (() => {
  const headerEl = document.getElementById('player-header');
  const dotEl    = document.getElementById('header-dot');
  const nameEl   = document.getElementById('header-name');
  const scoreEl  = document.getElementById('header-score');

  function setPseudo(pseudo, color) {
    nameEl.textContent = pseudo;
    dotEl.style.background = color;
    dotEl.style.boxShadow  = `0 0 12px ${color}`;
    headerEl.classList.add('visible');
  }

  function setScore(n) {
    scoreEl.textContent = n;
    scoreEl.classList.add('bump');
    setTimeout(() => scoreEl.classList.remove('bump'), 400);
  }

  function hide() {
    headerEl.classList.remove('visible');
  }

  return { setPseudo, setScore, hide };
})();

window.PlayerHeader = PlayerHeader;
