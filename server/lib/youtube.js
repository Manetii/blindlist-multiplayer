/**
 * ════════════════════════════════════════════════════════════════
 *  YOUTUBE — identification et vérification d'intégrabilité
 * ════════════════════════════════════════════════════════════════
 *
 *  En mode YouTube, l'URL collée par un participant remplace le fichier
 *  audio : c'est elle qui sera jouée le jour J. Une erreur ne se
 *  découvre donc plus pendant l'appariement, mais en pleine manche —
 *  au pire moment.
 *
 *  D'où la vérification à la collecte. oEmbed suffit et ne demande
 *  AUCUNE clé d'API : il répond 200 avec le titre pour une vidéo
 *  intégrable, 401 ou 403 quand l'ayant droit interdit l'intégration,
 *  404 quand la vidéo est privée ou supprimée. C'est exactement la
 *  distinction qui nous intéresse, et elle arrive gratuitement.
 *
 *  Il rend aussi le titre et la chaîne, ce qui permet de pré-remplir la
 *  saisie plutôt que de la demander à froid.
 * ════════════════════════════════════════════════════════════════
 */

const ID_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
  /(?:youtu\.be\/)([\w-]{11})/,
  /(?:music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
  /(?:youtube\.com\/embed\/)([\w-]{11})/,
  /(?:youtube\.com\/shorts\/)([\w-]{11})/,
];

/** Identifiant à 11 caractères, ou null. */
function parseId(raw) {
  const url = String(raw || '').trim();
  for (const re of ID_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  // Un identifiant collé seul, sans son URL autour.
  if (/^[\w-]{11}$/.test(url)) return url;
  return null;
}

/** URL canonique : celle qu'on stocke, quelle que soit la forme collée. */
function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * URL d'intégration.
 *
 * `youtube-nocookie.com` ne pose pas de cookie de suivi tant que la
 * lecture n'a pas commencé : c'est ce qui rend le consentement RGPD
 * gérable avec un simple écran de chargement différé.
 *
 * `enablejsapi` ouvre le pilotage depuis nos propres boutons ; `rel=0`
 * limite les suggestions de fin à la même chaîne — on ne peut pas les
 * supprimer, seulement les restreindre.
 */
function embedUrl(id, { origin } = {}) {
  const params = new URLSearchParams({
    enablejsapi: '1',
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
  });
  if (origin) params.set('origin', origin);
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

/**
 * Interroge oEmbed.
 *
 * @returns {Promise<{ok:boolean, title?:string, author?:string, reason?:string}>}
 */
async function probe(id, { timeoutMs = 6000 } = {}) {
  const target = 'https://www.youtube.com/oembed?format=json&url='
               + encodeURIComponent(watchUrl(id));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: ctrl.signal });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'embed_refused' };
    }
    if (res.status === 404) {
      return { ok: false, reason: 'not_found' };
    }
    if (!res.ok) return { ok: false, reason: 'unavailable' };

    const data = await res.json();
    return { ok: true, title: data.title || '', author: data.author_name || '' };
  } catch {
    // Panne réseau ou délai dépassé : on ne bloque PAS l'ajout. Un
    // participant qui colle une URL valide depuis une connexion capricieuse
    // ne doit pas être renvoyé sans recours ; la console revérifiera
    // l'ensemble avant la soirée.
    return { ok: true, title: '', author: '', unverified: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Message destiné au participant, à partir du motif de refus. */
function reasonText(reason) {
  return {
    embed_refused: 'Cette vidéo interdit la lecture hors de YouTube. Cherche une autre version.',
    not_found:     'Vidéo introuvable, privée ou supprimée.',
    unavailable:   'YouTube ne répond pas pour cette vidéo. Réessaie dans un instant.',
  }[reason] || 'Lien inutilisable.';
}

module.exports = { parseId, watchUrl, embedUrl, probe, reasonText };
