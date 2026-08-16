/**
 * Test d'intégration — une partie complète, contre une vraie base.
 *
 *   DATABASE_URL=postgres://... node server/test/session.test.js
 *
 * Couvre le protocole décrit dans TOUR-RESILIENCE.md : quorum,
 * déconnexion en cours de manche, reprise de l'hôte, rechargement du
 * salon après plantage.
 */

const path = require('path');
const R  = path.join(__dirname, '..');
const db = require(R + '/db');
const P  = require(R + '/repos/party.repo');
const PA = require(R + '/repos/participant.repo');
const T  = require(R + '/repos/track.repo');
const S  = require(R + '/repos/session.repo');
const Rooms = require(R + '/rooms');

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  ok  ' : 'ECHEC '} ${label}${extra ? ' — ' + extra : ''}`);
};

(async () => {

  // ─── Mise en place d'une soirée prête à jouer ─────────────────
  const { party } = await P.create({ name: 'Test', minTracks: 1, maxTracks: 4 });
  const alice = (await PA.create(party.id, 'Alice')).participant;
  const bob   = (await PA.create(party.id, 'Bob')).participant;
  const cleo  = (await PA.create(party.id, 'Cléo')).participant;

  const mk = (n, dur) => ({
    source: 'spotify', sourceId: 'sp:' + n,
    title: 'Titre ' + n, artist: 'Artiste ' + n, durationMs: dur,
  });
  await T.add(alice.id, mk(1, 240000));
  await T.add(alice.id, mk(2, 200000));
  await T.add(bob.id,   mk(3, 420000));
  await T.add(bob.id,   mk(4, 180000));
  // Cléo n'a rien proposé : elle jouera en pure devinette.

  const lock = await P.lock(party.id);
  ok('verrouillage', lock.numbered === 4);
  const man = await T.manifest(party.id);
  await T.reconcile(party.id, man.map(m => ({
    acquisitionNo: m.acquisition_no, fileName: m.expected_file_name, durationMs: m.duration_ms,
  })));
  const ready = await P.setState(party.id, 'prete');
  ok('soirée prête', ready.state === 'prete');

  // ─── Ouverture du salon ───────────────────────────────────────
  const fresh = await P.findByCode(party.code);
  const { room } = await Rooms.openRoom(fresh, 'socket-host');
  ok('salon hydraté depuis la base', room.players.size === 3 && room.tracks.length === 4);
  ok('scores repartis du journal', Rooms.publicPlayers(room).every(p => p.score === 0));

  const cleoP = room.players.get(cleo.id);
  ok('joueuse sans morceau hors grille', cleoP.canBeAnswer === false);
  ok('grille de vote filtrée',
     Rooms.voteOptions(room, alice.id).map(o => o.name).join(',') === 'Bob',
     'Alice ne peut voter que pour Bob (Cléo exclue, soi-même exclu)');

  // ─── Heuristique du moment clé ────────────────────────────────
  // Le plafond de 50 s mord dès 3 min 20 : au-delà, 25 % emmènerait
  // trop loin dans le morceau.
  ok('heuristique 25 % sous le plafond', Rooms.skipIntroOffsetMs(160000) === 40000);
  ok('plafond 50 s à 4 min',             Rooms.skipIntroOffsetMs(240000) === 50000);
  ok('plafond 50 s à 7 min',             Rooms.skipIntroOffsetMs(420000) === 50000);
  ok('morceau très court',               Rooms.skipIntroOffsetMs(20000) === 0);

  // ─── Connexions ───────────────────────────────────────────────
  Rooms.joinPlayer(room, alice.id, 's-alice');
  Rooms.joinPlayer(room, bob.id,   's-bob');
  Rooms.joinPlayer(room, cleo.id,  's-cleo');
  ok('trois connectés', Rooms.connectedPlayers(room).length === 3);

  // ─── Manche 1 ─────────────────────────────────────────────────
  const track = room.tracks.find(t => t.proposed_by_id === alice.id);
  const started = await Rooms.startRound(room, track.id);
  ok('manche démarrée', started.ok, `offset ${started.startOffsetMs} ms`);
  ok('offset persisté en base',
     (await S.roundDetail(started.round.id)).start_offset_ms === started.startOffsetMs);

  ok('vote pour soi refusé',       !Rooms.recordVote(room, bob.id, bob.id).ok);
  ok('vote pour non-éligible refusé', !Rooms.recordVote(room, bob.id, cleo.id).ok);

  Rooms.recordVote(room, bob.id, alice.id);
  let tally = Rooms.voteTally(room);
  ok('décompte partiel', !tally.complete, `${tally.voted}/${tally.connected}, manque ${tally.pending.join(',')}`);

  Rooms.recordVote(room, cleo.id, alice.id);
  Rooms.recordVote(room, alice.id, bob.id);
  ok('auto-reveal armé', Rooms.voteTally(room).complete);

  Rooms.revealAnswer(room, { title: track.title, artist: track.artist, player: 'Alice' });
  const rev = await Rooms.persistReveal(room);
  ok('votes persistés', rev.votes === 3 && !!rev.round.revealed_at);

  await Rooms.persistScores(room, [
    { participantId: bob.id,   points: 1, reason: 'finder' },
    { participantId: cleo.id,  points: 1, reason: 'finder' },
    { participantId: alice.id, points: 1, reason: 'bluffer' },
  ]);
  const st1 = await S.standings(room.sessionId);
  ok('classement depuis le journal',
     st1.every(s => s.score === 1), st1.map(s => `${s.display_name}=${s.score}`).join(' '));

  // ─── Idempotence de la validation ─────────────────────────────
  await S.commitScores(room.round.roundId, [
    { participantId: bob.id, points: 2, reason: 'finder' },
  ]);
  const st2 = await S.standings(room.sessionId);
  ok('revalidation remplace, ne cumule pas',
     st2.find(s => s.participant_id === bob.id).score === 2);

  // ─── Déconnexion pendant une manche ───────────────────────────
  Rooms.resetRound(room);
  const t2 = Rooms.pickNextTrack(room);
  ok('morceau déjà joué exclu du tirage', t2.id !== track.id);
  await Rooms.startRound(room, t2.id);

  Rooms.markDisconnected(room, 's-cleo');
  Rooms.recordVote(room, alice.id, bob.id);
  Rooms.recordVote(room, bob.id, alice.id);
  tally = Rooms.voteTally(room);
  ok('déconnecté hors dénominateur', tally.complete, `${tally.voted}/${tally.connected} connectés`);

  // ─── Plancher de quorum ───────────────────────────────────────
  Rooms.markDisconnected(room, 's-bob');
  Rooms.resetRound(room);
  await Rooms.startRound(room, Rooms.pickNextTrack(room).id);
  Rooms.recordVote(room, alice.id, bob.id);
  ok('pas d\'auto-reveal sous le quorum', !Rooms.voteTally(room).complete,
     `${Rooms.connectedPlayers(room).length} connecté(s) < ${Rooms.QUORUM_FLOOR}`);

  // ─── Entracte et bouton « prêt » ──────────────────────────────
  Rooms.joinPlayer(room, bob.id, 's-bob-2');
  Rooms.joinPlayer(room, cleo.id, 's-cleo-2');
  Rooms.clearReady(room);
  Rooms.setReady(room, alice.id);
  Rooms.setReady(room, bob.id);
  ok('entracte incomplet', !Rooms.readyTally(room).complete,
     'manque ' + Rooms.readyTally(room).pending.join(','));
  Rooms.setReady(room, cleo.id);
  ok('tous prêts', Rooms.readyTally(room).complete);

  Rooms.setPaused(room, true);
  ok('pause neutralise le décompte', !Rooms.readyTally(room).complete);
  Rooms.setPaused(room, false);

  // ─── Retardataire intégré à chaud ─────────────────────────────
  const dan = (await PA.create(party.id, 'Dan')).participant;
  const late = Rooms.joinPlayer(room, dan.id, 's-dan', dan);
  ok('retardataire accepté', late.ok);
  ok('retardataire hors grille de vote',
     !Rooms.voteOptions(room, alice.id).some(o => o.id === dan.id));

  // ─── Reprise après plantage du serveur ────────────────────────
  const pending = await S.pendingForHost(party.id);
  ok('action en attente identifiée', pending.pendingAction === 'reveal',
     `manche ${pending.round.order_no} non révélée`);

  rooms_forceForget(room.code);
  const again = await Rooms.openRoom(fresh, 'socket-host-2');
  ok('salon rechargé', !!again.room);
  ok('scores retrouvés',
     Rooms.publicPlayers(again.room).find(p => p.id === bob.id).score === 2);
  ok('morceaux déjà joués retrouvés', again.room.playedTrackIds.size === 3);
  ok('session réutilisée, pas dupliquée', again.room.sessionId === room.sessionId);

  // ─── Fermeture ────────────────────────────────────────────────
  await Rooms.closeRoom(party.code);
  ok('soirée terminée', (await P.findById(party.id)).state === 'terminee');
  ok('session close', (await S.findOpen(party.id)) === null);

  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
  await db.close();
  process.exit(failures ? 1 : 0);

})().catch(e => { console.error('CRASH', e); process.exit(1); });

/** Simule un redémarrage du serveur : la RAM est perdue, pas la base. */
function rooms_forceForget(code) {
  const mod = require(R + '/rooms');
  // Le TTL est le seul chemin public de suppression ; on l'atteint en
  // vieillissant artificiellement le salon.
  const room = mod.getRoom(code);
  room.lastActivity = Date.now() - mod.ROOM_TTL_MS - 1;
  mod.sweep();
}
