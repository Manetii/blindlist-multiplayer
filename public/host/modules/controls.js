/**
 * ════════════════════════════════════════════════════════════════
 *  CONTROLS — Contrôles de lecture
 * ════════════════════════════════════════════════════════════════
 *
 *  loadTrack(idx, autoplay)    : charge un morceau, fade éventuel
 *  loadTrackInternal(idx)      : charge sans gérer le fade
 *  togglePlay / next / prev / playRandom
 *  seekTo(event)               : seek via clic sur la progress bar
 *  setVolume(val), setKeyMoment, jumpToKeyMoment
 *  updateNowPlaying, updateKeyMomentUI, setPlayState
 * ════════════════════════════════════════════════════════════════ */

Host.Controls = (() => {

  /** Charge un morceau sans toucher au gain (utilisé après un fade out). */
  function loadTrackInternal(idx) {
    const S = Host.State;
    S.currentIdx = idx;
    const t = S.tracks[idx];
    S.audio.src = t.url;
    S.audio.load();
    updateNowPlaying();
    Host.Playlist.render();
    updateKeyMomentUI();
    document.getElementById("btn-reveal").style.display = "block";

    // NOTE : on NE push PLUS automatiquement le track-start aux joueurs.
    // C'est désormais le bouton "Lancer un nouveau tour" qui le fait
    // (Host.Game.startNewRound), pour permettre la navigation libre
    // dans la playlist sans déranger les joueurs.
  }

  /** Charge un morceau avec gestion du fade et du crossfade éventuel. */
  function loadTrack(idx, autoplay) {
    const S = Host.State;
    if (idx < 0 || idx >= S.tracks.length) return;

    Host.AudioEngine.ensureAudioCtx();

    if (autoplay && !S.audio.paused && S.gainNode) {
      // Crossfade : fade out → switch → fade in
      Host.AudioEngine.fadeOut(() => {
        loadTrackInternal(idx);
        const p = S.audio.play();
        if (p && p.then) p.then(() => Host.AudioEngine.fadeIn()).catch(() => {});
      });
    } else {
      loadTrackInternal(idx);
      if (autoplay) {
        if (S.gainNode) {
          S.gainNode.gain.setValueAtTime(0, S.audioCtx.currentTime);
          const p = S.audio.play();
          if (p && p.then) p.then(() => Host.AudioEngine.fadeIn()).catch(() => {});
        } else {
          const p = S.audio.play();
          if (p && p.catch) p.catch(() => {});
        }
      }
    }
  }

  function updateNowPlaying() {
    const S = Host.State;
    const t = S.tracks[S.currentIdx];
    if (!t) return;  // pas de morceau actif (ex: après import CSV)
    document.getElementById("np-title").textContent = t.title || "—";
    document.getElementById("np-artist").textContent =
      t.artist || "Artiste inconnu";

    const vinylArt = document.getElementById("vinyl-art");
    if (t.art) {
      vinylArt.src = t.art;
      vinylArt.style.display = "block";
      document.getElementById("vinyl-dot").style.display = "none";
    } else {
      vinylArt.style.display = "none";
      document.getElementById("vinyl-dot").style.display = "block";
    }
  }

  function togglePlay() {
    const S = Host.State;
    if (!S.tracks.length) return;
    Host.AudioEngine.ensureAudioCtx();
    if (S.currentIdx === -1) {
      loadTrack(0, true);
      return;
    }
    if (S.audio.paused) {
      if (S.gainNode) {
        S.gainNode.gain.setValueAtTime(0, S.audioCtx.currentTime);
        S.audio
          .play()
          .then(() => Host.AudioEngine.fadeIn())
          .catch(() => {});
      } else {
        S.audio.play().catch(() => {});
      }
    } else {
      Host.AudioEngine.fadeOut(() => S.audio.pause());
    }
  }

  function prevTrack() {
    const S = Host.State;
    if (!S.tracks.length) return;
    Host.AudioEngine.ensureAudioCtx();
    const idx = S.currentIdx <= 0 ? S.tracks.length - 1 : S.currentIdx - 1;
    loadTrack(idx, true);
  }

  function nextTrack() {
    const S = Host.State;
    if (!S.tracks.length) return;
    Host.AudioEngine.ensureAudioCtx();
    loadTrack((S.currentIdx + 1) % S.tracks.length, true);
  }

  function playRandom() {
    const S = Host.State;
    if (!S.tracks.length) return;
    Host.AudioEngine.ensureAudioCtx();
    let idx;
    do {
      idx = Math.floor(Math.random() * S.tracks.length);
    } while (S.tracks.length > 1 && idx === S.currentIdx);
    loadTrack(idx, true);
  }

  /** Synchronise les icônes Play/Pause selon l'état. */
  function setPlayState(playing) {
    Host.State.isPlaying = playing;
    // Transport classique (mode config)
    const icoPlay  = document.getElementById("ico-play");
    const icoPause = document.getElementById("ico-pause");
    if (icoPlay)  icoPlay.style.display  = playing ? "none" : "block";
    if (icoPause) icoPause.style.display = playing ? "block" : "none";
    // Bouton soirée (mode partie)
    const icoPlaySoiree  = document.getElementById("ico-play-soiree");
    const icoPauseSoiree = document.getElementById("ico-pause-soiree");
    if (icoPlaySoiree)  icoPlaySoiree.style.display  = playing ? "none" : "inline-block";
    if (icoPauseSoiree) icoPauseSoiree.style.display = playing ? "inline-block" : "none";
  }

  function seekTo(event) {
    const S = Host.State;
    const bar = document.getElementById("progress-bar");
    const rect = bar.getBoundingClientRect();
    const pct = (event.clientX - rect.left) / rect.width;
    S.audio.currentTime = pct * S.audio.duration;
  }

  // ─── Volume ────────────────────────────────────────────────
  function setVolume(val) {
    const S = Host.State;
    S.audio.volume = val / 100;
    if (S.gainNode && !S.audio.paused) S.gainNode.gain.value = S.audio.volume;
    document.getElementById("vol-val").textContent = val + "%";
  }

  // ─── Key Moment ────────────────────────────────────────────
  function setKeyMoment() {
    const S = Host.State;
    if (S.currentIdx === -1) return;
    S.tracks[S.currentIdx].keyMoment = Math.floor(S.audio.currentTime);
    updateKeyMomentUI();
    Host.Playlist.render();
  }

  function jumpToKeyMoment(withFade) {
    const S = Host.State;
    if (S.currentIdx === -1 || S.tracks[S.currentIdx].keyMoment === null) return;
    const km = S.tracks[S.currentIdx].keyMoment;
    if (withFade && S.gainNode && !S.audio.paused) {
      Host.AudioEngine.fadeGain(S.gainNode.gain.value, 0, 0.4, () => {
        S.audio.currentTime = km;
        if (S.audio.paused) S.audio.play().catch(() => {});
        Host.AudioEngine.fadeGain(0, S.audio.volume, S.FADE_DURATION * 1.2, null);
      });
    } else {
      S.audio.currentTime = km;
      if (S.audio.paused) S.audio.play().catch(() => {});
    }
  }

  function updateKeyMomentUI() {
    const S = Host.State;
    const t = S.currentIdx >= 0 ? S.tracks[S.currentIdx] : null;
    const btn = document.getElementById("btn-km");
    const display = document.getElementById("km-time-display");
    if (t && t.keyMoment !== null) {
      btn.disabled = false;
      display.textContent = SharedUtils.fmt(t.keyMoment);
    } else {
      btn.disabled = true;
      display.textContent = "";
    }
    updateKmMarker();
  }

  /** Met à jour la position du marqueur de moment clé sur la barre. */
  function updateKmMarker() {
    const S      = Host.State;
    const marker = document.getElementById("progress-km-marker");
    if (!marker) return;
    const t = S.currentIdx >= 0 ? S.tracks[S.currentIdx] : null;
    const dur = S.audio ? S.audio.duration : NaN;
    if (t && t.keyMoment !== null && dur && !isNaN(dur) && dur > 0) {
      const pct = Math.min(100, (t.keyMoment / dur) * 100);
      marker.style.display = "block";
      marker.style.left = pct + "%";
    } else {
      marker.style.display = "none";
    }
  }

  /** Branche les événements de l'élément <audio>. */
  function bindAudioEvents() {
    const S = Host.State;
    S.audio.addEventListener("timeupdate", () => {
      if (!S.audio.duration) return;
      const pct = (S.audio.currentTime / S.audio.duration) * 100;
      document.getElementById("progress-fill").style.width = pct + "%";
      document.getElementById("time-cur").textContent = SharedUtils.fmt(S.audio.currentTime);
      document.getElementById("time-tot").textContent = SharedUtils.fmt(S.audio.duration);
    });

    // Quand la durée devient disponible, on peut positionner le marqueur
    S.audio.addEventListener("durationchange", () => {
      updateKmMarker();
    });

    S.audio.addEventListener("ended", () => {
      // En mode GAME : on n'enchaîne PAS automatiquement. Le Host doit
      // cliquer "Lancer le morceau suivant" (ou attendre que les joueurs
      // votent puis cliquer Révéler). Le morceau reste juste à la fin,
      // affiché comme avant.
      if (Host.Match && Host.Match.isInGame()) {
        // On reste sur le morceau, on remet juste l'état "pause" UI
        setPlayState(false);
        document.getElementById("vinyl").classList.remove("spinning");
        return;
      }
      // En PRE_GAME (preview), on enchaîne comme avant
      Host.AudioEngine.crossfadeToNext();
    });

    S.audio.addEventListener("play", () => {
      setPlayState(true);
      document.getElementById("vinyl").classList.add("spinning");
      document.getElementById("np-status").style.opacity = "1";
      if (S.audioCtx) S.audioCtx.resume();
    });

    S.audio.addEventListener("pause", () => {
      setPlayState(false);
      document.getElementById("vinyl").classList.remove("spinning");
      document.getElementById("np-status").style.opacity = "0";
    });
  }

  /** Coupe la musique en cours, vide la source, reset le titre/artiste
   *  à un état neutre "En attente". Utilisé au démarrage de la partie
   *  pour stopper la preview et préparer le premier tour, et au retour
   *  en PRE_GAME depuis l'écran de fin. */
  function stopAndClear() {
    const S = Host.State;

    // Si l'audio joue et qu'on a un GainNode, on fait un fade out rapide
    // avant de couper — évite le clic/saut brutal
    const doStop = () => {
      try {
        S.audio.pause();
        S.audio.removeAttribute('src');
        S.audio.load();
      } catch (e) {}

      S.currentIdx = -1;

      document.getElementById("np-title").textContent  = "En attente…";
      document.getElementById("np-artist").textContent = "Lance le premier tour pour commencer";
      document.getElementById("progress-fill").style.width = "0%";
      document.getElementById("time-cur").textContent = "0:00";
      document.getElementById("time-tot").textContent = "0:00";
      const marker = document.getElementById("progress-km-marker");
      if (marker) marker.style.display = "none";

      const vinyl = document.getElementById("vinyl");
      if (vinyl) vinyl.classList.remove("spinning");

      const vinylArt = document.getElementById("vinyl-art");
      if (vinylArt) { vinylArt.style.display = "none"; vinylArt.src = ""; }
      const dot = document.getElementById("vinyl-dot");
      if (dot) dot.style.display = "block";

      const artBg = document.getElementById("art-bg");
      if (artBg) { artBg.style.backgroundImage = ""; artBg.classList.remove("visible"); }

      setPlayState(false);
      updateKeyMomentUI();
      if (Host.Playlist) Host.Playlist.render();

      // Restaurer le gain pour la prochaine lecture
      if (S.gainNode && S.audioCtx) {
        S.gainNode.gain.setValueAtTime(S.audio.volume, S.audioCtx.currentTime);
      }
    };

    if (!S.audio.paused && S.gainNode && S.audioCtx) {
      // Fade out en 0.6s puis stop
      const FADE = 0.6;
      const now  = S.audioCtx.currentTime;
      S.gainNode.gain.cancelScheduledValues(now);
      S.gainNode.gain.setValueAtTime(S.gainNode.gain.value, now);
      S.gainNode.gain.linearRampToValueAtTime(0, now + FADE);
      setTimeout(doStop, FADE * 1000);
    } else {
      doStop();
    }
  }

  return {
    loadTrack, loadTrackInternal,
    togglePlay, prevTrack, nextTrack, playRandom,
    setPlayState, seekTo, updateNowPlaying,
    setVolume, setKeyMoment, jumpToKeyMoment, updateKeyMomentUI,
    bindAudioEvents,
    stopAndClear,
  };
})();
