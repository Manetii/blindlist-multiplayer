/**
 * ════════════════════════════════════════════════════════════════
 *  ROOMS — Le salon, projection chaude de la base
 * ════════════════════════════════════════════════════════════════
 *
 *  CE QUI CHANGE PAR RAPPORT À LA PHASE 1
 *  --------------------------------------
 *  Le salon n'est plus la source de vérité. Il est hydraté depuis la
 *  base à l'ouverture (roster + morceaux jouables) et n'y écrit qu'aux
 *  deux points de bascule d'une manche : le reveal et la validation du
 *  scoring. Aucune écriture dans le chemin critique du jeu.
 *
 *  Trois conséquences structurantes :
 *
 *  1. LES JOUEURS SONT INDEXÉS PAR participantId, PLUS PAR PSEUDO.
 *     Renommer devient gratuit, et une reconnexion ne se joue plus sur
 *     une comparaison de chaînes. Le pseudo n'est qu'un libellé.
 *
 *  2. LES DÉCOMPTES (vote, prêt) NE PORTENT QUE SUR LES CONNECTÉS,
 *     avec un plancher de quorum. Les automatismes de la phase 2
 *     pourraient sinon se figer sur un fantôme.
 *
 *  3. canBeAnswer VIENT DE LA BASE et est FIGÉ à l'ouverture. Un
 *     participant sans morceau jouable est retiré de la grille de
 *     vote : tout vote pour lui serait faux par construction, et il
 *     encaisserait des points de bluffeur sans rien faire.
 *
 *  Voir TOUR-RESILIENCE.md pour le détail des cas de déconnexion.
 * ════════════════════════════════════════════════════════════════
 */

const partyRepo       = require('./repos/party.repo');
const participantRepo = require('./repos/participant.repo');
const trackRepo       = require('./repos/track.repo');
const sessionRepo     = require('./repos/session.repo');

const ROOM_TTL_MS     = 3 * 60 * 60 * 1000;   // salon dormant → purge
const MAX_ROOMS       = 60;
const REVEAL_GRACE_MS = 500;                   // votes auto-validés au reveal
const QUORUM_FLOOR    = 2;                     // pas d'automatisme en dessous

/** Map<code, room> — uniquement les salons ouverts. */
const rooms = new Map();

// ─── Heuristique du moment clé ──────────────────────────────────

/**
 * Où démarrer la lecture par défaut.
 *
 * 25 % tombe souvent sur le premier refrain d'un format pop. Mais sur
 * un morceau de sept minutes, 25 % projette en plein solo — d'où le
 * plafond à 50 s : assez pour dépasser n'importe quelle intro, jamais
 * assez pour se perdre au milieu.
 */
function skipIntroOffsetMs(durationMs, pct = 25) {
  if (!durationMs || durationMs < 30_000) return 0;
  const share = Math.min(50, Math.max(0, Number(pct)));
  if (!share) return 0;
  // Plafond absolu conservé : sur un morceau de huit minutes, 25 %
  // placeraient le départ à deux minutes — bien après le moment où la
  // salle a décroché.
  return Math.round(Math.min(durationMs * (share / 100), 50_000));
}

// ─── Ouverture / fermeture ──────────────────────────────────────

function emptyRound() {
  return {
    active: false, revealed: false,
    roundId: null, trackId: null,
    votes: new Map(),          // Map<participantId, {votedId, castAt}>
    answer: null, revealedAt: null,
    startOffsetMs: null,
  };
}

/**
 * Ouvre un salon pour une soirée, hydraté depuis la base.
 *
 * Idempotent : si le salon existe déjà en RAM (hôte qui recharge sa
 * console), on le rend tel quel avec le nouveau socket. Idem côté
 * base, où sessionRepo.open() réutilise la session ouverte.
 */
async function openRoom(party, hostSocketId) {
  const existing = rooms.get(party.code);
  if (existing) {
    existing.hostSocketId = hostSocketId;
    existing.lastActivity = Date.now();
    return { room: existing, resumed: true };
  }

  sweep();
  if (rooms.size >= MAX_ROOMS) {
    return { error: 'Trop de salons ouverts sur ce serveur.' };
  }

  const { session } = await sessionRepo.open(party.id);
  const [roster, tracks, played, standings] = await Promise.all([
    participantRepo.roster(party.id),
    trackRepo.playable(party.id),
    sessionRepo.playedTrackIds(session.id),
    sessionRepo.standings(session.id),
  ]);

  // Les scores repartent du journal, pas de zéro : un salon rouvert
  // après un plantage retrouve la partie où elle en était.
  const scoreById = new Map(standings.map(s => [s.participant_id, s.score]));

  const room = {
    code:         party.code,
    partyId:      party.id,
    partyName:    party.name,
    sourceMode:   party.source_mode || 'fichiers',
    sessionId:    session.id,
    hostSocketId: hostSocketId || null,

    settings: {
      autoReveal:  party.auto_reveal_on_all_votes,
      autoAdvance: party.auto_advance_on_all_ready,
      blufferRule: party.rule_bluffer_enabled,
      trapperRule: party.rule_trapper_enabled,
      hideIndices: party.hide_indices_default,
      keyMomentPct: party.key_moment_pct,
    },

    // Map<participantId, joueur>
    players: new Map(roster.map(p => [p.id, {
      id:          p.id,
      name:        p.display_name,
      color:       p.color,
      canBeAnswer: p.can_be_answer,
      score:       scoreById.get(p.id) || 0,
      socketId:    null,
      connected:   false,
      ready:       false,
    }])),

    tracks,                                  // morceaux jouables
    playedTrackIds: new Set(played),         // reprise après plantage
    round:   emptyRound(),
    paused:  false,
    createdAt:    Date.now(),
    lastActivity: Date.now(),
  };

  rooms.set(party.code, room);
  console.log(
    `[salon ${party.code}] ouvert — ${room.players.size} joueur(s), ` +
    `${tracks.length} morceau(x), ${played.length} déjà joué(s)`
  );
  return { room, resumed: false };
}

function getRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (room) room.lastActivity = Date.now();
  return room || null;
}

async function closeRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return false;
  await sessionRepo.close(room.sessionId).catch(err =>
    console.error(`[salon ${code}] fermeture session :`, err.message));
  rooms.delete(room.code);
  console.log(`[salon ${room.code}] fermé`);
  return true;
}

function sweep() {
  const now = Date.now();
  let purged = 0;
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
      purged++;
      sessionRepo.close(room.sessionId).catch(() => {});
    }
  }
  if (purged) console.log(`[salon] ${purged} salon(s) dormant(s) purgé(s)`);
  return purged;
}

/**
 * Répercute un changement de réglage sur un salon déjà ouvert.
 *
 * Le salon copie les réglages à son ouverture. Sans cette mise à jour,
 * modifier une règle ou le point de départ en cours de soirée n'avait
 * aucun effet jusqu'à la fermeture du salon — un réglage qui semble
 * enregistré mais ne change rien est pire que pas de réglage du tout.
 */
function applySettings(code, party) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room || !party) return false;
  room.settings = {
    autoReveal:  party.auto_reveal_on_all_votes,
    autoAdvance: party.auto_advance_on_all_ready,
    blufferRule: party.rule_bluffer_enabled,
    trapperRule: party.rule_trapper_enabled,
    hideIndices: party.hide_indices_default,
    keyMomentPct: party.key_moment_pct,
  };
  room.lastActivity = Date.now();
  return true;
}

function isHost(room, socketId) {
  return !!room && room.hostSocketId === socketId;
}

function stats() {
  return {
    rooms: rooms.size,
    players: [...rooms.values()].reduce(
      (n, r) => n + [...r.players.values()].filter(p => p.connected).length, 0),
  };
}

// ─── Présence ───────────────────────────────────────────────────

/**
 * Un participant rejoint le salon. Son identité vient du jeton, résolu
 * en amont : plus aucune comparaison de pseudo, donc plus de conflit
 * possible entre deux appareils portant le même nom.
 *
 * Un participant absent du roster (ajouté par l'hôte APRÈS l'ouverture,
 * cas du retardataire) est intégré à chaud, sans morceau et donc hors
 * de la grille de vote.
 */
function joinPlayer(room, participantId, socketId, fallback = null) {
  let player = room.players.get(participantId);

  if (!player) {
    if (!fallback) return { ok: false, reason: 'Participant inconnu de ce salon.' };
    player = {
      id: participantId,
      name: fallback.display_name,
      color: fallback.color,
      canBeAnswer: false,        // arrivé après le verrouillage
      score: 0, socketId: null, connected: false, ready: false,
    };
    room.players.set(participantId, player);
    console.log(`[salon ${room.code}] ${player.name} intégré à chaud (sans morceau)`);
  }

  const previousSocket = player.socketId;
  player.socketId  = socketId;
  player.connected = true;
  room.lastActivity = Date.now();

  return { ok: true, player, previousSocket, reconnected: !!previousSocket };
}

function markDisconnected(room, socketId) {
  if (!room) return null;
  if (room.hostSocketId === socketId) {
    room.hostSocketId = null;
    return { what: 'host' };
  }
  for (const p of room.players.values()) {
    if (p.socketId === socketId) {
      p.connected = false;
      p.socketId  = null;
      return { what: 'player', player: p };
    }
  }
  // Socket fantôme dont la place a déjà été reprise : le marquer
  // déconnecté effacerait la connexion valide qui l'a remplacé.
  return null;
}

function playerBySocket(room, socketId) {
  if (!room) return null;
  for (const p of room.players.values()) {
    if (p.socketId === socketId) return p;
  }
  return null;
}

function connectedPlayers(room) {
  return [...room.players.values()].filter(p => p.connected);
}

// ─── Manche ─────────────────────────────────────────────────────

/** Tirage aléatoire parmi les morceaux non encore joués. */
function pickNextTrack(room) {
  const remaining = room.tracks.filter(t => !room.playedTrackIds.has(t.id));
  if (!remaining.length) return null;
  return remaining[Math.floor(Math.random() * remaining.length)];
}

async function startRound(room, trackId) {
  const track = room.tracks.find(t => t.id === trackId);
  if (!track) return { ok: false, reason: 'Morceau absent de cette playlist.' };

  // Démarrer au début est un choix de soirée : certaines intros sont
  // justement la partie la plus reconnaissable. 0 % exprime ce choix.
  const startOffsetMs = skipIntroOffsetMs(
    track.duration_ms,
    room.settings.keyMomentPct === undefined ? 25 : room.settings.keyMomentPct
  );
  const round = await sessionRepo.startRound(room.sessionId, track.id, startOffsetMs);

  room.round = {
    ...emptyRound(),
    active: true,
    roundId: round.id,
    trackId: track.id,
    startOffsetMs,
  };
  room.playedTrackIds.add(track.id);
  // Remise à zéro des « prêt » pour l'entracte qui suivra le reveal.
  clearReady(room);
  room.lastActivity = Date.now();

  return { ok: true, round, track, startOffsetMs };
}

/**
 * Enregistre un vote. Votant et voté sont des participantId.
 *
 * Un vote pour quelqu'un qui ne peut pas être la réponse est refusé :
 * il ne devrait même pas apparaître dans la grille.
 */
function recordVote(room, voterId, votedId) {
  if (!room.round.active) return { ok: false, reason: 'Aucune manche en cours.' };
  if (voterId === votedId) return { ok: false, reason: 'Impossible de voter pour soi.' };

  const target = room.players.get(votedId);
  if (!target) return { ok: false, reason: 'Joueur inconnu.' };
  if (!target.canBeAnswer) return { ok: false, reason: 'Ce joueur n\'a proposé aucun morceau.' };

  if (room.round.revealed) {
    // Fenêtre de grâce : les votes auto-validés au moment du reveal
    // arrivent juste après. On les accepte encore.
    const elapsed = Date.now() - (room.round.revealedAt || 0);
    if (elapsed > REVEAL_GRACE_MS) return { ok: false, reason: 'Trop tard.' };
  }

  room.round.votes.set(voterId, { votedId, castAt: new Date() });
  room.lastActivity = Date.now();
  return { ok: true };
}

/**
 * Tout le monde a-t-il voté ? Alimente l'auto-reveal.
 *
 * Dénominateur = joueurs CONNECTÉS. Un téléphone en veille ne bloque
 * rien. Le plancher de quorum évite qu'une coupure générale n'enchaîne
 * toute la playlist dans le vide.
 */
function voteTally(room) {
  const connected = connectedPlayers(room);
  const voted = connected.filter(p => room.round.votes.has(p.id));
  return {
    voted: voted.length,
    connected: connected.length,
    total: room.players.size,
    complete: connected.length >= QUORUM_FLOOR && voted.length === connected.length,
    pending: connected.filter(p => !room.round.votes.has(p.id)).map(p => p.name),
    // Identifiants, pour que le panneau de l'hôte marque les lignes
    // sans faire correspondre des pseudos. Ce sont les VOTANTS
    // manquants, jamais leurs bulletins.
    pendingIds: connected.filter(p => !room.round.votes.has(p.id)).map(p => p.id),
  };
}

function revealAnswer(room, answer) {
  room.round.revealed   = true;
  room.round.answer     = answer;
  room.round.revealedAt = Date.now();
  room.lastActivity     = Date.now();
  return votesAsArray(room);
}

function votesAsArray(room) {
  return [...room.round.votes.entries()].map(([voterId, v]) => ({
    voterId,
    votedId: v.votedId,
    castAt:  v.castAt,
    voter:   (room.players.get(voterId) || {}).name,
    voted:   (room.players.get(v.votedId) || {}).name,
  }));
}

/** Persiste les votes et horodate la manche comme révélée. */
async function persistReveal(room) {
  if (!room.round.roundId) return null;
  return sessionRepo.commitReveal(room.round.roundId, votesAsArray(room));
}

/** Persiste les deltas de score et met à jour les totaux en RAM. */
async function persistScores(room, events) {
  if (!room.round.roundId) return 0;
  const written = await sessionRepo.commitScores(room.round.roundId, events);
  for (const e of events) {
    const p = room.players.get(e.participantId);
    if (p) p.score += e.points;
  }
  room.lastActivity = Date.now();
  return written;
}

function resetRound(room) {
  room.round = emptyRound();
}

// ─── Préparation (entracte) ─────────────────────────────────────

function setReady(room, participantId, ready = true) {
  const p = room.players.get(participantId);
  if (!p) return { ok: false };
  p.ready = !!ready;
  room.lastActivity = Date.now();
  return { ok: true, player: p };
}

/**
 * Tout le monde est-il prêt ? Alimente l'auto-advance.
 *
 * Même logique de dénominateur que voteTally. Une partie en pause
 * neutralise le décompte : c'est tout le sens du bouton pause côté
 * hôte, qui gèle aussi le délai de 5 min géré par les handlers.
 */
function readyTally(room) {
  const connected = connectedPlayers(room);
  const ready = connected.filter(p => p.ready);
  return {
    ready: ready.length,
    connected: connected.length,
    complete: !room.paused
           && connected.length >= QUORUM_FLOOR
           && ready.length === connected.length,
    pending: connected.filter(p => !p.ready).map(p => p.name),
    // Les identifiants permettent à chaque client de savoir si LUI est
    // prêt, sans comparer des pseudos.
    pendingIds: connected.filter(p => !p.ready).map(p => p.id),
  };
}

function clearReady(room) {
  for (const p of room.players.values()) p.ready = false;
}

function setPaused(room, paused) {
  room.paused = !!paused;
  room.lastActivity = Date.now();
  return room.paused;
}

// ─── Sérialisation ──────────────────────────────────────────────

function publicPlayers(room) {
  // `voted` : le FAIT d'avoir voté, jamais POUR QUI. Le panneau de
  // l'hôte doit pouvoir nommer les retardataires sans que l'écran que
  // la salle regarde trahisse un seul bulletin.
  const voted = room.round.active ? room.round.votes : null;
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, color: p.color,
    score: p.score, connected: p.connected,
    ready: p.ready, canBeAnswer: p.canBeAnswer,
    voted: voted ? voted.has(p.id) : false,
  }));
}

/** Grille de vote d'un joueur : les autres, hors non-éligibles. */
function voteOptions(room, voterId) {
  return [...room.players.values()]
    .filter(p => p.canBeAnswer && p.id !== voterId)
    .map(p => ({ id: p.id, name: p.name, color: p.color }));
}

function fullState(room) {
  return {
    room: {
      code: room.code,
      name: room.partyName,
      // Détermine le moteur de lecture côté console : fichiers locaux
      // ou fenêtre YouTube.
      sourceMode: room.sourceMode || 'fichiers',
      hostOnline: !!room.hostSocketId,
      paused: room.paused,
      tracksTotal:  room.tracks.length,
      tracksPlayed: room.playedTrackIds.size,
      // La liste, pas seulement le compte : c'est ce qui permet à une
      // console rechargée en pleine partie de retrouver quels morceaux
      // sont déjà passés. Sans elle, un rafraîchissement remettait la
      // playlist entière dans le tirage.
      playedTrackIds: [...room.playedTrackIds],
      settings:     room.settings,
    },
    players: publicPlayers(room),
    round: {
      active:   room.round.active,
      revealed: room.round.revealed,
      trackId:  room.round.trackId,
      answer:   room.round.answer,
      votes:    room.round.revealed ? votesAsArray(room) : [],
    },
  };
}

// ─── Ramasse-miettes ────────────────────────────────────────────

let sweepTimer = null;

function startSweeper(intervalMs = 10 * 60 * 1000) {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweep();
    partyRepo.archiveStale().catch(err =>
      console.error('[salon] archivage :', err.message));
  }, intervalMs);
  if (sweepTimer.unref) sweepTimer.unref();
}

function stopSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = {
  openRoom, getRoom, closeRoom, sweep, startSweeper, stopSweeper,
  isHost, stats, skipIntroOffsetMs, applySettings,
  joinPlayer, markDisconnected, playerBySocket, connectedPlayers,
  pickNextTrack, startRound, recordVote, voteTally,
  revealAnswer, persistReveal, persistScores, resetRound, votesAsArray,
  setReady, readyTally, clearReady, setPaused,
  publicPlayers, voteOptions, fullState,
  QUORUM_FLOOR, ROOM_TTL_MS,
};
