/**
 * ════════════════════════════════════════════════════════════════
 *  ÉTAT DU SALON — vocabulaire commun à toutes les vues
 * ════════════════════════════════════════════════════════════════
 *
 *  La base connaît cinq états de soirée (collecte, verrouillee, prete,
 *  en_jeu, archivee) et le socket sait par ailleurs si un salon est
 *  ouvert. Trois écrans exposaient ça de trois façons : « collecte » en
 *  petites capitales sur la console, une pastille verte sans mot sur le
 *  lecteur, rien du tout côté joueur.
 *
 *  Ce que quelqu'un veut lire dans une barre du haut, ce n'est pas
 *  l'état de la ligne en base : c'est où en est la salle. D'où quatre
 *  mots, et quatre seulement.
 * ════════════════════════════════════════════════════════════════
 */

window.RoomStatus = (() => {
  const LABELS = {
    offline: 'Hors ligne',
    prep:    'En préparation',
    online:  'En ligne',
    live:    'En jeu',
  };

  /**
   * Projette l'état réel sur l'un des quatre mots.
   *
   * @param {object} o
   * @param {string} [o.partyState] état de la soirée en base
   * @param {boolean} [o.roomOpen]  un salon est ouvert
   * @param {boolean} [o.connected] la socket de CE client tient
   * @param {boolean} [o.roundActive] une manche est en cours
   */
  function resolve({ partyState, roomOpen, connected, roundActive } = {}) {
    // La déconnexion prime : afficher « en jeu » à quelqu'un dont le
    // fil est coupé lui ferait attendre une mise à jour qui ne viendra
    // pas.
    if (connected === false) return 'offline';
    if (roundActive) return 'live';
    if (roomOpen) return 'online';
    if (partyState === 'archivee') return 'offline';
    if (partyState) return 'prep';
    return 'offline';
  }

  /** Écrit nom et état dans un bloc `.room-status`. */
  function render(el, { name, ...rest } = {}) {
    if (!el) return;
    const state = resolve(rest);
    const nameEl = el.querySelector('.rs-name');
    const dotEl  = el.querySelector('.rs-dot');
    const txtEl  = el.querySelector('.rs-label');
    if (nameEl && name !== undefined) nameEl.textContent = name;
    if (dotEl) dotEl.dataset.state = state;
    if (txtEl) txtEl.textContent = LABELS[state];
  }

  return { resolve, render, LABELS };
})();
