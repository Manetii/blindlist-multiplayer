/**
 * ════════════════════════════════════════════════════════════════
 *  RECHERCHE — fournisseur MusicBrainz
 * ════════════════════════════════════════════════════════════════
 *
 *  Base ouverte, données de base en CC0, aucune clé ni quota, et
 *  surtout AUCUNE CLAUSE RESTREIGNANT L'USAGE LUDIQUE — contrairement
 *  à la plupart des plateformes commerciales. C'est la source la plus
 *  sûre à long terme du projet.
 *
 *  Deux contreparties : le catalogue est moins riche sur les sorties
 *  très récentes, et le service impose UNE REQUÊTE PAR SECONDE avec un
 *  User-Agent identifiant. Le débit est régulé ici même ; le cache de
 *  search.routes.js absorbe le reste.
 *
 *  Les pochettes viennent de Cover Art Archive, même écosystème.
 * ════════════════════════════════════════════════════════════════
 */

const ENDPOINT = 'https://musicbrainz.org/ws/2/recording';
const TIMEOUT_MS = 8000;
const MIN_INTERVAL_MS = 1100;   // la limite est d'une requête/seconde

const UA = process.env.MUSICBRAINZ_UA
  || 'BlindTestParty/2.0 ( https://github.com/Manetii/blindlist-multiplayer )';

let lastCall = 0;

/** Espace les appels pour respecter la limite de débit. */
async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

async function search(query, { limit = 15 } = {}) {
  await throttle();

  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', String(Math.min(limit, 25)));
  url.searchParams.set('fmt', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // L'en-tête est OBLIGATOIRE : sans lui, MusicBrainz renvoie 403.
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`MusicBrainz a répondu ${res.status}`);
    const data = await res.json();
    return (data.recordings || []).map(normalize).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function normalize(r) {
  const artist = (r['artist-credit'] || []).map(a => a.name).join(', ');
  if (!r.title || !artist) return null;

  const release = (r.releases || [])[0];
  return {
    source: 'musicbrainz',
    sourceId: r.id,
    title: r.title,
    artist,
    album: release ? release.title : null,
    durationMs: Number.isFinite(r.length) ? r.length : null,
    // La pochette est servie par Cover Art Archive à partir de l'id de
    // publication. L'URL peut renvoyer 404 si aucune image n'existe :
    // les clients doivent gérer l'absence, ce qu'ils font déjà.
    artworkUrl: release ? `https://coverartarchive.org/release/${release.id}/front-250` : null,
    url: `https://musicbrainz.org/recording/${r.id}`,
  };
}

module.exports = { name: 'musicbrainz', label: 'MusicBrainz', search };
