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
const youtube = require('../lib/youtube');

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
  const { name, minTracks, maxTracks, settings, sourceMode } = req.body || {};
  const { party, hostToken } = await partyRepo.create({
    name,
    minTracks: clampInt(minTracks, 1, 20, 3),
    maxTracks: clampInt(maxTracks, 1, 20, 6),
    // sourceMode arrive à plat dans le corps de la requête, comme
    // selfRegistration : c'est une décision de création, pas un réglage
    // caché dans un sous-objet.
    settings: { ...(settings || {}), sourceMode, selfRegistration: true },
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
  /*
   * Présence en direct.
   *
   * `claimed` dit qu'un nom a été pris un jour ; il ne dit pas qui est
   * là maintenant. La console en a besoin pour garder un voyant utile
   * pendant les étapes où l'avancement des paniers, lui, n'a plus rien
   * à raconter.
   */
  const room = Rooms.getRoom(req.party.code);
  const live = new Set(
    room ? Rooms.connectedPlayers(room).map(p => p.id) : []
  );

  res.json({
    party: req.party,
    participants: participants.map(p => ({ ...p, connected: live.has(p.id) })),
    progress,
    session,
    roomOpen: !!room,
  });
}));

/**
 * Options de partie, modifiables même en cours de soirée.
 *
 * Peut refuser : abaisser le quota maximum sous un panier déjà
 * constitué placerait des participants hors des règles sans qu'aucun
 * geste de leur part ne puisse corriger la situation.
 */
router.patch('/parties/:code/settings', requirePartyOwner, wrap(async (req, res) => {
  const result = await partyRepo.updateSettings(req.party.id, req.body || {});
  if (!result.ok) return res.status(409).json(result);

  const { party } = result;
  // Un salon déjà ouvert garde une copie des réglages : il faut la
  // rafraîchir, sinon le changement ne prend effet qu'à la prochaine
  // ouverture.
  Rooms.applySettings(party.code, party);
  // …et prévenir les clients CONNECTÉS. Sans ces deux lignes, le salon
  // applique bien la nouvelle règle mais le lecteur ouvert et les
  // téléphones continuent d'afficher l'ancienne jusqu'au prochain
  // rechargement : l'hôte coche une case et ne voit rien changer.
  const room = Rooms.getRoom(party.code);
  if (room) notify.settingsChanged(party.code, room.settings);

  /*
   * PAS de partyChanged ici — c'était une régression.
   *
   * Les téléphones traitent cet événement comme « l'état de la soirée a
   * bougé, redemande où tu dois être » : écran de chargement, puis
   * nouvelle résolution, puis re-entrée dans le jeu. Bouger le curseur
   * d'intro pendant une partie faisait donc clignoter tous les
   * téléphones de la salle.
   *
   * Un réglage n'est pas un changement d'état. settingsChanged suffit,
   * et ne s'adresse qu'au lecteur.
   */
  res.json({ party });
}));

/**
 * Plancher du quota maximum, pour que la console l'affiche SOUS le
 * champ plutôt que de le faire découvrir au moment du refus.
 */
router.get('/parties/:code/quota-floor', requirePartyOwner, wrap(async (req, res) => {
  res.json(await partyRepo.trackCeiling(req.party.id));
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
    // Groupées par source : on télécharge d'un service à la fois, et
    // alterner Deezer / iTunes / MusicBrainz ligne après ligne oblige à
    // changer d'outil à chaque morceau.
    const urls = rows
      .filter(r => r.url)
      .slice()
      .sort((a, b) => (a.source || '').localeCompare(b.source || '')
                   || a.acquisition_no - b.acquisition_no)
      .map(r => r.url);
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

// ═══ H6 bis — Vérification des liens (mode YouTube) ══════════════

/**
 * Confronte la playlist à YouTube, lien par lien.
 *
 * Remplace l'appariement de fichiers : même place dans le parcours,
 * même rôle — dire avant la soirée lesquels poseront problème. Une
 * vidéo retirée ou passée en privé entre la collecte et le jour J ne
 * se découvrirait sinon qu'en pleine manche.
 *
 * Concurrence bornée : trente requêtes simultanées vers oEmbed pour une
 * playlist ordinaire n'apporterait rien qu'un risque de limitation.
 */
router.post('/parties/:code/verify-links',
  requirePartyOwner, requirePartyState('verrouillee', 'prete'),
  wrap(async (req, res) => {
    if (req.party.source_mode !== 'youtube') {
      return res.status(400).json({ error: 'Cette soirée fonctionne avec des fichiers audio.' });
    }

    const tracks = await trackRepo.playable(req.party.id);
    const results = [];
    const CONCURRENCY = 4;

    for (let i = 0; i < tracks.length; i += CONCURRENCY) {
      const batch = tracks.slice(i, i + CONCURRENCY);
      const probes = await Promise.all(batch.map(async (t) => {
        const id = youtube.parseId(t.url || t.source_id);
        if (!id) {
          return { id: t.id, ok: false, reason: 'no_id',
                   error: 'Aucun lien YouTube utilisable.' };
        }
        const probe = await youtube.probe(id);
        return probe.ok
          ? { id: t.id, ok: true, unverified: probe.unverified === true,
              youtubeTitle: probe.title || null }
          : { id: t.id, ok: false, reason: probe.reason,
              error: youtube.reasonText(probe.reason) };
      }));

      probes.forEach((p, k) => results.push({
        ...p,
        acquisitionNo: batch[k].acquisition_no,
        title: batch[k].title,
        artist: batch[k].artist,
        proposedBy: batch[k].proposed_by,
        url: batch[k].url,
      }));
    }

    const broken = results.filter(r => !r.ok);
    // « Prête » signifie : la soirée peut se jouer telle quelle. Un lien
    // cassé restant, ce n'est plus vrai — mais les morceaux valides
    // suffisent à jouer, donc on bascule quand même et on nomme ce qui
    // manque, comme le fait la vérification de dossier.
    const report = {
      total: results.length,
      ok: results.length - broken.length,
      broken,
      ready: broken.length === 0,
      results,
    };

    if (results.length && req.party.state === 'verrouillee') {
      report.party = await partyRepo.setState(req.party.id, 'prete');
      notify.partyChanged(req.party.code, 'prete');
    }
    res.json(report);
  })
);

/**
 * Ajout en lot par l'hôte, pendant la collecte.
 *
 * Remplace le téléchargement du dossier : une liste de liens collée ou
 * déposée en .txt / .json suffit à constituer une playlist. Les
 * morceaux sont attribués à un participant — celui que l'hôte désigne,
 * lui-même le plus souvent —, parce que le jeu a besoin de savoir qui
 * a proposé quoi : sans propriétaire, une manche n'a pas de réponse.
 *
 * Le quota du participant s'applique : contourner ici la règle que
 * l'écran joueur impose créerait un déséquilibre invisible.
 */
router.post('/parties/:code/import-links',
  requirePartyOwner, requirePartyState('collecte'),
  wrap(async (req, res) => {
    if (req.party.source_mode !== 'youtube') {
      return res.status(400).json({ error: 'Cette soirée fonctionne avec des fichiers audio.' });
    }
    const { participantId, items } = req.body || {};
    if (!participantId) return res.status(400).json({ error: 'Choisis à qui attribuer ces morceaux.' });
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Aucun lien à importer.' });
    }
    if (items.length > 100) return res.status(400).json({ error: 'Cent liens au maximum par import.' });

    const added = [], skipped = [];
    for (const raw of items) {
      const url = typeof raw === 'string' ? raw : (raw && raw.url);
      const ytId = youtube.parseId(url);
      if (!ytId) { skipped.push({ url, error: 'Lien non reconnu.' }); continue; }

      const probe = await youtube.probe(ytId);
      if (!probe.ok) { skipped.push({ url, error: youtube.reasonText(probe.reason) }); continue; }

      const title  = (raw && raw.title)  || probe.title  || 'Sans titre';
      const artist = (raw && raw.artist) || probe.author || 'Inconnu';

      const result = await trackRepo.add(participantId, {
        source: 'youtube', sourceId: ytId,
        title: String(title).slice(0, 300),
        artist: String(artist).slice(0, 300),
        album: null, durationMs: null, artworkUrl: null,
        url: youtube.watchUrl(ytId),
      });
      if (result.ok) added.push({ url, title, artist });
      else skipped.push({ url, error: result.error || 'Ajout refusé.' });
    }
    res.json({ added, skipped });
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
