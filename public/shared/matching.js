/**
 * ════════════════════════════════════════════════════════════════
 *  MATCHING — apparier des fichiers locaux à une playlist
 * ════════════════════════════════════════════════════════════════
 *
 *  Remplace l'obligation de renommer chaque fichier avec un préfixe
 *  numérique. On lit les tags ID3, on compare aux métadonnées venues
 *  de l'API, et on propose un appariement avec un INDICE DE CONFIANCE
 *  que l'hôte corrige d'un clic si besoin.
 *
 *  Trois sources d'information, par ordre de fiabilité :
 *    1. tags ID3v2 (TIT2 / TPE1 / TALB)
 *    2. tags ID3v1 (128 derniers octets, format hérité)
 *    3. nom du fichier, décomposé en « Artiste - Titre »
 *
 *  Et un quatrième signal, indépendant des trois autres : la DURÉE
 *  mesurée. C'est le meilleur discriminant — deux morceaux au titre
 *  proche ont rarement la même durée à trois secondes près, et un live
 *  ou un remix se trahit immédiatement.
 *
 *  Le préfixe numérique reste reconnu quand il existe : c'est alors
 *  une certitude, pas une estimation.
 * ════════════════════════════════════════════════════════════════
 */

window.Matching = (() => {
  'use strict';

  const DURATION_TOLERANCE_MS = 3000;

  // ─── Lecture des tags ───────────────────────────────────────

  /**
   * Extrait les tags d'un fichier audio.
   * Ne lit que les 256 premiers Kio et les 128 derniers octets : inutile
   * de charger 8 Mo en mémoire pour trois chaînes de caractères.
   */
  async function readTags(file) {
    const head = await file.slice(0, 524288).arrayBuffer();
    const v2 = parseID3v2(new DataView(head));
    // On garde la pochette même si titre et artiste manquent : c'est
    // souvent le seul élément présent sur un fichier mal tagué, et
    // c'est celui qui manque aux morceaux ajoutés par lien.
    if (v2 && (v2.title || v2.artist || v2.picture)) return { ...v2, source: 'id3v2' };

    if (file.size > 128) {
      const tail = await file.slice(file.size - 128).arrayBuffer();
      const v1 = parseID3v1(new Uint8Array(tail));
      if (v1 && (v1.title || v1.artist)) return { ...v1, source: 'id3v1' };
    }
    return { ...parseFileName(file.name), source: 'filename' };
  }

  function parseID3v2(view) {
    if (view.byteLength < 10) return null;
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2));
    if (magic !== 'ID3') return null;

    const major = view.getUint8(3);
    // La taille de l'en-tête est toujours « synchsafe » : 7 bits utiles
    // par octet, le 8e étant réservé.
    const size = synchsafe(view, 6);
    const out = {};
    let pos = 10;
    const end = Math.min(10 + size, view.byteLength);

    while (pos + 10 <= end) {
      const id = String.fromCharCode(
        view.getUint8(pos), view.getUint8(pos + 1),
        view.getUint8(pos + 2), view.getUint8(pos + 3)
      );
      if (!/^[A-Z0-9]{4}$/.test(id)) break;   // zone de bourrage

      // ID3v2.4 encode aussi les tailles de trame en synchsafe ; v2.3
      // les écrit en entier 32 bits classique. Confondre les deux
      // décale toutes les trames suivantes.
      const frameSize = major >= 4 ? synchsafe(view, pos + 4) : view.getUint32(pos + 4);
      pos += 10;
      if (frameSize <= 0 || pos + frameSize > view.byteLength) break;

      if (id === 'TIT2' || id === 'TPE1' || id === 'TALB') {
        const text = decodeText(view, pos, frameSize);
        if (id === 'TIT2') out.title = text;
        if (id === 'TPE1') out.artist = text;
        if (id === 'TALB') out.album = text;
      } else if (id === 'APIC' && !out.picture) {
        out.picture = parsePicture(view, pos, frameSize);
      }
      pos += frameSize;
    }
    return out;
  }

  function synchsafe(view, offset) {
    return (view.getUint8(offset) << 21) | (view.getUint8(offset + 1) << 14)
         | (view.getUint8(offset + 2) << 7) | view.getUint8(offset + 3);
  }

  function decodeText(view, pos, len) {
    const encoding = view.getUint8(pos);
    const bytes = new Uint8Array(view.buffer, view.byteOffset + pos + 1, len - 1);
    let label;
    switch (encoding) {
      case 1:  label = 'utf-16';   break;   // avec BOM
      case 2:  label = 'utf-16be'; break;
      case 3:  label = 'utf-8';    break;
      default: label = 'iso-8859-1';
    }
    try {
      return new TextDecoder(label).decode(bytes).replace(/\0+$/, '').trim();
    } catch {
      return '';
    }
  }

/**
 * Pochette embarquée (frame APIC).
 *
 * Structure : encodage (1 octet), type MIME terminé par 0, type
 * d'image (1 octet), description terminée par 0 selon l'encodage, puis
 * les données brutes. La description peut être en UTF-16, auquel cas
 * elle se termine par DEUX octets nuls — l'oublier décale le début de
 * l'image et produit un fichier illisible.
 */
  function parsePicture(view, pos, len) {
    try {
      const end = pos + len;
      const encoding = view.getUint8(pos);
      let p = pos + 1;

      let mime = '';
      while (p < end && view.getUint8(p) !== 0) mime += String.fromCharCode(view.getUint8(p++));
      p++;                       // octet nul de fin de MIME
      p++;                       // type d'image

      if (encoding === 1 || encoding === 2) {
        while (p + 1 < end && !(view.getUint8(p) === 0 && view.getUint8(p + 1) === 0)) p += 2;
        p += 2;
      } else {
        while (p < end && view.getUint8(p) !== 0) p++;
        p++;
      }

      if (p >= end) return null;
      return {
        mime: mime || 'image/jpeg',
        bytes: new Uint8Array(view.buffer, view.byteOffset + p, end - p),
      };
    } catch {
      return null;
    }
  }

  /**
   * Convertit une pochette embarquée en URL de données réduite.
   *
   * Une pochette de fichier pèse souvent plusieurs centaines de kilo-
   * octets ; stockée telle quelle en base et renvoyée à chaque écran,
   * elle coûterait bien plus qu'elle ne rapporte. On la redimensionne
   * à 300 px et on la recompresse — quelques dizaines de kilo-octets.
   */
  async function pictureToDataUrl(picture, size = 300) {
    if (!picture || !picture.bytes || !picture.bytes.length) return null;
    const blob = new Blob([picture.bytes], { type: picture.mime });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = reject;
        i.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Recadrage centré : les pochettes sont carrées, mais pas toujours.
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function parseID3v1(bytes) {
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== 'TAG') return null;
    const str = (from, len) =>
      new TextDecoder('iso-8859-1').decode(bytes.slice(from, from + len))
        .replace(/\0+$/, '').trim();
    return { title: str(3, 30), artist: str(33, 30), album: str(63, 30) };
  }

  /**
   * Dernier recours : le nom du fichier.
   * Reconnaît « Artiste - Titre », avec ou sans numéro de piste devant.
   */
  function parseFileName(name) {
    let base = name.replace(/\.(mp3|m4a|flac|wav|ogg)$/i, '');
    base = base.replace(/^\d{1,3}[\s._-]+/, '');           // numéro de piste
    const parts = base.split(/\s+-\s+|\s+–\s+|__/);
    if (parts.length >= 2) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    }
    return { title: base.trim(), artist: '' };
  }

  // ─── Similarité ─────────────────────────────────────────────

  function normalize(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      // Une parenthèse contenant une mention d'édition est retirée EN
      // ENTIER. Ne supprimer que le mot laissait l'année derrière lui
      // (« One More Time (Remastered 2021) » → « one more time 2021 »),
      // ce qui suffisait à faire chuter le score sous le seuil.
      .replace(/[([][^)\]]*\b(feat|ft|with|remaster(ed)?|version|edit|mix|explicit|deluxe|mono|stereo|bonus|anniversary)\b[^)\]]*[)\]]/g, '')
      .replace(/\b(19|20)\d{2}\b/g, '')      // année d'édition résiduelle
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Coefficient de Dice sur les bigrammes.
   * Tolérant aux fautes de frappe et aux mots manquants, ce qui est
   * exactement le profil d'erreur des tags ID3.
   */
  function dice(a, b) {
    a = normalize(a); b = normalize(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

    const grams = (s) => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) {
        const g = s.slice(i, i + 2);
        m.set(g, (m.get(g) || 0) + 1);
      }
      return m;
    };
    const ga = grams(a), gb = grams(b);
    let inter = 0, total = 0;
    for (const [g, n] of ga) { inter += Math.min(n, gb.get(g) || 0); total += n; }
    for (const n of gb.values()) total += n;
    return (2 * inter) / total;
  }

  function durationScore(a, b) {
    if (!a || !b) return 0.5;               // inconnue : ni bonus ni malus
    const gap = Math.abs(a - b);
    if (gap <= DURATION_TOLERANCE_MS) return 1;
    if (gap > 30000) return 0;
    return 1 - (gap - DURATION_TOLERANCE_MS) / 27000;
  }

  /**
   * Score d'appariement entre un fichier et un morceau attendu.
   *
   * Le titre pèse le plus, la durée sert d'arbitre : deux morceaux du
   * même artiste au titre proche se départagent presque toujours à la
   * durée.
   */
  function score(file, track) {
    const t = dice(file.tags.title,  track.title);
    const a = dice(file.tags.artist, track.artist);
    const d = durationScore(file.durationMs, track.duration_ms);
    return 0.45 * t + 0.25 * a + 0.30 * d;
  }

  // ─── Appariement ────────────────────────────────────────────

  const CONFIDENCE = {
    exact:  { min: 1.00, label: 'numéro',  cls: 'high' },
    high:   { min: 0.82, label: 'sûr',     cls: 'high' },
    medium: { min: 0.60, label: 'probable', cls: 'medium' },
    low:    { min: 0.35, label: 'douteux', cls: 'low' },
  };

  function confidenceOf(s, byNumber) {
    if (byNumber) return CONFIDENCE.exact;
    if (s >= CONFIDENCE.high.min)   return CONFIDENCE.high;
    if (s >= CONFIDENCE.medium.min) return CONFIDENCE.medium;
    if (s >= CONFIDENCE.low.min)    return CONFIDENCE.low;
    return null;
  }

  /**
   * Apparie une liste de fichiers à une liste de morceaux attendus.
   *
   * Deux passes :
   *   1. les fichiers portant un préfixe numérique valide sont
   *      attribués directement — c'est une certitude
   *   2. les autres sont appariés par score, du meilleur au pire,
   *      chaque fichier et chaque morceau ne servant qu'une fois
   *
   * L'approche gloutonne suffit ici : les scores sont très contrastés,
   * et l'hôte peut corriger. Un algorithme d'affectation optimale
   * serait de la précision gagnée là où il n'y a pas d'ambiguïté.
   */
  function match(files, tracks) {
    const assigned = new Map();     // trackId → { file, score, confidence }
    const usedFiles = new Set();

    // Passe 1 — préfixe numérique
    for (const f of files) {
      const m = f.name.match(/^(\d{1,3})[\s._-]/);
      if (!m) continue;
      const no = parseInt(m[1], 10);
      const track = tracks.find(t => t.acquisition_no === no);
      if (track && !assigned.has(track.id)) {
        assigned.set(track.id, { file: f, score: 1, confidence: CONFIDENCE.exact, byNumber: true });
        usedFiles.add(f);
      }
    }

    // Passe 2 — score décroissant
    const pairs = [];
    for (const f of files) {
      if (usedFiles.has(f)) continue;
      for (const t of tracks) {
        if (assigned.has(t.id)) continue;
        pairs.push({ f, t, s: score(f, t) });
      }
    }
    pairs.sort((x, y) => y.s - x.s);

    for (const { f, t, s } of pairs) {
      if (usedFiles.has(f) || assigned.has(t.id)) continue;
      const conf = confidenceOf(s, false);
      if (!conf) continue;            // sous le seuil : on n'invente pas
      assigned.set(t.id, { file: f, score: s, confidence: conf, byNumber: false });
      usedFiles.add(f);
    }

    // Passe 3 — dernier recours par élimination.
    //
    // Un fichier dépourvu de tags exploitables ne franchit jamais le
    // seuil : sans titre ni artiste, son score plafonne à 0,30. Mais
    // s'il ne reste qu'un fichier ET qu'un morceau, et que leurs durées
    // concordent, l'appariement est le seul possible. C'est le
    // raisonnement qu'un humain ferait ; on le propose en « douteux »,
    // à charge pour l'hôte de confirmer.
    const restFiles  = files.filter(f => !usedFiles.has(f));
    const restTracks = tracks.filter(t => !assigned.has(t.id));
    if (restFiles.length === 1 && restTracks.length === 1) {
      const f = restFiles[0], t = restTracks[0];
      if (durationScore(f.durationMs, t.duration_ms) >= 0.9) {
        assigned.set(t.id, {
          file: f, score: score(f, t),
          confidence: { ...CONFIDENCE.low, label: 'par élimination' },
          byNumber: false,
        });
        usedFiles.add(f);
      }
    }

    return {
      matches: tracks.map(t => ({ track: t, ...(assigned.get(t.id) || { file: null }) })),
      unusedFiles: files.filter(f => !usedFiles.has(f)),
      stats: {
        total: tracks.length,
        matched: assigned.size,
        sure: [...assigned.values()].filter(m => m.confidence.cls === 'high').length,
        toCheck: [...assigned.values()].filter(m => m.confidence.cls !== 'high').length,
        missing: tracks.length - assigned.size,
      },
    };
  }

  return { readTags, pictureToDataUrl, match, score, dice, normalize,
           parseFileName, CONFIDENCE, DURATION_TOLERANCE_MS };
})();
