/**
 * ════════════════════════════════════════════════════════════════
 *  ROUTES — Recherche de morceaux
 * ════════════════════════════════════════════════════════════════
 *
 *  GET /api/search?q=…&sources=itunes
 *
 *  Authentifiée par X-Participant-Token : seul quelqu'un qui compose
 *  un panier a besoin de chercher. Sans cette garde, la route serait
 *  un proxy ouvert vers les API tierces, et ferait porter à ce serveur
 *  les quotas de n'importe qui.
 *
 *  Les fournisseurs sont interrogés EN PARALLÈLE, et l'échec de l'un
 *  n'annule pas les autres : mieux vaut des résultats partiels qu'un
 *  écran vide parce qu'une source tierce est en panne.
 * ════════════════════════════════════════════════════════════════
 */

const express = require('express');
const { requireParticipant, requirePartyState } = require('../lib/auth');
const { limit } = require('../lib/rate-limit');
const itunes      = require('../lib/search/itunes');
const deezer      = require('../lib/search/deezer');
const musicbrainz = require('../lib/search/musicbrainz');

const router = express.Router();

/**
 * Ajouter une source = ajouter une entrée ici. Rien d'autre à changer.
 *
 * L'ordre compte : c'est celui de l'interrogation, et donc celui qui
 * l'emporte à la déduplication quand deux sources décrivent le même
 * morceau. iTunes en tête pour ses métadonnées propres et ses pochettes
 * haute définition.
 *
 * DEFAULT_SOURCES exclut MusicBrainz : sa limite d'une requête par
 * seconde ralentirait chaque recherche pour un gain marginal. Il reste
 * disponible à la demande, et c'est la source de repli si les autres
 * deviennent indisponibles.
 */
const PROVIDERS = new Map([
  [itunes.name, itunes],
  [deezer.name, deezer],
  [musicbrainz.name, musicbrainz],
]);

const DEFAULT_SOURCES = ['itunes', 'deezer'];

// Cache mémoire : pendant une session de collecte, plusieurs personnes
// cherchent les mêmes artistes. Économise les appels tiers et rend les
// requêtes répétées instantanées.
const CACHE_TTL_MS  = 10 * 60 * 1000;
const CACHE_MAX     = 500;
const cache = new Map();   // Map<clé, {at, tracks}>

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.tracks;
}

function cacheSet(key, tracks) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), tracks });
}

router.get('/search',
  limit('search', 120, 5 * 60 * 1000, 'Trop de recherches. Attends un instant.'),
  requireParticipant,
  requirePartyState('collecte'),
  async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ tracks: [], sources: [], errors: [] });
    }

    const wanted = String(req.query.sources || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const providers = wanted.length
      ? wanted.map(n => PROVIDERS.get(n)).filter(Boolean)
      : DEFAULT_SOURCES.map(n => PROVIDERS.get(n)).filter(Boolean);

    const key = `${providers.map(p => p.name).join('+')}::${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return res.json({ tracks: cached, cached: true, errors: [] });

    const settled = await Promise.allSettled(
      providers.map(p => p.search(q))
    );

    const tracks = [];
    const errors = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') tracks.push(...r.value);
      else errors.push({ source: providers[i].name, message: r.reason.message });
    });

    const deduped = dedupe(tracks);
    if (deduped.length) cacheSet(key, deduped);

    res.json({
      tracks: deduped,
      sources: providers.map(p => p.name),
      available: [...PROVIDERS.values()].map(p => ({ name: p.name, label: p.label })),
      errors,
    });
  }
);

/**
 * Résolution d'une URL collée.
 *
 * Quand la recherche ne donne rien — morceau obscur, titre mal
 * orthographié, version rare — le participant colle le lien de la
 * plateforme où il l'a trouvé. On n'interroge AUCUNE API tierce ici :
 * on extrait ce que l'URL contient déjà (plateforme, identifiant) et
 * on laisse le participant compléter titre et artiste.
 *
 * C'est volontairement modeste. Résoudre l'URL côté serveur
 * demanderait une clé par plateforme et rouvrirait les questions de
 * quota et de conditions d'utilisation, pour un cas qui reste marginal.
 * Ce qui compte, c'est que le morceau finisse dans la playlist avec un
 * lien exploitable au téléchargement.
 */
const URL_PATTERNS = [
  { source: 'spotify', re: /open\.spotify\.com\/(?:intl-\w+\/)?track\/([A-Za-z0-9]+)/, label: 'Spotify' },
  { source: 'spotify', re: /^spotify:track:([A-Za-z0-9]+)$/,                                label: 'Spotify' },
  { source: 'youtube', re: /(?:youtube\.com\/watch\?v=|youtu\.be\/|music\.youtube\.com\/watch\?v=)([\w-]{11})/, label: 'YouTube' },
  { source: 'deezer',  re: /deezer\.com\/(?:\w+\/)?track\/(\d+)/,                        label: 'Deezer' },
  { source: 'itunes',  re: /music\.apple\.com\/[^?]*[?&]i=(\d+)/,                          label: 'Apple Music' },
];

router.post('/search/resolve-url',
  requireParticipant,
  requirePartyState('collecte'),
  (req, res) => {
    const raw = String((req.body && req.body.url) || '').trim();
    if (!raw) return res.status(400).json({ error: 'Lien vide.' });
    if (raw.length > 500) return res.status(400).json({ error: 'Lien trop long.' });

    for (const { source, re, label } of URL_PATTERNS) {
      const m = raw.match(re);
      if (!m) continue;
      return res.json({
        track: {
          source,
          sourceId: m[1],
          url: raw.startsWith('http') ? raw : null,
          title: '',
          artist: '',
        },
        platform: label,
      });
    }

    // Une playlist n'est pas un morceau : le dire explicitement évite
    // que le participant réessaie trois fois le même lien.
    if (/playlist|album/i.test(raw)) {
      return res.status(422).json({
        error: 'Ce lien pointe vers une playlist ou un album. Colle le lien d\'un morceau précis.',
      });
    }
    res.status(422).json({
      error: 'Lien non reconnu. Spotify, YouTube, Deezer et Apple Music sont acceptés.',
    });
  }
);

/**
 * Déduplication inter-sources.
 *
 * Le même titre remonte de plusieurs API sous des libellés légèrement
 * différents. Sans regroupement, le panier devient illisible dès qu'on
 * branche une seconde source. La clé combine titre, artiste et durée
 * arrondie à 5 s — assez tolérante pour rapprocher deux masterings,
 * assez stricte pour distinguer un original d'un live.
 */
function dedupe(tracks) {
  const seen = new Map();
  for (const t of tracks) {
    const key = [
      norm(t.title), norm(t.artist),
      t.durationMs ? Math.round(t.durationMs / 5000) : 'x',
    ].join('|');

    const kept = seen.get(key);
    if (!kept) { seen.set(key, t); continue; }

    // À doublon, on garde la fiche la plus complète : une pochette et
    // une durée valent mieux qu'un ordre d'arrivée. C'est ce qui évite
    // qu'une source pauvre masque une source riche.
    const score = (x) => (x.artworkUrl ? 2 : 0) + (x.durationMs ? 1 : 0) + (x.album ? 1 : 0);
    if (score(t) > score(kept)) seen.set(key, t);
  }
  return [...seen.values()];
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Les mentions de version parasitent la comparaison sans porter
    // d'information distinctive utile ici.
    .replace(/\((remaster|remastered|radio edit|single version)[^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

module.exports = router;
module.exports.PROVIDERS = PROVIDERS;
