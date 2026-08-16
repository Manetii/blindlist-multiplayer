/**
 * ════════════════════════════════════════════════════════════════
 *  RECHERCHE — fournisseur iTunes
 * ════════════════════════════════════════════════════════════════
 *
 *  Choisi comme source par défaut pour trois raisons :
 *    - aucune clé, aucun compte, aucun quota déclaré
 *    - métadonnées propres et pochettes en haute définition
 *    - pas de clause interdisant l'usage ludique, contrairement à
 *      Spotify dont la Developer Policy exclut explicitement les jeux
 *
 *  L'interface exposée est volontairement générique : search(query)
 *  renvoie des NormalizedTrack. Ajouter Spotify, Deezer ou MusicBrainz
 *  revient à écrire un module de la même forme et à l'enregistrer dans
 *  search.routes.js — rien d'autre ne bouge.
 * ════════════════════════════════════════════════════════════════
 */

const ENDPOINT = 'https://itunes.apple.com/search';
const TIMEOUT_MS = 6000;

/**
 * @typedef {Object} NormalizedTrack
 * @property {string} source      'itunes' | 'spotify' | …
 * @property {string} sourceId    identifiant stable chez la source
 * @property {string} title
 * @property {string} artist
 * @property {string|null} album
 * @property {number|null} durationMs
 * @property {string|null} artworkUrl
 * @property {string|null} url          page publique du morceau
 */

async function search(query, { limit = 15, country = 'FR' } = {}) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('term', query);
  url.searchParams.set('media', 'music');
  url.searchParams.set('entity', 'song');
  url.searchParams.set('limit', String(Math.min(limit, 25)));
  url.searchParams.set('country', country);

  // Sans délai maximal, une source lente bloquerait la recherche entière
  // côté participant — qui abandonnerait plutôt que d'attendre.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`iTunes a répondu ${res.status}`);
    const data = await res.json();
    return (data.results || []).map(normalize).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function normalize(r) {
  if (!r.trackName || !r.artistName) return null;
  return {
    source: 'itunes',
    sourceId: String(r.trackId),
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName || null,
    durationMs: Number.isFinite(r.trackTimeMillis) ? r.trackTimeMillis : null,
    // artworkUrl100 est en 100×100 ; l'URL suit un motif qui accepte
    // n'importe quelle taille, et 300 reste net sur un écran dense.
    artworkUrl: r.artworkUrl100
      ? r.artworkUrl100.replace('100x100bb', '300x300bb')
      : null,
    // Sert à retrouver exactement cette version au téléchargement.
    url: r.trackViewUrl || null,
  };
}

module.exports = { name: 'itunes', label: 'iTunes', search };
