/**
 * ════════════════════════════════════════════════════════════════
 *  PLAYLIST — Chargement MP3, parsing ID3, rendu de la playlist
 * ════════════════════════════════════════════════════════════════
 *
 *  loadFiles(input)   : ajoute des MP3 à la playlist + parse ID3
 *  parseID3(buf)      : extrait titre, artiste, pochette
 *  renderPlaylist()   : rendu HTML de la playlist
 *  removeTrack(idx)   : suppression et libération mémoire
 *  clearPlaylist()    : vide tout
 * ════════════════════════════════════════════════════════════════ */

Host.Playlist = (() => {

  /** Charge un ou plusieurs fichiers depuis un <input type=file>. */
  function loadFiles(input) {
    const S = Host.State;
    const files = Array.from(input.files);

    files.forEach((file) => {
      const url = URL.createObjectURL(file);
      const name = file.name.replace(/\.[^/.]+$/, "");

      // Tentative de match avec un placeholder existant (par filename)
      const placeholderIdx = S.tracks.findIndex(t =>
        t.isPlaceholder && t.savedFilename === file.name
      );

      if (placeholderIdx !== -1) {
        // On remplace le placeholder par le vrai morceau
        const ph = S.tracks[placeholderIdx];
        const real = {
          url, file,
          title:     ph.title  || name,
          artist:    ph.artist || '',
          player:    ph.player || '',
          keyMoment: ph.keyMoment,
          art:       null,
          played:    ph.played,
          isPlaceholder: false,
        };
        S.tracks[placeholderIdx] = real;
        readID3(placeholderIdx, file);
        console.log(`[playlist] Placeholder remplacé : ${file.name}`);
      } else {
        // Nouveau morceau (pas de placeholder correspondant)
        const track = {
          url, file,
          title: name, artist: "",
          player: "", keyMoment: null,
          art: null, played: false,
          isPlaceholder: false,
        };
        S.tracks.push(track);
        if (Host.Storage) Host.Storage.applyConfigToTrack(track);
        readID3(S.tracks.length - 1, file);
      }
    });

    render();
    if (S.currentIdx === -1 && S.tracks.length > 0) {
      // Ne charger que le premier morceau réel (pas un placeholder)
      const firstReal = S.tracks.findIndex(t => !t.isPlaceholder);
      if (firstReal !== -1) Host.Controls.loadTrack(firstReal, false);
    }
    if (Host.Game) Host.Game.updateGameButtons();

    // Re-appliquer le statut "joué" depuis le storage
    if (Host.Storage) Host.Storage.applyPlayedToTracks();

    // Sauvegarder la nouvelle liste
    if (Host.Storage) Host.Storage.autoSave();
  }

  /**
   * Charge un dossier complet (input webkitdirectory).
   * Si un playlist.json est présent à la racine du dossier :
   *   - on remplace TOUTE la config (joueurs, tracks, configs) par celle du JSON
   *   - on charge les MP3 et on applique la priorité ID3 > playlist.json > filename
   * Sinon : équivalent à loadFiles standard sur les MP3 du dossier.
   *
   * NOTE : webkitdirectory donne tous les fichiers (avec leur webkitRelativePath)
   * dans input.files. Le playlist.json sera typiquement à
   * <folderName>/playlist.json
   */
  async function loadFolder(input) {
    const allFiles = Array.from(input.files);
    if (allFiles.length === 0) return;

    // Réinitialiser l'input pour permettre de re-sélectionner le même dossier
    input.value = '';

    // Sépare playlist.json et MP3
    const jsonFile = allFiles.find(f => /(^|\/)playlist\.json$/i.test(f.webkitRelativePath || f.name));
    const mp3Files = allFiles.filter(f => /\.mp3$/i.test(f.name));

    if (mp3Files.length === 0) {
      alert('Aucun MP3 trouvé dans ce dossier.');
      return;
    }

    if (!jsonFile) {
      // Pas de config → comportement standard, on charge les MP3 comme avec "+ Charger MP3"
      console.log(`[playlist] Dossier sans playlist.json : chargement de ${mp3Files.length} MP3 simples`);
      loadFiles({ files: mp3Files });
      return;
    }

    // Lire et parser le JSON
    let config;
    try {
      const text = await jsonFile.text();
      config = JSON.parse(text);
    } catch (err) {
      alert('Erreur de lecture du playlist.json :\n' + err.message);
      return;
    }

    if (!config || !Array.isArray(config.players) || !Array.isArray(config.tracks)) {
      alert('Le fichier playlist.json est invalide (joueurs ou morceaux manquants).');
      return;
    }

    // Confirmation avant écrasement (uniquement si quelque chose existe déjà)
    const S = Host.State;
    const hadContent = S.players.length > 0 || S.tracks.length > 0;
    if (hadContent) {
      const ok = confirm(
        `Charger ce dossier va remplacer la configuration actuelle :\n` +
        `  • ${S.players.length} joueur${S.players.length > 1 ? 's' : ''} → ${config.players.length}\n` +
        `  • ${S.tracks.length} morceau${S.tracks.length > 1 ? 'x' : ''} → ${config.tracks.length}\n\n` +
        `Continuer ?`
      );
      if (!ok) return;
    }

    // Remplacer la config existante
    console.log(`[playlist] Chargement preset : ${config.players.length} joueurs, ${config.tracks.length} morceaux`);
    applyPresetConfig(config, mp3Files);
  }

  /**
   * Applique une config (playlist.json) à l'état :
   * - écrase les joueurs
   * - écrase les tracks (en chargeant les MP3 du dossier qui correspondent)
   * - lit les ID3 et applique la priorité ID3 > config > filename
   */
  function applyPresetConfig(config, mp3Files) {
    const S = Host.State;

    // 1. Stop et reset complet
    if (Host.Controls) Host.Controls.stopAndClear();
    S.players = [];
    S.tracks  = [];
    S.currentIdx = -1;

    // 2. Importer les joueurs
    config.players.forEach(p => {
      S.players.push({
        name:      p.name,
        color:     p.color || '#5a7080',
        score:     0,
        connected: false,
      });
    });

    // 3. Importer les tracks (dans l'ordre du JSON)
    // On cherche le MP3 par filename. Si introuvable → placeholder.
    const mp3ByName = new Map();
    mp3Files.forEach(f => mp3ByName.set(f.name, f));

    config.tracks.forEach((cfg, i) => {
      const file = mp3ByName.get(cfg.filename);
      if (!file) {
        // Fichier manquant → placeholder visible (rare car on vient juste de
        // charger le dossier qui devrait les contenir)
        S.tracks.push({
          url: null, file: null,
          title:     cfg.title  || cfg.filename.replace(/\.[^/.]+$/, ''),
          artist:    cfg.artist || '',
          player:    cfg.player || '',
          keyMoment: cfg.keyMoment != null ? cfg.keyMoment : null,
          art:       null,
          played:    false,
          isPlaceholder: true,
          savedFilename: cfg.filename,
        });
        return;
      }

      const url = URL.createObjectURL(file);
      const fnameNoExt = file.name.replace(/\.[^/.]+$/, '');
      const track = {
        url, file,
        // Init avec config + fallback filename. L'ID3 viendra écraser ensuite.
        title:     cfg.title  || fnameNoExt,
        artist:    cfg.artist || '',
        player:    cfg.player || '',
        keyMoment: cfg.keyMoment != null ? cfg.keyMoment : null,
        art:       null,
        played:    false,
        isPlaceholder: false,
      };
      S.tracks.push(track);
      // Lire ID3 → priorité aux métadonnées MP3 si présentes
      readID3PresetMode(S.tracks.length - 1, file, cfg);
    });

    // 4. Render et notify
    if (Host.Players) Host.Players.render();
    render();
    if (Host.Storage) Host.Storage.autoSave();
    if (Host.Game) Host.Game.updateGameButtons();
    if (Host.Socket) Host.Socket.publishPlayers();

    // 5. Charger le 1er morceau réel
    const firstReal = S.tracks.findIndex(t => !t.isPlaceholder);
    if (firstReal !== -1) Host.Controls.loadTrack(firstReal, false);
  }

  /**
   * Variante de readID3 pour le mode preset : la priorité est ID3 > config CSV.
   * Si ID3 a une valeur, on l'utilise ; sinon on garde celle du config (déjà
   * dans la track). Pour la pochette, c'est toujours l'ID3.
   */
  function readID3PresetMode(idx, file, cfg) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf  = e.target.result;
      const meta = parseID3(buf);
      const S    = Host.State;
      const t    = S.tracks[idx];
      if (!t) return;

      // Priorité ID3 > config (CSV) > filename
      if (meta.title  && meta.title.trim())  t.title  = meta.title.trim();
      if (meta.artist && meta.artist.trim()) t.artist = meta.artist.trim();
      if (meta.art) t.art = meta.art;
      if (meta.artDataUrl) t.artDataUrl = meta.artDataUrl;

      render();
      if (idx === S.currentIdx) {
        Host.Controls.updateNowPlaying();
        Host.Controls.updateKeyMomentUI();
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /** Lit le fichier en ArrayBuffer et tente de parser les tags ID3. */
  function readID3(idx, file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const buf  = e.target.result;
      const meta = parseID3(buf);
      const S    = Host.State;
      if (meta.title)  S.tracks[idx].title  = meta.title;
      if (meta.artist) S.tracks[idx].artist = meta.artist;
      if (meta.art)    S.tracks[idx].art    = meta.art;

      // Maintenant qu'on a le titre + artiste ID3, on peut chercher
      // une config sauvegardée par signature ID3 (plus fiable que le nom de fichier)
      if (Host.Storage) Host.Storage.applyConfigToTrack(S.tracks[idx]);

      render();
      if (idx === S.currentIdx) {
        Host.Controls.updateNowPlaying();
        Host.Controls.updateKeyMomentUI();
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /** Décode un texte ID3 selon son byte d'encoding (ISO-8859-1, UTF-8, UTF-16 LE/BE). */
  function decodeID3String(buf, offset, length) {
    if (length <= 0) return "";
    const enc = new DataView(buf).getUint8(offset);
    const bytes = new Uint8Array(buf, offset + 1, length - 1);

    if (enc === 0) {
      // ISO-8859-1
      return Array.from(bytes)
        .filter((b) => b !== 0)
        .map((b) => String.fromCharCode(b))
        .join("");
    }
    if (enc === 3) {
      // UTF-8
      return new TextDecoder("utf-8").decode(
        bytes.filter
          ? new Uint8Array(Array.from(bytes).filter((b) => b !== 0))
          : bytes,
      );
    }
    if (enc === 1 || enc === 2) {
      // UTF-16 avec ou sans BOM — strip BOM (FF FE / FE FF) et null terminators
      let start = 0;
      if (
        bytes.length >= 2 &&
        ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
          (bytes[0] === 0xfe && bytes[1] === 0xff))
      ) {
        start = 2;
      }
      const littleEndian =
        (bytes[0] === 0xff && bytes[1] === 0xfe) || enc === 1;
      const relevant = bytes.slice(start);
      const u16 = [];
      for (let i = 0; i + 1 < relevant.length; i += 2) {
        const cp = littleEndian
          ? relevant[i] | (relevant[i + 1] << 8)
          : (relevant[i] << 8) | relevant[i + 1];
        if (cp === 0) break;
        u16.push(cp);
      }
      return String.fromCharCode(...u16);
    }
    return "";
  }

  /** Parse un ID3v2 tag : retourne { title, artist, art (URL blob ou null) }. */
  function parseID3(buf) {
    const dv = new DataView(buf);
    const out = { title: "", artist: "", art: null };

    if (
      String.fromCharCode(
        dv.getUint8(0), dv.getUint8(1), dv.getUint8(2),
      ) !== "ID3"
    )
      return out;

    // ID3v2 header : 3 ID + 2 version + 1 flags + 4 syncsafe size
    const flags  = dv.getUint8(5);
    const hasExt = (flags & 0x40) !== 0;
    let pos = 10;

    // Skip extended header si présent
    if (hasExt) {
      const extSz =
        ((dv.getUint8(10) & 0x7f) << 21) |
        ((dv.getUint8(11) & 0x7f) << 14) |
        ((dv.getUint8(12) & 0x7f) << 7)  |
        (dv.getUint8(13) & 0x7f);
      pos += extSz;
    }

    const end = Math.min(buf.byteLength, 2000000);

    while (pos + 10 < end) {
      // Frame ID : 4 bytes
      const frameId = String.fromCharCode(
        dv.getUint8(pos),
        dv.getUint8(pos + 1),
        dv.getUint8(pos + 2),
        dv.getUint8(pos + 3),
      );
      if (frameId === "\0\0\0\0" || frameId.trim() === "") break;

      // Frame size : 4 bytes big-endian (non-syncsafe en v2.3)
      let sz = dv.getUint32(pos + 4);
      if (sz === 0 || sz > end - pos - 10) break;

      if (frameId === "TIT2" || frameId === "TPE1") {
        const txt = decodeID3String(buf, pos + 10, sz);
        if (frameId === "TIT2") out.title  = txt;
        if (frameId === "TPE1") out.artist = txt;
      }

      if (frameId === "APIC" && !out.art) {
        let p = pos + 10;
        p++; // encoding byte
        // MIME type (null-terminated ASCII)
        let mime = "";
        while (p < end && dv.getUint8(p) !== 0) {
          mime += String.fromCharCode(dv.getUint8(p++));
        }
        p++; // null terminator du MIME
        p++; // picture type byte
        // Description (skip jusqu'à null/double-null selon encoding)
        const apicEnc = dv.getUint8(pos + 10);
        if (apicEnc === 1 || apicEnc === 2) {
          while (
            p + 1 < end &&
            !(dv.getUint8(p) === 0 && dv.getUint8(p + 1) === 0)
          ) p++;
          p += 2;
        } else {
          while (p < end && dv.getUint8(p) !== 0) p++;
          p++;
        }
        const imgBuf = buf.slice(p, pos + 10 + sz);
        const blob = new Blob([imgBuf], { type: mime || "image/jpeg" });
        // URL locale (pour affichage côté Host : vinyl-art, reveal, fond)
        out.art = URL.createObjectURL(blob);
        // dataURL base64 (envoyée aux joueurs au moment du reveal car les
        // blob: URLs ne sont pas valides chez eux). On la pré-calcule ici
        // pour que le reveal soit instantané.
        try {
          const u8  = new Uint8Array(imgBuf);
          let bin = '';
          // Construire une string binaire en chunks pour éviter le stack overflow
          // sur les grosses pochettes (apply a une limite d'arguments)
          const CHUNK = 0x8000;
          for (let k = 0; k < u8.length; k += CHUNK) {
            bin += String.fromCharCode.apply(null, u8.subarray(k, k + CHUNK));
          }
          const b64 = btoa(bin);
          out.artDataUrl = `data:${mime || 'image/jpeg'};base64,${b64}`;
        } catch (e) {
          // En cas d'erreur (pochette trop grosse ?), on laisse artDataUrl à null
          out.artDataUrl = null;
        }
      }

      pos += 10 + sz;
    }
    return out;
  }

  function clearPlaylist() {
    const S = Host.State;
    S.tracks.forEach((t) => {
      URL.revokeObjectURL(t.url);
      if (t.art) URL.revokeObjectURL(t.art);
    });
    S.tracks = [];
    S.currentIdx = -1;
    S.audio.pause();
    S.audio.src = "";
    Host.Controls.setPlayState(false);
    document.getElementById("vinyl").classList.remove("spinning");
    document.getElementById("np-title").textContent = "—";
    document.getElementById("np-artist").textContent =
      "Charge un fichier pour commencer";
    document.getElementById("btn-reveal").style.display = "none";
    document.getElementById("progress-fill").style.width = "0%";
    document.getElementById("time-cur").textContent = "0:00";
    document.getElementById("time-tot").textContent = "0:00";
    Host.Controls.updateKeyMomentUI();
    render();
    if (Host.Game) Host.Game.updateGameButtons();
  }

  // ─── Anonymisation : masque titres / artistes / joueurs ──
  // Activé automatiquement à l'entrée en GAME (anti-spoil)
  let anonymized = false;

  function setAnonymized(value) {
    anonymized = !!value;
    // Synchronise les 2 checkboxes (PRE_GAME et IN_GAME)
    const cbIn = document.getElementById('chk-anonymize');
    if (cbIn) cbIn.checked = anonymized;
    const cbPre = document.getElementById('chk-anonymize-pre');
    if (cbPre) cbPre.checked = anonymized;
    render();
  }

  function isAnonymized() { return anonymized; }

  // ─── Tri d'affichage ─────────────────────────────────────
  // Affecte uniquement le rendu de la playlist : l'ordre de stockage
  // (State.tracks) est inchangé, et le tirage en GAME reste aléatoire.
  // Modes : 'original', 'title', 'artist', 'player', 'shuffle'
  let sortMode = 'original';
  let shuffleSeed = null;   // index aléatoire stable pour 'shuffle'

  function setSortMode(mode) {
    sortMode = mode || 'original';
    if (sortMode === 'shuffle') {
      // Génère une permutation des index pour un shuffle stable jusqu'au
      // prochain re-shuffle ou changement de mode
      const n = (Host.State.tracks || []).length;
      const arr = Array.from({ length: n }, (_, i) => i);
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      shuffleSeed = arr;
    } else {
      shuffleSeed = null;
    }
    // Reflète dans le select
    const sel = document.getElementById('playlist-sort');
    if (sel && sel.value !== sortMode) sel.value = sortMode;
    render();
  }

  /** Calcule l'ordre d'affichage selon sortMode.
   *  Retourne un tableau d'index dans State.tracks. */
  function computeDisplayOrder() {
    const S = Host.State;
    const indices = S.tracks.map((_, i) => i);

    if (sortMode === 'original') return indices;

    if (sortMode === 'shuffle') {
      // Si shuffleSeed n'est plus aligné avec la longueur (track ajoutée/retirée),
      // on régénère
      if (!shuffleSeed || shuffleSeed.length !== indices.length) {
        setSortMode('shuffle');
      }
      return shuffleSeed.slice();
    }

    const cmp = (a, b) => {
      const ta = S.tracks[a], tb = S.tracks[b];
      let va = '', vb = '';
      if (sortMode === 'title')  { va = ta.title  || ''; vb = tb.title  || ''; }
      if (sortMode === 'artist') { va = ta.artist || ''; vb = tb.artist || ''; }
      if (sortMode === 'player') { va = ta.player || ''; vb = tb.player || ''; }
      const c = va.toLowerCase().localeCompare(vb.toLowerCase(), 'fr');
      return c !== 0 ? c : (a - b);
    };
    return indices.sort(cmp);
  }

  function render() {
    const S  = Host.State;
    const el = document.getElementById("playlist-el");
    // Synchronise les checkboxes anonymize
    const cb = document.getElementById('chk-anonymize');
    if (cb && cb.checked !== anonymized) cb.checked = anonymized;
    const cbPre = document.getElementById('chk-anonymize-pre');
    if (cbPre && cbPre.checked !== anonymized) cbPre.checked = anonymized;
    // Synchronise le select de tri
    const sel = document.getElementById('playlist-sort');
    if (sel && sel.value !== sortMode) sel.value = sortMode;

    if (!S.tracks.length) {
      el.innerHTML = '<div class="empty">Charge des fichiers audio…</div>';
      return;
    }

    // Calcule l'ordre d'affichage selon le mode de tri
    const order = computeDisplayOrder();

    el.innerHTML = order
      .map((i, displayPos) => {
        const t = S.tracks[i];
        const p = S.players.find((pl) => pl.name === t.player);
        const color = p ? p.color : "#5a7080";
        const km = t.keyMoment !== null ? `⏱ ${SharedUtils.fmt(t.keyMoment)}` : "";
        const playedClass = t.played ? " played" : "";
        const activeClass = i === S.currentIdx ? " active" : "";
        const placeholderClass = t.isPlaceholder ? " placeholder" : "";
        const inGame = Host.Match && Host.Match.isInGame();

        // Anonymisation = cache uniquement le badge joueur (titre/artiste visibles)
        const showAnon = anonymized;
        const playerBadge = (t.player && !showAnon)
          ? `<div class="track-player-badge" style="color:${color};border-color:${color}44;background:${color}18">${SharedUtils.esc(t.player)}</div>`
          : (showAnon ? `<div class="track-player-badge anon">👤</div>` : '');

        // Numéro affiché : position dans l'ordre courant (1-based)
        const displayNum = displayPos + 1;

        // Placeholder = pas cliquable, juste un visuel d'attente
        if (t.isPlaceholder) {
          return `<div class="track-item placeholder${playedClass}" title="Recharge ce fichier MP3 pour reprendre">
            <div class="track-idx">⌛</div>
            <div class="track-body">
              <div class="track-title-el">${SharedUtils.esc(t.title)}</div>
              <div class="track-sub">${SharedUtils.esc(t.savedFilename || 'Fichier manquant')} · à recharger</div>
            </div>
            ${playerBadge}
          </div>`;
        }

        // En partie : pas de clic preview, pas d'actions ⚙ ✕
        const clickAttr = inGame ? '' : `onclick="Host.Controls.loadTrack(${i},true)" title="Cliquer pour pré-écouter"`;
        const actionsHtml = inGame ? '' : `
          <div class="track-actions" onclick="event.stopPropagation()">
            <button class="btn-icon" onclick="Host.EditModal.open(${i})" title="Configurer">⚙</button>
            <button class="btn-icon" onclick="Host.Playlist.removeTrack(${i})" title="Supprimer">✕</button>
          </div>`;

        return `<div class="track-item${activeClass}${playedClass}${placeholderClass}" ${clickAttr}>
          <div class="track-eq"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>
          <div class="track-idx">${t.played ? '✓' : displayNum}</div>
          <div class="track-body">
            <div class="track-title-el">${SharedUtils.esc(t.title)}</div>
            <div class="track-sub">${SharedUtils.esc(t.artist || "Artiste inconnu")} ${km ? "· " + km : ""}${t.played ? " · joué" : ""}</div>
          </div>
          ${playerBadge}
          ${actionsHtml}
        </div>`;
      })
      .join("");
  }

  function removeTrack(idx) {
    const S = Host.State;
    URL.revokeObjectURL(S.tracks[idx].url);
    S.tracks.splice(idx, 1);
    if (S.currentIdx === idx) {
      S.audio.pause();
      S.audio.src = "";
      Host.Controls.setPlayState(false);
      S.currentIdx = -1;
      if (S.tracks.length > 0)
        Host.Controls.loadTrack(Math.min(idx, S.tracks.length - 1), false);
    } else if (S.currentIdx > idx) {
      S.currentIdx--;
    }
    render();
    if (Host.Game) Host.Game.updateGameButtons();
  }

  return {
    loadFiles, loadFolder, parseID3, clearPlaylist,
    render, removeTrack, readID3,
    setAnonymized, isAnonymized,
    setSortMode,
  };
})();
