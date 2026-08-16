/**
 * ════════════════════════════════════════════════════════════════
 *  MOTEUR AUDIO — console de jeu
 * ════════════════════════════════════════════════════════════════
 *
 *  Lecture depuis les fichiers LOCAUX de l'hôte. Aucun audio ne
 *  transite par le serveur : un <audio> pointe sur un object URL créé
 *  à partir du File choisi dans le dossier.
 *
 *  Graphe : <audio> → MediaElementSource → GainNode → destination
 *
 *  Le GainNode est indispensable pour les fondus. Sans lui, chaque
 *  démarrage et chaque saut produit un clic audible — parfois un vrai
 *  claquement selon l'endroit de la forme d'onde. C'est le seul défaut
 *  qui s'entend immédiatement dans une pièce.
 *
 *  Les fichiers sont indexés par NUMÉRO D'ACQUISITION, la même clé que
 *  le manifeste et la vérification. Le nom réel du fichier n'a aucune
 *  importance au-delà de son préfixe.
 * ════════════════════════════════════════════════════════════════
 */

window.AudioEngine = (() => {
  'use strict';

  const FADE_IN_MS   = 700;
  const FADE_OUT_MS  = 500;
  const SEEK_FADE_MS = 60;    // suffit à masquer le clic d'un saut

  let ctx = null;
  let el = null;
  let gain = null;
  let currentUrl = null;

  /**
   * Map<nomDeFichier, File> — remplie au chargement du dossier.
   *
   * L'index est le NOM, pas le numéro d'acquisition : depuis que
   * l'appariement se fait sur les métadonnées, les fichiers gardent le
   * nom que l'outil de téléchargement leur a donné. C'est ce nom que la
   * base a enregistré à la vérification (tracks.file_name).
   */
  const files = new Map();

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    const src = ctx.createMediaElementSource(el);
    gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(ctx.destination);
  }

  // ─── Dossier ────────────────────────────────────────────────

  /**
   * Indexe les fichiers audio d'un dossier par numéro d'acquisition.
   * @returns {{indexed:number, ignored:number}}
   */
  function loadFiles(fileList) {
    files.clear();
    let ignored = 0;
    for (const f of Array.from(fileList)) {
      if (!/\.(mp3|m4a|flac|wav|ogg)$/i.test(f.name)) { ignored++; continue; }
      files.set(f.name, f);
    }
    return { indexed: files.size, ignored };
  }

  const has = (fileName) => !!fileName && files.has(fileName);
  const count = () => files.size;

  /** Noms attendus mais absents du dossier. */
  function missing(expectedNames) {
    return expectedNames.filter(n => !n || !files.has(n));
  }

  // ─── Lecture ────────────────────────────────────────────────

  /**
   * Charge un morceau et démarre à l'offset voulu, en fondu.
   * @param {string} fileName       nom enregistré à la vérification
   * @param {number} startOffsetMs  heuristique du serveur, ou choix de l'hôte
   */
  async function play(fileName, startOffsetMs = 0) {
    init();
    if (ctx.state === 'suspended') await ctx.resume();

    const file = files.get(fileName);
    if (!file) throw new Error(`Fichier « ${fileName} » absent du dossier.`);

    stopImmediate();
    currentUrl = URL.createObjectURL(file);
    el.src = currentUrl;

    await new Promise((resolve, reject) => {
      el.onloadedmetadata = resolve;
      el.onerror = () => reject(new Error('Fichier illisible.'));
    });

    // Ne jamais démarrer au-delà de la fin : un offset trop grand
    // déclencherait immédiatement l'événement de fin de piste.
    el.currentTime = Math.min(startOffsetMs / 1000, Math.max(0, el.duration - 5));

    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    await el.play();
    gain.gain.exponentialRampToValueAtTime(1, ctx.currentTime + FADE_IN_MS / 1000);
  }

  /**
   * Saut relatif, avec micro-fondu de part et d'autre.
   *
   * Un currentTime brutal en pleine lecture produit un clic audible.
   * Soixante millisecondes de chaque côté le rendent inaudible.
   */
  async function skip(deltaSec) {
    if (!el || el.paused) return null;
    const target = Math.max(0, Math.min(el.currentTime + deltaSec, el.duration - 3));

    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + SEEK_FADE_MS / 1000);

    await new Promise(r => setTimeout(r, SEEK_FADE_MS));
    el.currentTime = target;

    const t2 = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t2);
    gain.gain.exponentialRampToValueAtTime(1, t2 + SEEK_FADE_MS / 1000);

    return Math.round(target * 1000);
  }

  function togglePause() {
    if (!el) return false;
    if (el.paused) { el.play(); return true; }
    el.pause();
    return false;
  }

  /**
   * Baisse le volume sans interrompre la lecture.
   *
   * Utilisé au moment de la révélation : le morceau continue — c'est
   * souvent le moment où l'on a enfin envie de l'écouter — mais assez
   * bas pour que les commentaires de la table passent au-dessus.
   */
  function duck(level = 0.35) {
    if (!ctx || !gain) return;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
    gain.gain.exponentialRampToValueAtTime(Math.max(level, 0.0001), t + 0.8);
  }

  /** Arrêt en fondu. */
  async function stop() {
    if (!el || !ctx) return;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + FADE_OUT_MS / 1000);
    await new Promise(r => setTimeout(r, FADE_OUT_MS));
    stopImmediate();
  }

  function stopImmediate() {
    if (el) { el.pause(); el.removeAttribute('src'); el.load(); }
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  }

  function setVolume(v) {
    init();
    gain.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.05);
  }

  const position = () => (el ? { current: el.currentTime, duration: el.duration || 0 } : null);
  const isPlaying = () => !!el && !el.paused;
  const onEnded = (fn) => { init(); el.addEventListener('ended', fn); };

  return {
    loadFiles, has, count, missing,
    play, skip, stop, duck, togglePause, setVolume,
    position, isPlaying, onEnded,
  };
})();
