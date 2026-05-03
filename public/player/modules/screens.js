/**
 * ════════════════════════════════════════════════════════════════
 *  SCREENS — Machine à états des écrans
 * ════════════════════════════════════════════════════════════════
 *
 *  Gère les transitions entre les 4 écrans :
 *    join     → sélection du pseudo
 *    waiting  → en attente du prochain morceau
 *    voting   → vote en cours
 *    reveal   → résultat de la manche
 *
 *  Chaque écran est un <section> dans le DOM avec data-screen="..."
 * ════════════════════════════════════════════════════════════════
 */

const Screens = (() => {
  const screens = {};
  let current   = null;

  function init() {
    document.querySelectorAll('[data-screen]').forEach(el => {
      screens[el.dataset.screen] = el;
    });
  }

  function show(name) {
    if (current === name) return;
    Object.entries(screens).forEach(([k, el]) => {
      el.classList.toggle('active', k === name);
    });
    current = name;
    console.log(`[screens] → ${name}`);
  }

  function getCurrent() { return current; }

  return { init, show, getCurrent };
})();

window.Screens = Screens;
