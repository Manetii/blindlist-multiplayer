/**
 * ════════════════════════════════════════════════════════════════
 *  ÉVÉNEMENTS WEBSOCKET — Contrat entre Serveur, Host et Joueurs
 * ════════════════════════════════════════════════════════════════
 *
 *  SOURCE UNIQUE DE VÉRITÉ pour tous les noms d'événements. Importé
 *  côté serveur (CommonJS) ET côté navigateur (window.EVENTS).
 *
 *  Conventions :
 *    host:*   émis PAR le PC de l'hôte
 *    player:* émis PAR un téléphone
 *    state:*  émis PAR le serveur vers les clients
 *
 *  ─── DEUX IDENTITÉS, DEUX APPAREILS ─────────────────────────
 *  Le PC de l'hôte prouve la PROPRIÉTÉ de la soirée (hostToken).
 *  Le téléphone prouve une IDENTITÉ DE JOUEUR (participantToken).
 *  L'hôte utilise les deux, sur deux appareils, sans cas particulier :
 *  il rejoint le salon comme n'importe quel participant.
 *
 *  ─── LE SERVEUR NE LANCE JAMAIS UN MORCEAU ──────────────────
 *  L'audio est sur le PC. Quand un automatisme se déclenche (tous ont
 *  voté, tous sont prêts), le serveur émet un HOST_CUE vers le PC, qui
 *  exécute. Le PC perd l'initiative, pas le contrôle.
 * ════════════════════════════════════════════════════════════════
 */

const EVENTS = {
  // ─── HOST → SERVEUR : salon ───
  HOST_OPEN_ROOM:      'host:open-room',      // {code, hostToken} → ack {state, pending}
  HOST_CLOSE_ROOM:     'host:close-room',

  // ─── HOST → SERVEUR : déroulement ───
  HOST_START_ROUND:    'host:start-round',    // {trackId?} — tirage auto si absent
  HOST_REVEAL:         'host:reveal',         // {answer}
  HOST_APPLY_SCORES:   'host:apply-scores',   // {events:[{participantId,points,reason}]}
  HOST_NEXT_ROUND:     'host:next-round',     // clôt la manche, ouvre l'entracte
  HOST_SET_OFFSET:     'host:set-offset',     // {ms} — avance rapide consignée
  HOST_PAUSE:          'host:pause',          // {paused}
  HOST_FORCE_ADVANCE:  'host:force-advance',  // passe outre les « prêt » manquants
  HOST_NEW_SESSION:    'host:new-session',    // rejouer la même playlist

  // ─── JOUEUR → SERVEUR ───
  // Abonnement au canal d'une soirée, AVANT même qu'un salon existe.
  // C'est ce qui permet à l'écran de collecte de basculer tout seul
  // quand l'hôte verrouille ou ouvre le salon.
  PLAYER_WATCH:        'player:watch',        // {token}
  PLAYER_JOIN:         'player:join',         // {token} — plus de pseudo
  PLAYER_VOTE:         'player:vote',         // {votedId}
  PLAYER_READY:        'player:ready',        // {ready}
  PLAYER_LEAVE:        'player:leave',

  // ─── SERVEUR → CLIENTS ───
  STATE_FULL:          'state:full',
  STATE_PLAYERS:       'state:players',
  STATE_ROUND_START:   'state:round-start',   // {trackId, options}
  STATE_VOTE_PROGRESS: 'state:vote-progress', // hôte seul : qui a voté
  STATE_REVEAL:        'state:reveal',        // {answer, votes}
  STATE_SCORES:        'state:scores',
  STATE_INTERMISSION:  'state:intermission',  // entracte ouvert, bouton « prêt »
  STATE_READY_PROGRESS:'state:ready-progress',// {ready, connected, pending}
  STATE_COUNTDOWN:     'state:countdown',     // {seconds} avant lancement
  STATE_PAUSED:        'state:paused',        // {paused}
  STATE_HOST_STATUS:   'state:host-status',   // {online}
  STATE_ROOM_CLOSED:   'state:room-closed',
  STATE_GAME_OVER:     'state:game-over',     // playlist épuisée → podium
  STATE_PARTY_CHANGED: 'state:party-changed', // l'état de la soirée a bougé
  // Les règles se décident dans la console, pas sur l'écran de jeu. Sans
  // cet événement, le salon appliquait bien la nouvelle règle mais le
  // lecteur ouvert continuait d'afficher l'ancienne.
  STATE_SETTINGS:      'state:settings',      // {settings}

  // ─── SERVEUR → HOST : signal d'automatisme ───
  HOST_CUE:            'host:cue',            // {action:'reveal'|'advance', reason}

  ERROR:               'error:message',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EVENTS;
} else if (typeof window !== 'undefined') {
  window.EVENTS = EVENTS;
}
