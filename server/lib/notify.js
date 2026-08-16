/**
 * ════════════════════════════════════════════════════════════════
 *  NOTIFY — pousser les changements d'état d'une soirée
 * ════════════════════════════════════════════════════════════════
 *
 *  La phase asynchrone (collecte, attente) n'avait aucun canal temps
 *  réel : un participant restait sur « envois clos » jusqu'à ce qu'il
 *  recharge la page. Le sondage périodique ajouté ensuite fonctionnait
 *  mais avec vingt secondes de retard — assez pour donner l'impression
 *  que rien ne se passe.
 *
 *  Ce module donne aux routes HTTP un moyen d'émettre vers les sockets,
 *  sans que les dépôts ni les routes aient à connaître Socket.io. Le
 *  serveur enregistre l'instance au démarrage ; tout le reste appelle
 *  simplement partyChanged().
 *
 *  Les participants s'abonnent au canal `party:<code>` dès le
 *  chargement de leur page, avant même d'être dans un salon.
 * ════════════════════════════════════════════════════════════════
 */

let io = null;

function attach(instance) {
  io = instance;
}

const channel = (code) => `party:${String(code || '').toUpperCase()}`;

/**
 * Signale que l'état d'une soirée a changé.
 *
 * Le message ne porte que l'état, pas les données : chaque client
 * redemande ce qui le concerne via /api/me. Pousser l'état complet
 * obligerait à filtrer par destinataire, et un participant n'a pas à
 * recevoir le panier des autres.
 */
function partyChanged(code, state, extra = {}) {
  if (!io || !code) return;
  io.to(channel(code)).emit('state:party-changed', { state, ...extra });
}

/** Le salon vient d'ouvrir ou de fermer. */
function roomChanged(code, open) {
  if (!io || !code) return;
  io.to(channel(code)).emit('state:party-changed', { roomOpen: open });
}

module.exports = { attach, partyChanged, roomChanged, channel };
