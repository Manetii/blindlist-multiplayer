/**
 * ════════════════════════════════════════════════════════════════
 *  STATE — Variables globales partagées entre les modules Host
 * ════════════════════════════════════════════════════════════════
 *
 *  Tous les modules accèdent à ce singleton via `Host.State`.
 *  Variables mutables : players, tracks, currentIdx, isPlaying, editIdx
 *  Variables Web Audio : audioCtx, gainNode, analyser, sourceNode, vizRAF, currentVizColor
 *
 *  Constantes exportées : COLORS, FADE_DURATION, CROSSFADE_DURATION, EMOJIS
 * ════════════════════════════════════════════════════════════════
 */

window.Host = window.Host || {};

Host.State = {
  // ─── Constantes ─────────────────────────────────────────────
  COLORS: [
    "#00e5ff", "#ff6b6b", "#ffd166", "#06d6a0", "#f72585",
    "#4cc9f0", "#fb923c", "#a3e635", "#c084fc", "#38bdf8",
  ],
  FADE_DURATION:      1.5,  // secondes pour fade in/out
  CROSSFADE_DURATION: 2,    // secondes de chevauchement
  EMOJIS: ["🎉","🎊","🎵","🎶","🎸","🥳","⭐","🌟","💫","✨","🔥","💥"],

  // ─── État de la partie ──────────────────────────────────────
  players:    [],
  tracks:     [],
  currentIdx: -1,
  isPlaying:  false,
  editIdx:    null,

  // ─── Web Audio ──────────────────────────────────────────────
  audioCtx:        null,
  gainNode:        null,
  analyser:        null,
  sourceNode:      null,   // MediaElementSource (singleton)
  vizRAF:          null,
  currentVizColor: "#00e5ff",

  // ─── Confetti ───────────────────────────────────────────────
  confettiRAF:  null,
  confettiList: [],

  // ─── Élément <audio> (initialisé par app.js) ────────────────
  audio: null,
};
