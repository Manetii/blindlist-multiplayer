/**
 * ════════════════════════════════════════════════════════════════
 *  ROUTES — Admin
 * ════════════════════════════════════════════════════════════════
 *
 *  Écrans A1 et A2. Derrière ADMIN_PASSWORD — la seule porte globale
 *  du projet, parce que cette page voit et supprime TOUTES les soirées.
 *
 *  Utile pour déboguer bien avant d'être utile pour administrer : voir
 *  d'un coup d'œil quels salons tournent, combien de joueurs sont
 *  réellement connectés et quels minuteurs sont armés évite beaucoup
 *  de suppositions quand quelque chose se fige en soirée.
 *
 *  AUCUN SECRET N'EST EXPOSÉ ICI. Ni hostToken ni jeton de
 *  participant, même hachés — une console d'administration n'a aucune
 *  raison de permettre l'usurpation d'une identité.
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const { requireAdminApi } = require('../lib/auth');

const partyRepo       = require('../repos/party.repo');
const participantRepo = require('../repos/participant.repo');
const trackRepo       = require('../repos/track.repo');
const sessionRepo     = require('../repos/session.repo');
const Rooms           = require('../rooms');
const auth            = require('../lib/auth');
const Timers          = require('../lib/room-timers');
const db              = require('../db');

const router = express.Router();
router.use(requireAdminApi);

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ═══ A1 — Vue d'ensemble ═════════════════════════════════════════

router.get('/overview', wrap(async (req, res) => {
  const parties = await partyRepo.listAll({ limit: 200 });
  const live    = Rooms.stats();

  res.json({
    parties: parties.map(p => ({
      ...p,
      roomOpen: !!Rooms.getRoom(p.code),   // salon actuellement en RAM
    })),
    live: {
      ...live,
      timers: Timers.activeCount(),
    },
    security: {
      // Signalé à l'écran : sans mot de passe dédié, cette page est
      // accessible à tout animateur.
      adminPasswordSet: !!auth.ADMIN_PASSWORD,
    },
    server: {
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      dbOk: await db.ping().catch(() => false),
    },
  });
}));

// ═══ A2 — Détail d'une soirée ════════════════════════════════════

router.get('/parties/:code', wrap(async (req, res) => {
  const party = await partyRepo.findByCode(req.params.code);
  if (!party) return res.status(404).json({ error: 'Soirée introuvable.' });

  const [participants, progress, sessions, duplicates, roster] = await Promise.all([
    participantRepo.listByParty(party.id),
    partyRepo.progress(party.id),
    sessionRepo.listByParty(party.id),
    trackRepo.findDuplicates(party.id),
    participantRepo.roster(party.id),
  ]);

  const room = Rooms.getRoom(party.code);

  res.json({
    party,
    participants,
    progress,
    sessions,
    duplicates,
    roster,
    // L'état RAM à côté de l'état base : c'est leur divergence qui
    // explique la plupart des symptômes bizarres en pleine soirée.
    room: room ? {
      hostOnline:   !!room.hostSocketId,
      paused:       room.paused,
      players:      Rooms.publicPlayers(room),
      tracksTotal:  room.tracks.length,
      tracksPlayed: room.playedTrackIds.size,
      round: {
        active:   room.round.active,
        revealed: room.round.revealed,
        votes:    room.round.votes.size,
      },
      pendingCue: room.pendingCue || null,
      timers: {
        reveal:       Timers.remaining(party.code, 'reveal'),
        advance:      Timers.remaining(party.code, 'advance'),
        intermission: Timers.remaining(party.code, 'intermission'),
        regrade:      Timers.remaining(party.code, 'regrade'),
      },
    } : null,
  });
}));

// ═══ Actions ═════════════════════════════════════════════════════

/** Ferme de force un salon figé, sans toucher aux données de la soirée. */
router.post('/parties/:code/close-room', wrap(async (req, res) => {
  Timers.clearAll(req.params.code.toUpperCase());
  const closed = await Rooms.closeRoom(req.params.code);
  res.json({ closed });
}));

router.post('/parties/:code/archive', wrap(async (req, res) => {
  const party = await partyRepo.findByCode(req.params.code);
  if (!party) return res.status(404).json({ error: 'Soirée introuvable.' });
  await Rooms.closeRoom(party.code).catch(() => {});
  res.json({ party: await partyRepo.setState(party.id, 'archivee') });
}));

/**
 * SUPPRESSION DÉFINITIVE. Le ON DELETE CASCADE emporte participants,
 * morceaux, sessions, manches, votes et scores.
 *
 * Distincte de l'archivage, qui conserve tout en lecture seule. Cette
 * route existe pour repartir proprement pendant les tests ; en usage
 * normal, archiver suffit.
 */
router.delete('/parties/:code', wrap(async (req, res) => {
  const party = await partyRepo.findByCode(req.params.code);
  if (!party) return res.status(404).json({ error: 'Soirée introuvable.' });

  Timers.clearAll(party.code);
  await Rooms.closeRoom(party.code).catch(() => {});
  await db.query('DELETE FROM parties WHERE id = $1', [party.id]);
  console.log(`[admin] Soirée ${party.code} supprimée définitivement`);
  res.json({ deleted: party.code });
}));

/**
 * Remise à zéro complète. Ne sert qu'au développement : après un
 * changement de code, repartir d'une base vide évite de traîner des
 * soirées à moitié conformes au nouveau schéma.
 *
 * Exige une confirmation explicite dans le corps de la requête pour
 * qu'un appel accidentel ne détruise rien.
 */
router.post('/maintenance/reset', wrap(async (req, res) => {
  if (req.body.confirm !== 'SUPPRIMER TOUT') {
    return res.status(400).json({
      error: 'Confirmation manquante.',
      hint: 'Envoie { "confirm": "SUPPRIMER TOUT" }.',
    });
  }
  for (const p of await partyRepo.listAll({ limit: 500 })) {
    Timers.clearAll(p.code);
    await Rooms.closeRoom(p.code).catch(() => {});
  }
  const { rowCount } = await db.query('DELETE FROM parties');
  console.log(`[admin] RESET — ${rowCount} soirée(s) supprimée(s)`);
  res.json({ deleted: rowCount });
}));

router.post('/maintenance/sweep', wrap(async (req, res) => {
  res.json({
    roomsPurged: Rooms.sweep(),
    partiesArchived: (await partyRepo.archiveStale()).length,
  });
}));

module.exports = router;
