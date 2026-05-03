/**
 * ════════════════════════════════════════════════════════════════
 *  Matcher — Associe les MP3 aux lignes du tableur
 * ════════════════════════════════════════════════════════════════
 *
 *  Principe :
 *    1. On normalise les chaînes (minuscule, sans accents,
 *       sans (…), sans "feat.", "remastered", etc.)
 *    2. On calcule un score de similarité (Levenshtein normalisé)
 *       entre l'ID3 du MP3 (titre + artiste) et chaque ligne du CSV.
 *    3. Match auto si score ≥ 0.85 ET pas de concurrent proche.
 *    4. Sinon → laissé en manuel.
 * ════════════════════════════════════════════════════════════════ */

window.Matcher = (() => {

  const AUTO_MATCH_THRESHOLD = 0.85;   // score min pour match auto
  const AMBIGUITY_GAP = 0.05;          // écart min avec le 2e candidat

  // ─── Normalisation ──────────────────────────────────────────

  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Retire annotations courantes
      .replace(/\(.*?\)/g, ' ')
      .replace(/\[.*?\]/g, ' ')
      .replace(/\bfeat\.?\b/gi, ' ')
      .replace(/\bft\.?\b/gi, ' ')
      .replace(/\bremaster(ed)?\b/gi, ' ')
      .replace(/\bremix\b/gi, ' ')
      .replace(/\boriginal mix\b/gi, ' ')
      .replace(/\boriginal\b/gi, ' ')
      .replace(/\bversion\b/gi, ' ')
      .replace(/\blive\b/gi, ' ')
      // Retire la ponctuation
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      // Compacte les espaces
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ─── Distance Levenshtein ─────────────────────────────────

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    let cur  = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(
          cur[j - 1] + 1,        // insertion
          prev[j]   + 1,         // deletion
          prev[j - 1] + cost,    // substitution
        );
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }

  /** Score de similarité entre 0 et 1 (1 = identique).
   *  - Si l'une des chaînes est strictement contenue dans l'autre, on
   *    donne un score basé sur le ratio de longueurs (souvent élevé).
   *  - Sinon, Levenshtein normalisé. */
  function similarity(a, b) {
    const A = normalize(a);
    const B = normalize(b);
    if (!A && !B) return 1;
    if (!A || !B) return 0;

    if (A === B) return 1;

    // Inclusion : la chaîne courte est dans la longue → score haut
    // (= "Hey Jude" est dans "Hey Jude at Wembley")
    // On exige une longueur minimale pour éviter les faux positifs sur
    // des fragments triviaux ("Test" inclus dans "Tested" → faux positif).
    const [shortS, longS] = A.length <= B.length ? [A, B] : [B, A];
    if (shortS.length >= 6 && longS.includes(shortS)) {
      // Score basé sur le ratio des longueurs.
      return 0.7 + 0.3 * (shortS.length / longS.length);
    }

    // Cas général : Levenshtein normalisé
    const dist = levenshtein(A, B);
    const maxLen = Math.max(A.length, B.length);
    return 1 - dist / maxLen;
  }

  // ─── Score combiné titre + artiste ──────────────────────────

  /** Score d'association entre un MP3 et une ligne du tableur.
   *  - Le titre compte 70%, l'artiste 30%.
   *  - Si l'artiste manque côté MP3 ou côté ligne, on ne pondère que le titre.
   *  - Si l'ID3 du MP3 est vide (titre + artiste), on tente avec le filename
   *    nettoyé. Permet de matcher un fichier "Queen - Bohemian Rhapsody.mp3"
   *    sans ID3 à une ligne du tableur "Bohemian Rhapsody / Queen". */
  function scoreMatch(mp3, row) {
    const hasMp3Title  = mp3.title && mp3.title.trim();
    const hasMp3Artist = mp3.artist && mp3.artist.trim();

    // Cas dégradé : pas d'ID3 → on essaie avec le filename
    if (!hasMp3Title && !hasMp3Artist && mp3.name) {
      const fname = mp3.name.replace(/\.[^/.]+$/, '');   // sans extension
      const target = (row.artist ? row.artist + ' ' : '') + row.title;
      return similarity(fname, target) * 0.85;  // léger malus pour signaler que c'est un fallback
    }

    const titleScore = similarity(mp3.title, row.title);

    if (!hasMp3Artist || !row.artist) return titleScore;

    const artistScore = similarity(mp3.artist, row.artist);
    return titleScore * 0.7 + artistScore * 0.3;
  }

  // ─── Algorithme global ──────────────────────────────────────

  /** Calcule la matrice de scores entre tous les MP3 et toutes les rows.
   *  Renvoie une liste de matchs auto + une liste de pendings. */
  function match(mp3List, rows) {
    // Pour chaque MP3, on calcule son top des correspondances
    const mp3Candidates = mp3List.map(mp3 => {
      const candidates = rows.map((row, idx) => ({
        rowIdx: idx,
        score: scoreMatch(mp3, row),
      })).sort((a, b) => b.score - a.score);
      return { mp3, candidates };
    });

    // On affecte par ordre de meilleur score
    const matched = new Map();   // rowIdx → mp3
    const result = mp3List.map(() => null);
    const pendings = [];

    // Tri global par meilleur score (du plus sûr au moins sûr)
    const sorted = mp3Candidates
      .map((c, i) => ({ ...c, mp3Idx: i }))
      .sort((a, b) => (b.candidates[0]?.score || 0) - (a.candidates[0]?.score || 0));

    for (const { mp3, candidates, mp3Idx } of sorted) {
      // Trouver le meilleur candidat encore disponible
      const available = candidates.filter(c => !matched.has(c.rowIdx));
      if (available.length === 0) {
        pendings.push({ mp3Idx, mp3, candidates: [] });
        continue;
      }

      const best = available[0];
      const second = available[1];

      // Conditions pour match auto :
      //   - score ≥ seuil
      //   - écart suffisant avec le 2e (sinon ambigu)
      const isHighScore = best.score >= AUTO_MATCH_THRESHOLD;
      const hasGap = !second || (best.score - second.score >= AMBIGUITY_GAP);

      if (isHighScore && hasGap) {
        matched.set(best.rowIdx, mp3Idx);
        result[mp3Idx] = {
          mp3Idx,
          rowIdx: best.rowIdx,
          score: best.score,
          method: 'auto',
        };
      } else {
        pendings.push({ mp3Idx, mp3, candidates: available });
      }
    }

    return {
      matches: result.filter(m => m !== null),
      pendings,
      matchedRowIndices: new Set(matched.keys()),
    };
  }

  return { match, scoreMatch, similarity, normalize };
})();
