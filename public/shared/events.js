/**
 * ════════════════════════════════════════════════════════════════
 *  ÉVÉNEMENTS WEBSOCKET — Contrat entre Serveur, Host et Joueurs
 * ════════════════════════════════════════════════════════════════
 *
 *  Ce fichier est la SOURCE UNIQUE DE VÉRITÉ pour tous les noms
 *  d'événements. Importé côté serveur (Node) ET côté client
 *  (navigateur via balise <script>).
 *
 *  Convention de nommage :
 *    host:*   → événement émis PAR le host
 *    player:* → événement émis PAR un joueur
 *    state:*  → événement émis PAR le serveur vers les clients
 * ════════════════════════════════════════════════════════════════
 */

const EVENTS = {
  // ─── HOST → SERVEUR ───
  HOST_HELLO:          'host:hello',          // Le host se déclare
  HOST_PLAYERS_UPDATE: 'host:players-update', // Création/suppression de joueurs
  HOST_TRACK_START:    'host:track-start',    // Lance un morceau (titre masqué)
  HOST_TRACK_REVEAL:   'host:track-reveal',   // Révèle la réponse
  HOST_AWARD_POINT:    'host:award-point',    // Attribue +1 à un joueur (legacy, gardé)
  HOST_APPLY_SCORES:   'host:apply-scores',   // Applique un batch de points (nouveau scoring)
  HOST_RESET_SCORES:   'host:reset-scores',   // Remet tous les scores à 0
  HOST_NEXT_ROUND:     'host:next-round',     // Reset des votes pour la suivante

  // ─── JOUEUR → SERVEUR ───
  PLAYER_JOIN:         'player:join',         // Rejoint avec un pseudo
  PLAYER_LEAVE:        'player:leave',        // Quitte volontairement (= libère le pseudo)
  PLAYER_VOTE:         'player:vote',         // Vote pour un autre joueur

  // ─── SERVEUR → CLIENTS ───
  STATE_FULL:          'state:full',          // État complet à la connexion
  STATE_PLAYERS:       'state:players',       // Liste joueurs + connexion
  STATE_SCORES:        'state:scores',        // Mise à jour des scores
  STATE_ROUND_START:   'state:round-start',   // Nouvelle manche
  STATE_VOTE_RECEIVED: 'state:vote-received', // Un joueur a voté (pour le Host)
  STATE_REVEAL:        'state:reveal',        // Réponse révélée

  // ─── ERREURS ───
  ERROR:               'error:message',
};

// Export universel : Node.js (CommonJS) ET navigateur (window global)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EVENTS;
} else if (typeof window !== 'undefined') {
  window.EVENTS = EVENTS;
}
