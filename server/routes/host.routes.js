/**
 * ════════════════════════════════════════════════════════════════
 *  ROUTES — Console hôte (PC)
 * ════════════════════════════════════════════════════════════════
 *
 *  Toutes sous /api/host. UNE SEULE authentification :
 *    requirePartyOwner  propriété de CETTE soirée (X-Host-Token)
 *
 *  Créer une soirée est ouvert : c'est le jeton rendu à la création qui
 *  la protège ensuite. Un mot de passe global partagé entre tous les
 *  animateurs ne protégeait rien et compliquait le partage.
 *
 *  Couvre les écrans H1 à H6 de ECRANS.md : création, participants,
 *  complétion, arbitrage, manifeste, vérification.
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const os      = require('os');
// Plus de porte globale : chaque route est protégée par le hostToken
// de LA soirée concernée (requirePartyOwner). Créer une soirée est
// ouvert — c'est le jeton rendu à la création qui la protège ensuite.
const { requirePartyOwner, requirePartyState } = require('../lib/auth');
const { limit } = require('../lib/rate-limit');

const partyRepo       = require('../repos/party.repo');
const participantRepo = require('../repos/participant.repo');
const trackRepo       = require('../repos/track.repo');
const sessionRepo     = require('../repos/session.repo');
const notify          = require('../lib/notify');
const Rooms           = require('../rooms');

const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ═══ Réseau ══════════════════════════════════════════════════════

/**
 * Adresses par lesquelles ce serveur est joignable depuis un autre
 * appareil du réseau.
 *
 * Le lien partagé et le QR sont construits à partir de location.origin.
 * Si l'hôte ouvre sa console sur http://localhost, il diffuse une URL
 * que les téléphones ne peuvent pas atteindre — « localhost », sur un
 * téléphone, désigne le téléphone. La console propose donc de basculer
 * sur une adresse réelle.
 */
router.get('/network', (req, res) => {
  // NE RÉPOND QU'EN USAGE LOCAL.
  //
  // Cette route existe pour un seul cas : l'hôte a ouvert sa console
  // sur http://localhost et diffuse un lien que les téléphones ne
  // peuvent pas atteindre. Derrière un proxy — donc en ligne — elle
  // n'a aucune utilité, et divulguer les adresses internes du serveur
  // à qui les demande n'a pas de raison d'être.
  const behindProxy = !!(req.get('x-forwarded-for') || req.get('x-forwarded-host'));
  if (behindProxy) {
    return res.json({ addresses: [], hosted: true });
  }

  const addresses = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      addresses.push({ interface: name, address: net.address });
    }
  }
  res.json({
    addresses,
    port: req.app.get('port') || process.env.PORT || 3000,
    hosted: false,
  });
});

// ═══ H1 — Création ═══════════════════════════════════════════════

/**
 * Crée une soirée. Le hostToken n'est renvoyé QU'ICI : il n'est stocké
 * que haché. Le client doit le persister immédiatement, sinon la
 * soirée devient inaccessible depuis ce navigateur.
 */
router.post('/parties',
  limit('create-party', 10, 60 * 60 * 1000,
        'Trop de soirées créées depuis cette adresse. Réessaie dans une heure.'),
  wrap(async (req, res) => {
  const { name, minTracks, maxTracks, settings } = req.body || {};
  const { party, hostToken } = await partyRepo.create({
    name,
    minTracks: clampInt(minTracks, 1, 20, 3),
    maxTracks: clampInt(maxTracks, 1, 20, 6),
    settings: settings || {},
  });
  res.status(201).json({ party, hostToken });
}));

// ═══ H0 — Console ════════════════════════════════════════════════

router.get('/parties/:code', requirePartyOwner, wrap(async (req, res) => {
  const [participants, progress, session] = await Promise.all([
    participantRepo.listByParty(req.party.id),
    partyRepo.progress(req.party.id),
    sessionRepo.pendingForHost(req.party.id),
  ]);
  res.json({ party: req.party, participants, progress, session });
}));

/** Options de partie, modifiables même en cours de soirée. */
router.patch('/parties/:code/settings', requirePartyOwner, wrap(async (req, res) => {
  const party = await partyRepo.updateSettings(req.party.id, req.body || {});
  // Un salon déjà ouvert garde une copie des réglages : il faut la
  // rafraîchir, sinon le changement ne prend effet qu'à la prochaine
  // ouverture.
  Rooms.applySettings(party.code, party);
  res.json({ party });
}));

router.patch('/parties/:code/state', requirePartyOwner, wrap(async (req, res) => {
  const party = await partyRepo.setState(req.party.id, req.body.state);
  notify.partyChanged(party.code, party.state);
  res.json({ party });
}));

// ═══ H2 — Participants ═══════════════════════════════════════════

router.post('/parties/:code/participants', requirePartyOwner, wrap(async (req, res) => {
  const result = await participantRepo.create(req.party.id, req.body.displayName, {
    isManaged: req.body.isManaged === true,
  });
  // 409 avec des suggestions plutôt qu'un refus sec : l'hôte corrige
  // en un clic au lieu de deviner quoi mettre.
  if (!result.ok) return res.status(result.conflict ? 409 : 400).json(result);
  res.status(201).json(result);
}));

router.patch('/parties/:code/participants/:id', requirePartyOwner, wrap(async (req, res) => {
  const result = await participantRepo.rename(req.params.id, req.body.displayName);
  if (!result.ok) return res.status(result.conflict ? 409 : 400).json(result);
  res.json(result);
}));

router.delete('/parties/:code/participants/:id', requirePartyOwner, wrap(async (req, res) => {
  const removed = await participantRepo.remove(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Participant introuvable.' });
  res.json({ removed });
}));

/** Libère une revendication : quelqu'un a cliqué sur le mauvais nom. */
router.post('/parties/:code/participants/:id/release', requirePartyOwner, wrap(async (req, res) => {
  const p = await participantRepo.release(req.params.id);
  if (!p) return res.status(404).json({ error: 'Participant introuvable.' });
  res.json({ participant: p });
}));

// ═══ H4 — Arbitrage & verrouillage ═══════════════════════════════

/**
 * Doublons à trancher. Le jeu ne peut pas avoir deux bonnes réponses
 * pour une même manche : sans arbitrage, la partie casse en silence.
 */
router.get('/parties/:code/duplicates', requirePartyOwner, wrap(async (req, res) => {
  res.json({ duplicates: await trackRepo.findDuplicates(req.party.id) });
}));

router.post('/parties/:code/tracks/:trackId/exclude', requirePartyOwner, wrap(async (req, res) => {
  const track = await trackRepo.exclude(req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Morceau introuvable.' });
  res.json({ track });
}));

router.post('/parties/:code/tracks/:trackId/restore', requirePartyOwner, wrap(async (req, res) => {
  const track = await trackRepo.restore(req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Morceau introuvable ou non exclu.' });
  res.json({ track });
}));

/**
 * Verrouille la collecte et numérote.
 *
 * belowMinimum est renvoyé mais NE BLOQUE PAS : empêcher le
 * verrouillage pour trois morceaux manquants empêcherait la soirée
 * d'avoir lieu. L'hôte est averti, il décide.
 */
router.post('/parties/:code/lock',
  requirePartyOwner, requirePartyState('collecte'),
  wrap(async (req, res) => {
    const result = await partyRepo.lock(req.party.id);
    // Les participants basculent immédiatement de « panier » à
    // « attente » sans avoir à recharger.
    notify.partyChanged(req.party.code, result.party.state);
    res.json(result);
  })
);

router.post('/parties/:code/unlock',
  requirePartyOwner, requirePartyState('verrouillee', 'prete', 'terminee'),
  wrap(async (req, res) => {
    const party = await partyRepo.unlock(req.party.id);
    notify.partyChanged(party.code, party.state);
    res.json({ party });
  })
);

// ═══ H5 — Manifeste ══════════════════════════════════════════════

/**
 * Liste numérotée à donner à l'outil de téléchargement.
 *
 * Le nom de fichier attendu est calculé par la vue SQL, pas ici : le
 * manifeste et la vérification doivent partager la même définition,
 * sinon ils divergent au premier changement de format.
 *
 * ?format=csv pour un export directement exploitable.
 */
router.get('/parties/:code/manifest', requirePartyOwner, wrap(async (req, res) => {
  const rows = await trackRepo.manifest(req.party.id);

  if (req.query.format === 'csv') {
    // L'URL est en tête après les métadonnées : c'est la colonne qu'on
    // copie-colle pour retrouver le bon morceau, celle qu'on veut voir
    // sans faire défiler.
    const header = 'no,artiste,titre,album,duree,url,source,source_id,propose_par,fichier_suggere';
    const csv = [header, ...rows.map(r => [
      r.acquisition_no, r.artist, r.title, r.album || '',
      fmtDuration(r.duration_ms), r.url || '',
      r.source, r.source_id, r.proposed_by, r.expected_file_name,
    ].map(csvCell).join(','))].join('\n');

    res.type('text/csv; charset=utf-8')
       .attachment(`playlist-${req.party.code}.csv`)
       .send('\uFEFF' + csv);   // BOM : Excel ouvre l'UTF-8 correctement
    return;
  }

  // Liste d'URL brutes, une par ligne : le format qu'attendent les
  // outils de téléchargement en lot. Rien d'autre sur la ligne, sinon
  // ils refusent l'entrée.
  if (req.query.format === 'urls') {
    const urls = rows.map(r => r.url).filter(Boolean);
    res.type('text/plain; charset=utf-8')
       .attachment(`urls-${req.party.code}.txt`)
       .send(urls.join('\n') + (urls.length ? '\n' : ''));
    return;
  }

  res.json({
    manifest: rows,
    count: rows.length,
    withUrl: rows.filter(r => r.url).length,
  });
}));

// ═══ H6 — Vérification des fichiers ══════════════════════════════

/**
 * Confronte le dossier de l'hôte au manifeste.
 *
 * Le client envoie, pour chaque fichier trouvé : son préfixe numérique
 * et sa durée mesurée par decodeAudioData. Aucun audio ne transite —
 * seulement des métadonnées.
 */
router.post('/parties/:code/reconcile',
  requirePartyOwner, requirePartyState('verrouillee', 'prete'),
  wrap(async (req, res) => {
    const files = Array.isArray(req.body.files) ? req.body.files : [];
    const report = await trackRepo.reconcile(req.party.id, files);

    // Bascule automatique en 'prete' quand tout est vérifié : une étape
    // manuelle de moins, et l'état reflète la réalité du dossier.
    if (report.ready && req.party.state === 'verrouillee') {
      report.party = await partyRepo.setState(req.party.id, 'prete');
      notify.partyChanged(req.party.code, 'prete');
    }
    res.json(report);
  })
);

router.get('/parties/:code/tracks', requirePartyOwner, wrap(async (req, res) => {
  res.json({
    tracks:   await trackRepo.playable(req.party.id),
    excluded: await trackRepo.excludedList(req.party.id),
  });
}));

// ═══ Sauvegarde ══════════════════════════════════════════════════

/**
 * Exporte une soirée en JSON.
 *
 * AUCUN SECRET N'EST EXPORTÉ : ni hostToken ni jeton de participant,
 * même hachés. Une sauvegarde se transmet, se stocke, s'oublie dans un
 * dossier de téléchargements — elle ne doit jamais permettre d'usurper
 * une identité.
 *
 * Conséquence assumée : réimporter crée une NOUVELLE soirée, avec un
 * nouveau code et des identités à revendiquer à nouveau. On sauvegarde
 * un contenu, pas une session.
 */
router.get('/parties/:code/export', requirePartyOwner, wrap(async (req, res) => {
  const [participants, tracks, sessions] = await Promise.all([
    participantRepo.listByParty(req.party.id),
    trackRepo.exportList(req.party.id),
    sessionRepo.listByParty(req.party.id),
  ]);

  const backup = {
    format: 'blindtest-party',
    version: 1,
    exportedAt: new Date().toISOString(),
    party: {
      name: req.party.name,
      state: req.party.state,
      minTracks: req.party.min_tracks_per_person,
      maxTracks: req.party.max_tracks_per_person,
      settings: {
        autoReveal: req.party.auto_reveal_on_all_votes,
        autoAdvance: req.party.auto_advance_on_all_ready,
        blufferRule: req.party.rule_bluffer_enabled,
        trapperRule: req.party.rule_trapper_enabled,
        hideIndices: req.party.hide_indices_default,
        selfRegistration: req.party.allow_self_registration,
      },
    },
    participants: participants.map(p => ({ displayName: p.display_name, color: p.color })),
    tracks: tracks.map(t => ({
      proposedBy: t.proposed_by,
      source: t.source, sourceId: t.source_id,
      title: t.title, artist: t.artist, album: t.album,
      durationMs: t.duration_ms, artworkUrl: t.artwork_url, url: t.url,
      fileName: t.file_name,
    })),
    sessionCount: sessions.length,
  };

  res.type('application/json; charset=utf-8')
     .attachment(`soiree-${req.party.code}.json`)
     .send(JSON.stringify(backup, null, 2));
}));

/**
 * Réimporte une sauvegarde comme nouvelle soirée.
 *
 * Utile pour rejouer la même playlist avec un autre groupe, ou pour
 * récupérer une soirée après un incident de base.
 */
router.post('/import',
  limit('import', 5, 60 * 60 * 1000,
        'Trop d\'imports depuis cette adresse. Réessaie dans une heure.'),
  wrap(async (req, res) => {
  const b = req.body || {};
  if (b.format !== 'blindtest-party') {
    return res.status(400).json({ error: 'Ce fichier n\'est pas une sauvegarde de soirée.' });
  }
  if (!Array.isArray(b.participants) || !Array.isArray(b.tracks)) {
    return res.status(400).json({ error: 'Sauvegarde incomplète.' });
  }

  const { party, hostToken } = await partyRepo.create({
    name: (b.party && b.party.name ? b.party.name + ' (copie)' : 'Soirée importée'),
    minTracks: clampInt(b.party && b.party.minTracks, 1, 20, 3),
    maxTracks: clampInt(b.party && b.party.maxTracks, 1, 20, 6),
    settings: (b.party && b.party.settings) || {},
  });

  // Les participants sont recréés SANS jeton : chacun revendiquera son
  // nom, comme pour une soirée neuve.
  const byName = new Map();
  for (const p of b.participants.slice(0, 50)) {
    const r = await participantRepo.create(party.id, p.displayName);
    if (r.ok) byName.set(p.displayName, r.participant.id);
  }

  let imported = 0, orphans = 0;
  for (const t of b.tracks.slice(0, 500)) {
    const pid = byName.get(t.proposedBy);
    if (!pid) { orphans++; continue; }
    const r = await trackRepo.add(pid, {
      source: t.source, sourceId: String(t.sourceId),
      title: t.title, artist: t.artist, album: t.album,
      durationMs: t.durationMs, artworkUrl: t.artworkUrl, url: t.url,
    });
    if (r.ok) imported++;
  }

  res.status(201).json({
    party, hostToken,
    imported, orphans,
    participants: byName.size,
  });
}));

// ═══ Résultats ═══════════════════════════════════════════════════

router.get('/parties/:code/sessions', requirePartyOwner, wrap(async (req, res) => {
  const sessions = await sessionRepo.listByParty(req.party.id);
  const current  = sessions.find(s => !s.closed_at) || sessions[0];
  res.json({
    sessions,
    standings: current ? await sessionRepo.standings(current.id) : [],
  });
}));

// ─── Utilitaires ────────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Durée lisible dans un tableur : « 3:42 » plutôt que 222000. */
function fmtDuration(ms) {
  if (!ms) return '';
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = router;
