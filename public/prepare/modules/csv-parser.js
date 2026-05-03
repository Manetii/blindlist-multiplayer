/**
 * ════════════════════════════════════════════════════════════════
 *  CSV Parser — Lecture du tableur joueur/titre/artiste/momentClé
 * ════════════════════════════════════════════════════════════════
 *
 *  Format attendu (séparateur ;, , ou tab détecté auto) :
 *
 *    Joueur ; Titre ; Artiste ; Moment Clé
 *    Bob    ; Bohemian Rhapsody ; Queen ; 1:30
 *    Alice  ; Hey Jude ; The Beatles ; 90
 *
 *  Tolérant à la casse et aux variantes FR/EN sur les noms d'en-tête.
 *  Le moment clé accepte "90" (secondes) ou "1:30" (m:ss).
 * ════════════════════════════════════════════════════════════════ */

window.CSVParser = (() => {

  const HEADERS = {
    player:    ['joueur', 'player', 'pseudo', 'nom'],
    title:     ['titre', 'title', 'morceau', 'song'],
    artist:    ['artiste', 'artist'],
    keyMoment: ['moment cle', 'momentcle', 'moment_cle', 'moment',
                'moment clé', 'momentclé', 'moment_clé',
                'keymoment', 'key moment', 'key_moment'],
  };

  /** Normalise un en-tête : minuscule, sans accents. */
  function normalize(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  /** Parse un timecode "1:30" ou "90" → 90 (secondes), null si invalide ou vide. */
  function parseKeyMoment(str) {
    const s = String(str || '').trim();
    if (!s) return null;

    if (s.includes(':')) {
      const parts = s.split(':').map(p => parseInt(p.trim(), 10));
      if (parts.some(n => Number.isNaN(n))) return null;
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      return null;
    }

    const n = parseInt(s, 10);
    if (Number.isNaN(n) || n < 0) return null;
    return n;
  }

  /** Parse une ligne CSV en respectant les guillemets. */
  function parseLine(line, sep) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        cur += c; i++;
      } else {
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === sep) { out.push(cur); cur = ''; i++; continue; }
        cur += c; i++;
      }
    }
    out.push(cur);
    return out;
  }

  /** Détecte le séparateur d'une première ligne. */
  function detectSeparator(line) {
    const candidates = [';', ',', '\t'];
    let best = ';';
    let bestCount = 0;
    for (const c of candidates) {
      const count = line.split(c).length;
      if (count > bestCount) { best = c; bestCount = count; }
    }
    return best;
  }

  /** Trouve l'index de colonne pour un type donné. */
  function findColumn(headerCells, aliases) {
    for (let i = 0; i < headerCells.length; i++) {
      if (aliases.includes(headerCells[i])) return i;
    }
    return -1;
  }

  /** Parse le contenu CSV.
   *  Retourne { rows: [...], errors: [...], warnings: [...] }. */
  function parse(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);  // strip BOM

    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const errors = [];
    const warnings = [];

    if (lines.length === 0) {
      return { rows: [], errors: ['Fichier vide'], warnings };
    }

    const sep = detectSeparator(lines[0]);
    const headerCells = parseLine(lines[0], sep).map(normalize);

    const colPlayer    = findColumn(headerCells, HEADERS.player);
    const colTitle     = findColumn(headerCells, HEADERS.title);
    const colArtist    = findColumn(headerCells, HEADERS.artist);
    const colKeyMoment = findColumn(headerCells, HEADERS.keyMoment);

    if (colPlayer === -1) {
      return {
        rows: [], errors: [
          'Colonne "Joueur" introuvable dans l\'en-tête.\n' +
          'En-têtes attendus : Joueur, Titre, Artiste, Moment Clé.'
        ], warnings,
      };
    }
    if (colTitle === -1) {
      return {
        rows: [], errors: [
          'Colonne "Titre" introuvable dans l\'en-tête.'
        ], warnings,
      };
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseLine(lines[i], sep);
      const player = (cells[colPlayer] || '').trim();
      const title  = (cells[colTitle]  || '').trim();
      const artist = colArtist  >= 0 ? (cells[colArtist]  || '').trim() : '';
      const kmRaw  = colKeyMoment >= 0 ? (cells[colKeyMoment] || '').trim() : '';

      if (!player && !title) continue;   // ligne vide silencieuse
      if (!player) {
        warnings.push(`Ligne ${i + 1} : "Joueur" manquant — ignorée`);
        continue;
      }
      if (!title) {
        warnings.push(`Ligne ${i + 1} : "Titre" manquant pour ${player} — ignorée`);
        continue;
      }

      let keyMoment = null;
      if (kmRaw) {
        keyMoment = parseKeyMoment(kmRaw);
        if (keyMoment === null) {
          warnings.push(`Ligne ${i + 1} : moment clé "${kmRaw}" invalide — ignoré`);
        }
      }

      rows.push({
        line: i + 1,
        player,
        title,
        artist,
        keyMoment,
      });
    }

    return { rows, errors, warnings };
  }

  return { parse, parseKeyMoment };
})();
