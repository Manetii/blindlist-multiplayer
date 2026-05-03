/**
 * ════════════════════════════════════════════════════════════════
 *  STORAGE — Persistance localStorage
 * ════════════════════════════════════════════════════════════════
 *
 *  Sauvegarde automatique de :
 *    - La liste des joueurs (avec leurs scores)
 *    - La liste des morceaux joués pour la partie en cours
 *    - Les configurations des morceaux (joueur associé, moment clé)
 *      indexées par signature : ID3 (artist + title) en priorité,
 *      sinon par nom de fichier
 *
 *  NB : On ne sauvegarde évidemment pas les fichiers MP3 eux-mêmes
 *  (trop lourd, pas autorisé en localStorage), juste les métadonnées.
 *  Le Host doit recharger ses fichiers à chaque démarrage, mais les
 *  configs (joueur ↔ morceau, moments clés) sont restaurées auto.
 * ════════════════════════════════════════════════════════════════ */

Host.Storage = (() => {

  const KEY_PLAYERS  = 'blindtest:players';
  const KEY_TRACK_CFG = 'blindtest:trackConfigs';  // configs par signature
  const KEY_PLAYED   = 'blindtest:playedTracks';   // signatures des morceaux joués
  const KEY_TRACK_LIST = 'blindtest:trackList';    // liste des morceaux configurés (titres + métas)

  let autoSaveTimer = null;

  // ─── Signature d'un morceau ─────────────────────────────────
  // On essaie d'abord par ID3 (artist|title), sinon par nom de fichier.
  // Renvoie un tableau de signatures candidates (la première qui matche
  // sert de clé).
  function trackSignatures(track) {
    const sigs = [];
    if (track.artist && track.title) {
      sigs.push(`id3:${track.artist.trim()}|${track.title.trim()}`.toLowerCase());
    }
    if (track.title) {
      sigs.push(`title:${track.title.trim()}`.toLowerCase());
    }
    if (track.file && track.file.name) {
      sigs.push(`file:${track.file.name}`.toLowerCase());
    }
    return sigs;
  }

  function primarySignature(track) {
    const all = trackSignatures(track);
    return all.length ? all[0] : null;
  }

  // ─── PLAYERS ────────────────────────────────────────────────

  function savePlayers() {
    try {
      const payload = Host.State.players.map(p => ({
        name:  p.name,
        color: p.color,
        score: p.score,
      }));
      localStorage.setItem(KEY_PLAYERS, JSON.stringify(payload));
      flashSaveStatus();
    } catch (e) {
      console.warn('[storage] savePlayers failed', e);
    }
  }

  function loadPlayers() {
    try {
      const raw = localStorage.getItem(KEY_PLAYERS);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch (e) {
      console.warn('[storage] loadPlayers failed', e);
      return [];
    }
  }

  // ─── TRACK CONFIGS ──────────────────────────────────────────

  /** Récupère le dictionnaire complet des configs sauvées. */
  function loadTrackConfigs() {
    try {
      const raw = localStorage.getItem(KEY_TRACK_CFG);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.warn('[storage] loadTrackConfigs failed', e);
      return {};
    }
  }

  function saveTrackConfigs(configs) {
    try {
      localStorage.setItem(KEY_TRACK_CFG, JSON.stringify(configs));
      flashSaveStatus();
    } catch (e) {
      console.warn('[storage] saveTrackConfigs failed', e);
    }
  }

  /** Sauvegarde la config d'un morceau (player + keyMoment) sous toutes ses signatures. */
  function saveTrackConfig(track) {
    const configs = loadTrackConfigs();
    const sigs = trackSignatures(track);
    if (!sigs.length) return;
    const data = {
      player:    track.player    || '',
      keyMoment: track.keyMoment !== undefined ? track.keyMoment : null,
      title:     track.title  || '',
      artist:    track.artist || '',
    };
    sigs.forEach(sig => { configs[sig] = data; });
    saveTrackConfigs(configs);
  }

  /** Cherche dans le storage la config matchant un morceau (par signatures). */
  function findConfigForTrack(track) {
    const configs = loadTrackConfigs();
    const sigs = trackSignatures(track);
    for (const sig of sigs) {
      if (configs[sig]) return configs[sig];
    }
    return null;
  }

  /** Applique sur un morceau frais sa config sauvegardée si elle existe. */
  function applyConfigToTrack(track) {
    const cfg = findConfigForTrack(track);
    if (!cfg) return false;
    if (cfg.player)              track.player    = cfg.player;
    if (cfg.keyMoment !== null
        && cfg.keyMoment !== undefined) track.keyMoment = cfg.keyMoment;
    return true;
  }

  // ─── PLAYED TRACKS ──────────────────────────────────────────

  function savePlayedTracks() {
    try {
      const sigs = Host.State.tracks
        .filter(t => t.played)
        .map(primarySignature)
        .filter(s => s);
      localStorage.setItem(KEY_PLAYED, JSON.stringify(sigs));
      flashSaveStatus();
    } catch (e) {
      console.warn('[storage] savePlayedTracks failed', e);
    }
  }

  function loadPlayedSignatures() {
    try {
      const raw = localStorage.getItem(KEY_PLAYED);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
      return new Set();
    }
  }

  // ─── TRACK LIST (liste des morceaux configurés, hors fichiers MP3) ───

  /** Sauvegarde la liste des morceaux actuellement chargés.
   *  Ne contient PAS les fichiers binaires (impossible localStorage),
   *  juste les métadonnées pour pouvoir afficher un rappel au reload. */
  function saveTrackList() {
    try {
      const list = Host.State.tracks.map(t => ({
        title:  t.title  || '',
        artist: t.artist || '',
        filename: t.file && t.file.name ? t.file.name : '',
      }));
      localStorage.setItem(KEY_TRACK_LIST, JSON.stringify(list));
    } catch (e) {
      console.warn('[storage] saveTrackList failed', e);
    }
  }

  /** Charge la liste des morceaux qui étaient configurés. */
  function loadTrackList() {
    try {
      const raw = localStorage.getItem(KEY_TRACK_LIST);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /** Marque comme "joués" les morceaux dont la signature est connue. */
  function applyPlayedToTracks() {
    const playedSigs = loadPlayedSignatures();
    if (!playedSigs.size) return;
    Host.State.tracks.forEach(t => {
      const sigs = trackSignatures(t);
      if (sigs.some(s => playedSigs.has(s))) t.played = true;
    });
  }

  // ─── AUTO-SAVE (debounced) ──────────────────────────────────

  /** Sauvegarde tout, debouncée à 400ms pour ne pas spammer. */
  function autoSave() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      savePlayers();
      savePlayedTracks();
      saveTrackList();
      // Les configs morceaux sont sauvées par saveTrackConfig au cas par cas
      autoSaveTimer = null;
    }, 400);
  }

  /** Sauvegarde immédiate (pour le bouton "Sauvegarder maintenant"). */
  function saveNow() {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    savePlayers();
    savePlayedTracks();
    saveTrackList();
    // Configs déjà sauvées au fil de l'eau, mais on les force aussi
    Host.State.tracks.forEach(t => {
      if (t.player || t.keyMoment !== null) saveTrackConfig(t);
    });
    flashSaveStatus(true);
  }

  // ─── UI : indicateur visuel "Sauvegardé" ────────────────────
  function flashSaveStatus(forced) {
    const el = document.getElementById('storage-status');
    if (!el) return;
    el.textContent = '✓ Sauvegardé';
    el.className   = 'storage-status visible';
    setTimeout(() => { el.className = 'storage-status'; }, forced ? 1800 : 1200);
  }

  // ─── RESET / EFFACER ────────────────────────────────────────
  /** Vide la sauvegarde localStorage sans aucune interaction utilisateur.
   *  Pour usage interne (ex : Reset complet qui gère sa propre confirmation). */
  function clearAll() {
    localStorage.removeItem(KEY_PLAYERS);
    localStorage.removeItem(KEY_TRACK_CFG);
    localStorage.removeItem(KEY_PLAYED);
    localStorage.removeItem(KEY_TRACK_LIST);
    flashSaveStatus(true);
  }

  // ─── EXPORT / IMPORT JSON ───────────────────────────────────

  /** Exporte toute la sauvegarde dans un fichier JSON téléchargé. */
  /**
   * Exporte la configuration actuelle au format playlist.json
   * (compatible avec celui généré par /prepare).
   *
   * Contient : joueurs (sans scores), morceaux avec associations + moments clés
   *            (sans état "joué" ni MP3 binaires).
   *
   * Le fichier produit est un "config-blindtest.json", utile pour :
   *   - Sauvegarder une configuration créée à la main
   *   - La partager avec un autre Host
   *   - La recharger plus tard pour rejouer la même playlist
   *
   * Note : les scores et l'état joué sont gérés séparément par l'auto-save
   *        localStorage, indépendamment de cet export.
   */
  function exportJSON() {
    const S = Host.State;

    // Joueurs : on retire le score et l'état "connected"
    const players = (S.players || []).map(p => ({
      name:  p.name,
      color: p.color,
    }));

    // Tracks : on garde uniquement les infos de configuration
    const tracks = (S.tracks || []).map(t => ({
      filename:  t.file ? t.file.name : (t.savedFilename || ''),
      title:     t.title  || '',
      artist:    t.artist || '',
      player:    t.player || '',
      keyMoment: (t.keyMoment != null) ? t.keyMoment : null,
    }));

    const payload = {
      version:   1,
      createdAt: new Date().toISOString(),
      players,
      tracks,
    };

    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `config-blindtest-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flashSaveStatus(true);
  }

  /**
   * Importe une configuration depuis un fichier playlist.json
   * (générée par /prepare ou par exportJSON ci-dessus).
   *
   * Remplace les joueurs et la config des morceaux. Comme on n'a pas les MP3
   * binaires, les morceaux sont créés en placeholders ⌛ : il faut ensuite
   * recharger les MP3 (via "+ Charger MP3" ou "📁 Charger un dossier")
   * pour qu'ils deviennent jouables.
   */
  function importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data || typeof data !== 'object') throw new Error('Format invalide');

        if (!Array.isArray(data.players) || !Array.isArray(data.tracks)) {
          throw new Error('Format playlist.json attendu (joueurs + morceaux requis)');
        }

        // Confirmation si quelque chose existe déjà
        const S = Host.State;
        const had = (S.players?.length || 0) > 0 || (S.tracks?.length || 0) > 0;
        if (had) {
          const ok = confirm(
            `Charger ce fichier va remplacer la configuration actuelle :\n` +
            `  • ${S.players.length} joueur${S.players.length > 1 ? 's' : ''} → ${data.players.length}\n` +
            `  • ${S.tracks.length} morceau${S.tracks.length > 1 ? 'x' : ''} → ${data.tracks.length}\n\n` +
            `Continuer ?`
          );
          if (!ok) return;
        }

        // Stop la lecture éventuelle
        if (Host.Controls) Host.Controls.stopAndClear();

        // Remplacer les joueurs (scores remis à 0 puisqu'on charge une "nouvelle config")
        S.players = data.players.map(p => ({
          name:      p.name,
          color:     p.color || '#5a7080',
          score:     0,
          connected: false,
        }));

        // Remplacer les tracks par des placeholders (les MP3 sont à recharger)
        S.tracks = data.tracks.map(cfg => ({
          url: null, file: null,
          title:     cfg.title  || (cfg.filename || '').replace(/\.[^/.]+$/, ''),
          artist:    cfg.artist || '',
          player:    cfg.player || '',
          keyMoment: (cfg.keyMoment != null) ? cfg.keyMoment : null,
          art:       null,
          played:    false,
          isPlaceholder: true,
          savedFilename: cfg.filename || '',
        }));
        S.currentIdx = -1;

        // Sauvegarder dans localStorage et rafraîchir
        autoSave();
        if (Host.Players)  Host.Players.render();
        if (Host.Playlist) Host.Playlist.render();
        if (Host.Game)     Host.Game.updateGameButtons();
        if (Host.Socket)   Host.Socket.publishPlayers();

        alert(
          `Configuration chargée : ${data.players.length} joueurs et ${data.tracks.length} morceaux.\n\n` +
          `⚠ Les MP3 doivent être rechargés via "+ Charger MP3" ou "📁 Charger un dossier" — ` +
          `les morceaux sont actuellement en placeholders ⌛.`
        );
      } catch (err) {
        alert('Erreur lors de l\'import : ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  return {
    // players
    savePlayers, loadPlayers,
    // tracks configs
    saveTrackConfig, applyConfigToTrack,
    loadTrackConfigs, saveTrackConfigs,
    // played
    savePlayedTracks, applyPlayedToTracks,
    // track list (rappel au reload)
    saveTrackList, loadTrackList,
    // global
    autoSave, saveNow, clearAll,
    // export/import
    exportJSON, importJSON,
    primarySignature, trackSignatures,
  };
})();
