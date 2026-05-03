/**
 * ════════════════════════════════════════════════════════════════
 *  AUDIO ENGINE — Web Audio Context, fades, crossfade
 * ════════════════════════════════════════════════════════════════
 *
 *  Initialise lazy-mente le AudioContext + le pipeline audio :
 *    <audio> → MediaElementSource → GainNode → Analyser → destination
 *
 *  Le GainNode permet les fades volume sans toucher au volume natif.
 *  L'Analyser est utilisé par le visualizer pour la FFT.
 * ════════════════════════════════════════════════════════════════ */

Host.AudioEngine = (() => {

  /** Initialise le pipeline audio si pas encore fait. À appeler avant toute lecture. */
  function ensureAudioCtx() {
    const S = Host.State;
    if (S.audioCtx) return;

    S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    S.gainNode = S.audioCtx.createGain();
    S.analyser = S.audioCtx.createAnalyser();
    S.analyser.fftSize = 256;
    S.analyser.smoothingTimeConstant = 0.82;

    S.sourceNode = S.audioCtx.createMediaElementSource(S.audio);
    S.sourceNode.connect(S.gainNode);
    S.gainNode.connect(S.analyser);
    S.analyser.connect(S.audioCtx.destination);

    S.gainNode.gain.value = S.audio.volume;
  }

  /** Rampe linéaire du gain de `from` vers `to` sur `duration` secondes. */
  function fadeGain(from, to, duration, cb) {
    const S = Host.State;
    if (!S.audioCtx) {
      if (cb) cb();
      return;
    }
    const now = S.audioCtx.currentTime;
    S.gainNode.gain.cancelScheduledValues(now);
    S.gainNode.gain.setValueAtTime(from, now);
    S.gainNode.gain.linearRampToValueAtTime(to, now + duration);
    if (cb) setTimeout(cb, duration * 1000);
  }

  /** Fade in du volume vers le niveau du <audio>. */
  function fadeIn(cb) {
    const S = Host.State;
    const target = S.audio.volume;
    S.gainNode.gain.setValueAtTime(0, S.audioCtx.currentTime);
    fadeGain(0, target, S.FADE_DURATION, cb);
  }

  /** Fade out vers 0 puis appelle cb (utile pour pause ou crossfade). */
  function fadeOut(cb) {
    const S = Host.State;
    const current = S.gainNode.gain.value;
    fadeGain(current, 0, S.FADE_DURATION, cb);
  }

  /** Enchaînement automatique en fin de morceau : fade out → next → fade in. */
  function crossfadeToNext() {
    const S = Host.State;
    const nextIdx = (S.currentIdx + 1) % S.tracks.length;
    if (!S.tracks.length) return;

    if (!S.audioCtx) {
      Host.Controls.loadTrack(nextIdx, true);
      return;
    }

    fadeOut(() => {
      Host.Controls.loadTrackInternal(nextIdx);
      S.audio
        .play()
        .then(() => fadeIn())
        .catch(() => {});
    });
  }

  return { ensureAudioCtx, fadeGain, fadeIn, fadeOut, crossfadeToNext };
})();
