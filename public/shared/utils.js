/**
 * ════════════════════════════════════════════════════════════════
 *  UTILITAIRES PARTAGÉS
 * ════════════════════════════════════════════════════════════════
 *  Helpers utilisés à la fois côté Host et côté Joueur.
 * ════════════════════════════════════════════════════════════════
 */

/** Formate un nombre de secondes en m:ss */
function fmt(s) {
  if (isNaN(s) || s == null) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

/** Échappe une chaîne pour insertion HTML safe */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Palette de couleurs pour les joueurs (cycliques) */
const PLAYER_COLORS = [
  '#00e5ff', '#ff6b6b', '#ffd166', '#06d6a0', '#f72585',
  '#4cc9f0', '#fb923c', '#a3e635', '#c084fc', '#38bdf8',
];

/** Retourne la couleur d'un joueur selon son index */
function colorForIndex(i) {
  return PLAYER_COLORS[i % PLAYER_COLORS.length];
}

// Export universel
if (typeof window !== 'undefined') {
  window.SharedUtils = { fmt, esc, PLAYER_COLORS, colorForIndex };
}
