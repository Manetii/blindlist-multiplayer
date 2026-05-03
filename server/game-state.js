/**
 * ════════════════════════════════════════════════════════════════
 *  ÉTAT DU JEU — Singleton en mémoire
 * ════════════════════════════════════════════════════════════════
 *
 *  Stocke en RAM tout ce qui est nécessaire pour relayer le jeu :
 *    - Liste des joueurs (pseudo, score, couleur, connecté ou non)
 *    - Le morceau en cours (sans titre/artiste, le Host garde ça)
 *    - Les votes de la manche courante
 *    - Le statut "révélé" ou non
 *
 *  PAS de persistance — tout est perdu au redémarrage du serveur,
 *  c'est volontaire (chef d'orchestre éphémère).
 *
 *  Le HOST est identifié par socket.id et reste en mémoire pour
 *  pouvoir lui adresser des messages (ex: réceptions de votes).
 * ════════════════════════════════════════════════════════════════
 */

const PLAYER_COLORS = [
  '#00e5ff', '#ff6b6b', '#ffd166', '#06d6a0', '#f72585',
  '#4cc9f0', '#fb923c', '#a3e635', '#c084fc', '#38bdf8',
];

const state = {
  hostSocketId: null,

  // Map<pseudo, { name, color, score, socketId|null, connected }>
  players: new Map(),

  // Manche en cours
  round: {
    active:    false,        // un morceau a été lancé
    revealed:  false,        // la réponse est révélée
    trackId:   null,         // identifiant du morceau (côté host)
    votes:     new Map(),    // Map<voterPseudo, votedPseudo>
    answer:    null,         // { title, artist, player, art } — défini au reveal
  },

  // True dès que le 1er tour a démarré. Reset uniquement au reset complet
  // côté Host (qui réenvoie un nouvel ensemble de joueurs).
  matchStarted: false,
};

// ─── HOST ──────────────────────────────────────────────────────

function setHost(socketId) {
  state.hostSocketId = socketId;
}

function isHost(socketId) {
  return state.hostSocketId === socketId;
}

// ─── PLAYERS ───────────────────────────────────────────────────

/** Synchronisation depuis le Host : crée/met à jour les joueurs */
function syncPlayersFromHost(playerList) {
  // playerList = [{ name, color }, ...]  (le host envoie pseudos + couleurs)
  const incoming = new Set(playerList.map(p => p.name));

  // Suppressions : joueurs qui n'existent plus côté Host
  for (const name of state.players.keys()) {
    if (!incoming.has(name)) state.players.delete(name);
  }

  // Ajouts / mises à jour
  playerList.forEach((p, i) => {
    const existing = state.players.get(p.name);
    if (existing) {
      existing.color = p.color || PLAYER_COLORS[i % PLAYER_COLORS.length];
    } else {
      state.players.set(p.name, {
        name:      p.name,
        color:     p.color || PLAYER_COLORS[i % PLAYER_COLORS.length],
        score:     0,
        socketId:  null,
        connected: false,
      });
    }
  });

  // Si la liste est vide (cas typique : Reset complet côté Host),
  // on remet le state du match à zéro pour que les joueurs qui
  // se reconnecteront ensuite démarrent une "nouvelle partie".
  if (playerList.length === 0) {
    state.matchStarted = false;
    state.round = {
      active: false, revealed: false, trackId: null,
      votes: new Map(), answer: null, revealedAt: null,
    };
  }
}

/** Un joueur rejoint avec un pseudo (peut être une reconnexion) */
function joinPlayer(socketId, pseudo) {
  const p = state.players.get(pseudo);
  if (!p) {
    return { ok: false, reason: 'Pseudo inconnu — demande au Host de t\'ajouter.' };
  }
  // Si déjà connecté ailleurs avec un autre socket → REJET (au lieu de remplacer)
  // Le joueur sur l'autre appareil garde sa connexion. Celui qui essaie de
  // rejoindre voit un message clair et reste sur l'écran de saisie.
  if (p.connected && p.socketId && p.socketId !== socketId) {
    return {
      ok: false,
      reason: `Le pseudo "${pseudo}" est déjà connecté sur un autre appareil. ` +
              `Si c'est ton autre téléphone/tablette, déconnecte-le d'abord.`,
      conflict: true,
    };
  }
  // Sinon : connexion ou reconnexion (le slot était libre ou c'est le même socket)
  const wasReconnect = !p.connected;
  p.socketId  = socketId;
  p.connected = true;
  return { ok: true, player: p, reconnected: wasReconnect };
}

/** Marque un socket comme déconnecté (sans supprimer le joueur) */
function markDisconnected(socketId) {
  if (socketId === state.hostSocketId) {
    state.hostSocketId = null;
    return;
  }
  for (const p of state.players.values()) {
    if (p.socketId === socketId) {
      p.connected = false;
      p.socketId  = null;
    }
  }
}

/** Retourne un joueur par son socketId */
function playerBySocket(socketId) {
  for (const p of state.players.values()) {
    if (p.socketId === socketId) return p;
  }
  return null;
}

// ─── ROUND ─────────────────────────────────────────────────────

function startRound(trackId) {
  state.round = {
    active:    true,
    revealed:  false,
    trackId,
    votes:     new Map(),
    answer:    null,
    revealedAt: null,
  };
  state.matchStarted = true;
}

// Fenêtre de grâce après le reveal pendant laquelle les votes auto-validés
// envoyés par les clients (qui découvrent le reveal en même temps) sont
// encore acceptés. Évite que les étourdis ne perdent leur tour.
const REVEAL_GRACE_MS = 500;

function recordVote(voterPseudo, votedPseudo) {
  if (!state.round.active) return false;
  if (state.round.revealed) {
    // Vote en retard : on l'accepte si on est encore dans la fenêtre de grâce
    const elapsed = Date.now() - (state.round.revealedAt || 0);
    if (elapsed > REVEAL_GRACE_MS) return false;
  }
  state.round.votes.set(voterPseudo, votedPseudo);
  return true;
}

function revealAnswer(answer) {
  state.round.revealed   = true;
  state.round.answer     = answer;
  state.round.revealedAt = Date.now();
}

function awardPoint(pseudo) {
  const p = state.players.get(pseudo);
  if (p) p.score += 1;
}

// ─── SÉRIALISATION pour les clients ────────────────────────────

/** Liste publique des joueurs (sans socketId) */
function publicPlayers() {
  return Array.from(state.players.values()).map(p => ({
    name:      p.name,
    color:     p.color,
    score:     p.score,
    connected: p.connected,
  }));
}

/** Liste des votes (visible côté Host uniquement) */
function publicVotes() {
  return Array.from(state.round.votes.entries())
    .map(([voter, voted]) => ({ voter, voted }));
}

/** Snapshot complet pour un client qui se connecte */
function fullState() {
  return {
    players: publicPlayers(),
    matchStarted: state.matchStarted,
    round:   {
      active:   state.round.active,
      revealed: state.round.revealed,
      trackId:  state.round.trackId,
      votes:    publicVotes(),
      answer:   state.round.answer,
    },
  };
}

module.exports = {
  // host
  setHost, isHost,
  // players
  syncPlayersFromHost, joinPlayer, markDisconnected, playerBySocket,
  // round
  startRound, recordVote, revealAnswer, awardPoint,
  // serialization
  publicPlayers, publicVotes, fullState,
  // raw access (pour les handlers)
  _state: state,
};
