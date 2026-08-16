/**
 * ════════════════════════════════════════════════════════════════
 *  REPO — Sessions de jeu
 * ════════════════════════════════════════════════════════════════
 *
 *  Empreinte persistante du salon, pas son moteur.
 *
 *  RYTHME D'ÉCRITURE
 *  -----------------
 *  Pendant une manche, votes et états de préparation vivent en RAM
 *  (server/rooms.js). La base n'est sollicitée qu'aux deux points de
 *  bascule :
 *
 *    commitReveal()  au reveal — écrit les votes en bloc
 *    commitScores()  à la validation du scoring — écrit les deltas
 *
 *  Aucune écriture dans le chemin critique du jeu : un vote ne doit
 *  jamais attendre un aller-retour base.
 *
 *  REPRISE
 *  -------
 *  pendingForHost() répond à « où en est-on ? » à un hôte qui revient
 *  après une coupure. Sans elle, une déconnexion en pleine manche
 *  laisserait la partie dans un état irrécupérable — c'est le seul
 *  blocage irréductible identifié dans TOUR-RESILIENCE.md.
 * ════════════════════════════════════════════════════════════════
 */

const db = require('../db');

// ─── Sessions ───────────────────────────────────────────────────

/**
 * Ouvre une session de jeu pour une soirée.
 *
 * L'index partiel one_open_session_per_party garantit qu'une seule
 * session est ouverte à la fois : deux salons concurrents sur la même
 * playlist produiraient deux podiums contradictoires.
 */
async function open(partyId) {
  return db.tx(async (t) => {
    const existing = await t.one(
      `SELECT id, party_id, opened_at FROM sessions
        WHERE party_id = $1 AND closed_at IS NULL`,
      [partyId]
    );
    // Réouverture idempotente : un hôte qui recharge sa console ne doit
    // pas créer une seconde session.
    if (existing) return { session: existing, resumed: true };

    const session = await t.one(
      `INSERT INTO sessions (party_id) VALUES ($1)
       RETURNING id, party_id, opened_at`,
      [partyId]
    );
    await t.query('UPDATE parties SET last_activity_at = now() WHERE id = $1', [partyId]);
    return { session, resumed: false };
  });
}

async function findOpen(partyId) {
  return db.one(
    `SELECT id, party_id, opened_at FROM sessions
      WHERE party_id = $1 AND closed_at IS NULL`,
    [partyId]
  );
}

/** Ferme la session et bascule la soirée en 'terminee'. */
async function close(sessionId) {
  return db.tx(async (t) => {
    const session = await t.one(
      `UPDATE sessions SET closed_at = now()
        WHERE id = $1 AND closed_at IS NULL
       RETURNING id, party_id, opened_at, closed_at`,
      [sessionId]
    );
    if (!session) return null;

    await t.query(
      `UPDATE parties
          SET state = CASE WHEN state = 'prete' THEN 'terminee'::party_state ELSE state END,
              last_activity_at = now()
        WHERE id = $1`,
      [session.party_id]
    );
    return session;
  });
}

// ─── Manches ────────────────────────────────────────────────────

/**
 * Démarre une manche. Le numéro d'ordre est calculé côté base pour
 * éviter toute course entre deux démarrages rapprochés.
 *
 * @param {number|null} startOffsetMs  où la lecture démarre réellement
 *   (heuristique 25 %, ou valeur choisie par l'hôte au ressenti)
 */
async function startRound(sessionId, trackId, startOffsetMs = null) {
  return db.one(
    `INSERT INTO rounds (session_id, track_id, order_no, start_offset_ms)
     SELECT $1, $2,
            coalesce(max(order_no), 0) + 1,
            $3
       FROM rounds WHERE session_id = $1
     RETURNING id, session_id, track_id, order_no, start_offset_ms, started_at`,
    [sessionId, trackId, startOffsetMs]
  );
}

/** Corrige l'offset a posteriori si l'hôte a avancé pendant la lecture. */
async function updateStartOffset(roundId, startOffsetMs) {
  return db.one(
    `UPDATE rounds SET start_offset_ms = $2 WHERE id = $1
     RETURNING id, start_offset_ms`,
    [roundId, startOffsetMs]
  );
}

/**
 * Écrit les votes de la manche et l'horodate comme révélée.
 *
 * Idempotent : ON CONFLICT DO UPDATE permet de rejouer l'appel si
 * l'hôte a été déconnecté au mauvais moment et recommence.
 *
 * @param {Array<{voterId:string, votedId:string, castAt?:Date}>} votes
 */
async function commitReveal(roundId, votes = []) {
  return db.tx(async (t) => {
    for (const v of votes) {
      // no_self_vote est une contrainte : on filtre en amont plutôt que
      // de faire échouer toute la transaction sur une donnée aberrante.
      if (!v.voterId || !v.votedId || v.voterId === v.votedId) continue;
      await t.query(
        `INSERT INTO votes (round_id, voter_id, voted_id, cast_at)
         VALUES ($1,$2,$3, coalesce($4, now()))
         ON CONFLICT (round_id, voter_id)
         DO UPDATE SET voted_id = excluded.voted_id, cast_at = excluded.cast_at`,
        [roundId, v.voterId, v.votedId, v.castAt || null]
      );
    }
    const round = await t.one(
      `UPDATE rounds SET revealed_at = coalesce(revealed_at, now())
        WHERE id = $1 RETURNING id, order_no, revealed_at`,
      [roundId]
    );
    return { round, votes: votes.length };
  });
}

/**
 * Écrit les deltas de score de la manche.
 *
 * On remplace intégralement les événements de cette manche plutôt que
 * d'ajouter : si l'hôte revalide après correction, le total ne doit pas
 * doubler.
 *
 * @param {Array<{participantId:string, points:number, reason:string}>} events
 */
async function commitScores(roundId, events = []) {
  return db.tx(async (t) => {
    await t.query('DELETE FROM score_events WHERE round_id = $1', [roundId]);
    let written = 0;
    for (const e of events) {
      if (!e.participantId || !e.points) continue;   // points = 0 interdit par contrainte
      await t.query(
        `INSERT INTO score_events (round_id, participant_id, points, reason)
         VALUES ($1,$2,$3,$4)`,
        [roundId, e.participantId, e.points, e.reason || 'manual']
      );
      written++;
    }
    return written;
  });
}

// ─── Lecture ────────────────────────────────────────────────────

/** Classement, reconstruit depuis le journal des deltas. */
async function standings(sessionId) {
  return db.many(
    `SELECT participant_id, display_name, color, score
       FROM v_session_standings
      WHERE session_id = $1
      ORDER BY score DESC, display_name`,
    [sessionId]
  );
}

/** Morceaux déjà joués — évite de retomber deux fois sur le même. */
async function playedTrackIds(sessionId) {
  const rows = await db.many(
    'SELECT track_id FROM rounds WHERE session_id = $1', [sessionId]
  );
  return rows.map(r => r.track_id);
}

async function roundDetail(roundId) {
  const round = await db.one(
    `SELECT r.id, r.session_id, r.track_id, r.order_no,
            r.start_offset_ms, r.started_at, r.revealed_at,
            t.title, t.artist, t.album, t.artwork_url,
            pa.id AS answer_participant_id, pa.display_name AS answer_name
       FROM rounds r
       JOIN tracks t ON t.id = r.track_id
       JOIN participants pa ON pa.id = t.participant_id
      WHERE r.id = $1`,
    [roundId]
  );
  if (!round) return null;
  round.votes = await db.many(
    `SELECT v.voter_id, v.voted_id, v.cast_at,
            vr.display_name AS voter_name, vd.display_name AS voted_name
       FROM votes v
       JOIN participants vr ON vr.id = v.voter_id
       JOIN participants vd ON vd.id = v.voted_id
      WHERE v.round_id = $1
      ORDER BY v.cast_at`,
    [roundId]
  );
  return round;
}

/**
 * « Où en est-on ? » — restitué à un hôte qui revient après coupure.
 *
 * pendingAction dit exactement ce qui reste à faire :
 *   'none'    rien en cours, on peut lancer une manche
 *   'reveal'  une manche est ouverte, la réponse n'a pas été révélée
 *   'scores'  la manche est révélée mais le scoring n'est pas validé
 */
async function pendingForHost(partyId) {
  const session = await findOpen(partyId);
  if (!session) return { session: null, pendingAction: 'none' };

  const round = await db.one(
    `SELECT id, track_id, order_no, started_at, revealed_at
       FROM rounds WHERE session_id = $1
      ORDER BY order_no DESC LIMIT 1`,
    [session.id]
  );
  if (!round) return { session, round: null, pendingAction: 'none' };

  if (!round.revealed_at) {
    return { session, round, pendingAction: 'reveal' };
  }

  const scored = await db.one(
    'SELECT count(*)::int AS n FROM score_events WHERE round_id = $1',
    [round.id]
  );
  return {
    session,
    round,
    pendingAction: scored.n > 0 ? 'none' : 'scores',
  };
}

// ─── Administration ─────────────────────────────────────────────

async function listByParty(partyId) {
  return db.many(
    `SELECT s.id, s.opened_at, s.closed_at,
            (SELECT count(*) FROM rounds r WHERE r.session_id = s.id)::int AS rounds
       FROM sessions s WHERE s.party_id = $1
      ORDER BY s.opened_at DESC`,
    [partyId]
  );
}

module.exports = {
  open, findOpen, close,
  startRound, updateStartOffset, commitReveal, commitScores,
  standings, playedTrackIds, roundDetail, pendingForHost, listByParty,
};
