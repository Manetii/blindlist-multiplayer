/**
 * ════════════════════════════════════════════════════════════════
 *  ROUTES — Participant (téléphone)
 * ════════════════════════════════════════════════════════════════
 *
 *  Deux familles :
 *
 *    /api/join/*      PUBLIQUES. Consulter la liste des noms d'une
 *                     soirée et en revendiquer un. Le seul secret
 *                     requis est le code, partagé à toute la table.
 *
 *    /api/me/*        AUTHENTIFIÉES par X-Participant-Token. Panier,
 *                     statut, résolution d'écran.
 *
 *  Aucune route ici ne peut être atteinte par un participant d'une
 *  autre soirée : le jeton porte son party_id, et les dépôts filtrent
 *  dessus.
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const { requireParticipant, requirePartyState } = require('../lib/auth');
const { limit } = require('../lib/rate-limit');

const partyRepo       = require('../repos/party.repo');
const participantRepo = require('../repos/participant.repo');
const trackRepo       = require('../repos/track.repo');
const sessionRepo     = require('../repos/session.repo');
const Rooms           = require('../rooms');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ═══ V2/V3 — Rejoindre une soirée ════════════════════════════════

/**
 * Liste des noms d'une soirée, libres et déjà pris.
 *
 * On expose aussi les noms revendiqués, grisés côté client : voir que
 * son prénom est déjà pris et pouvoir demander à l'hôte de le libérer
 * vaut mieux que de le chercher dans une liste tronquée.
 */
// Un code fait 4 caractères sur un alphabet de 32 : sans plafond, on
// énumère l'espace entier en quelques minutes.
const joinLimit = limit('join', 60, 10 * 60 * 1000,
  'Trop de tentatives. Attends quelques minutes.');

router.get('/join/:code', joinLimit, wrap(async (req, res) => {
  const party = await partyRepo.findByCode(req.params.code);
  if (!party) return res.status(404).json({ error: 'Aucune soirée avec ce code.' });
  if (party.state === 'archivee') {
    return res.status(410).json({ error: 'Cette soirée est archivée.', state: party.state });
  }

  const participants = await participantRepo.listByParty(party.id);
  res.json({
    party: publicParty(party),
    participants: participants.map(p => ({
      id: p.id, displayName: p.display_name, color: p.color, claimed: p.claimed,
    })),
    roomOpen: !!Rooms.getRoom(party.code),
  });
}));

/**
 * Revendique une identité. Renvoie le jeton EN CLAIR — unique occasion.
 *
 * L'atomicité est assurée côté base (UPDATE ... WHERE claimed_at IS
 * NULL) : deux personnes qui tapent le même nom au même instant, la
 * seconde reçoit un 409.
 */
router.post('/join/:code/claim/:participantId', joinLimit, wrap(async (req, res) => {
  const party = await partyRepo.findByCode(req.params.code);
  if (!party) return res.status(404).json({ error: 'Aucune soirée avec ce code.' });

  // Vérifier l'appartenance : sans ça, un id valide d'une AUTRE soirée
  // serait revendicable depuis n'importe quel code.
  const participants = await participantRepo.listByParty(party.id);
  if (!participants.some(p => p.id === req.params.participantId)) {
    return res.status(404).json({ error: 'Ce nom ne fait pas partie de cette soirée.' });
  }

  const result = await participantRepo.claim(req.params.participantId);
  if (!result.ok) return res.status(409).json(result);

  res.status(201).json({
    token: result.token,
    participant: {
      id: result.participant.id,
      displayName: result.participant.display_name,
      color: result.participant.color,
    },
    party: publicParty(party),
    magicLink: `/p/${party.code}/${result.token}`,
  });
}));

/** Auto-inscription, quand la soirée l'autorise. */
router.post('/join/:code/register', joinLimit,
  wrap(async (req, res) => {
    const party = await partyRepo.findByCode(req.params.code);
    if (!party) return res.status(404).json({ error: 'Aucune soirée avec ce code.' });
    if (!party.allow_self_registration) {
      return res.status(403).json({
        error: 'Les inscriptions sont closes pour cette soirée.',
      });
    }
    const created = await participantRepo.create(party.id, req.body.displayName);
    if (!created.ok) return res.status(created.conflict ? 409 : 400).json(created);

    const claimed = await participantRepo.claim(created.participant.id);
    res.status(201).json({
      token: claimed.token,
      participant: {
        id: claimed.participant.id,
        displayName: claimed.participant.display_name,
        color: claimed.participant.color,
      },
      party: publicParty(party),
      magicLink: `/p/${party.code}/${claimed.token}`,
    });
  })
);

// ═══ P0 — Résolveur ══════════════════════════════════════════════

/**
 * Répond « où dois-je aller ? ». C'est le cœur du modèle à destination
 * unique : le participant garde UN lien en favori, et cette route le
 * renvoie au bon écran quel que soit l'état de la soirée trois
 * semaines plus tard.
 */
router.get('/me', requireParticipant, wrap(async (req, res) => {
  const room = Rooms.getRoom(req.party.code);
  const tracks = await trackRepo.listByParticipant(req.me.id);

  let screen = 'attente';
  if (room)                              screen = 'jeu';
  else if (req.party.state === 'collecte') screen = 'panier';
  else if (['terminee', 'archivee'].includes(req.party.state)) screen = 'resultats';

  res.json({
    screen,
    me: { id: req.me.id, displayName: req.me.display_name, color: req.me.color },
    party: publicParty(req.party),
    tracks,
    submitted: req.me.submitted === true || req.me.submitted_at != null,
    quota: {
      current: tracks.length,
      min: req.party.min_tracks_per_person,
      max: req.party.max_tracks_per_person,
      meetsMinimum: tracks.length >= req.party.min_tracks_per_person,
    },
    roomOpen: !!room,
  });
}));

// ═══ P1 — Panier ═════════════════════════════════════════════════

router.get('/me/tracks', requireParticipant, wrap(async (req, res) => {
  res.json({ tracks: await trackRepo.listByParticipant(req.me.id) });
}));

/**
 * Ajoute un morceau. Le quota et l'état de la soirée sont vérifiés
 * DANS la transaction du dépôt : deux onglets ouverts ne peuvent pas
 * dépasser le maximum tous les deux.
 */
router.post('/me/tracks',
  requireParticipant, requirePartyState('collecte'),
  wrap(async (req, res) => {
    const t = req.body || {};
    if (!t.source || !t.sourceId || !t.title || !t.artist) {
      return res.status(400).json({ error: 'Morceau incomplet.' });
    }
    const result = await trackRepo.add(req.me.id, {
      source: t.source, sourceId: String(t.sourceId),
      title: String(t.title).slice(0, 300),
      artist: String(t.artist).slice(0, 300),
      album: t.album ? String(t.album).slice(0, 300) : null,
      durationMs: Number.isFinite(t.durationMs) ? t.durationMs : null,
      artworkUrl: t.artworkUrl || null,
      // Permet de retrouver exactement ce morceau au téléchargement.
      url: typeof t.url === 'string' ? t.url.slice(0, 500) : null,
    });
    if (!result.ok) return res.status(result.quotaReached ? 409 : 400).json(result);
    res.status(201).json(result);
  })
);

router.delete('/me/tracks/:trackId',
  requireParticipant, requirePartyState('collecte'),
  wrap(async (req, res) => {
    const result = await trackRepo.remove(req.me.id, req.params.trackId);
    if (!result.ok) return res.status(404).json(result);
    res.json({ ok: true, tracks: await trackRepo.listByParticipant(req.me.id) });
  })
);

/**
 * Valider sa sélection. Réversible tant que la collecte est ouverte —
 * c'est un engagement, pas un verrou.
 */
router.post('/me/submit',
  requireParticipant, requirePartyState('collecte'),
  wrap(async (req, res) => {
    const result = await participantRepo.submit(req.me.id);
    if (!result.ok) return res.status(result.belowMinimum ? 409 : 400).json(result);
    res.json(result);
  })
);

router.delete('/me/submit',
  requireParticipant, requirePartyState('collecte'),
  wrap(async (req, res) => {
    const result = await participantRepo.unsubmit(req.me.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  })
);

// ═══ P7 — Résultats ══════════════════════════════════════════════

router.get('/me/results', requireParticipant, wrap(async (req, res) => {
  const sessions = await sessionRepo.listByParty(req.party.id);
  const last = sessions[0];
  res.json({
    party: publicParty(req.party),
    standings: last ? await sessionRepo.standings(last.id) : [],
    sessions,
  });
}));

// ─── Utilitaires ────────────────────────────────────────────────

/** Vue publique d'une soirée : jamais de jeton, jamais de réglage interne. */
function publicParty(p) {
  return {
    code: p.code,
    name: p.name,
    state: p.state,
    minTracks: p.min_tracks_per_person,
    maxTracks: p.max_tracks_per_person,
    selfRegistration: p.allow_self_registration,
  };
}

module.exports = router;
