/**
 * ════════════════════════════════════════════════════════════════
 *  RECHERCHE — fournisseur Deezer
 * ════════════════════════════════════════════════════════════════
 *
 *  L'API de recherche publique ne demande ni clé ni compte. Elle
 *  complète utilement iTunes sur le répertoire francophone et sur les
 *  sorties récentes.
 *
 *  RÉSERVE À CONNAÎTRE : les conditions d'utilisation de Deezer sont
 *  restrictives sur l'usage ludique, et leur programme développeur est
 *  dans un état incertain. On l'utilise ici pour de la recherche de
 *  métadonnées uniquement — aucun extrait audio n'est lu — mais ce
 *  fournisseur est le premier à retirer si la situation se durcit.
 * ════════════════════════════════════════════════════════════════
 */

const ENDPOINT = 'https://api.deezer.com/search';
const TIMEOUT_MS = 6000;

async function search(query, { limit = 15 } = {}) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(Math.min(limit, 25)));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Deezer a répondu ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Deezer indisponible');
    return (data.data || []).map(normalize).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function normalize(r) {
  if (!r.title || !r.artist) return null;
  return {
    source: 'deezer',
    sourceId: String(r.id),
    title: r.title_short || r.title,
    artist: r.artist.name,
    album: r.album ? r.album.title : null,
    // Deezer donne la durée en SECONDES, contrairement aux autres.
    durationMs: Number.isFinite(r.duration) ? r.duration * 1000 : null,
    artworkUrl: (r.album && (r.album.cover_medium || r.album.cover)) || null,
    url: r.link || null,
  };
}

module.exports = { name: 'deezer', label: 'Deezer', search };
