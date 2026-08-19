/**
 * ════════════════════════════════════════════════════════════════
 *  MOTEUR YOUTUBE — même contrat qu'AudioEngine
 * ════════════════════════════════════════════════════════════════
 *
 *  Expose exactement la surface d'AudioEngine : play, skip, stop,
 *  duck, togglePause, setVolume, position, isPlaying, onEnded. La
 *  console de jeu ignore lequel des deux elle pilote — c'est ce qui
 *  permet aux deux modes de coexister sans que la logique de partie
 *  connaisse la différence.
 *
 *  UNE FENÊTRE SÉPARÉE, ET POURQUOI
 *
 *  Un blind test doit cacher l'identité du morceau ; un lecteur YouTube
 *  affiche son titre à la lecture, au survol, à la pause, et sa
 *  miniature avant de démarrer. Les conditions de l'API interdisent de
 *  masquer ou recouvrir le lecteur.
 *
 *  On ne le masque donc pas : on l'ouvre dans une fenêtre à part, que
 *  l'hôte pose là où la salle ne la voit pas. L'embed reste entier,
 *  visible et à taille normale ; ce qui change est la disposition du
 *  salon, pas le rendu du lecteur.
 *
 *  CONSÉQUENCES ASSUMÉES
 *
 *   - la fenêtre peut être fermée par mégarde : on le détecte et on
 *     propose de la rouvrir plutôt que d'envoyer des commandes dans le
 *     vide ;
 *   - `window.open` exige un geste utilisateur ; l'ouverture est donc
 *     accrochée au premier lancement, jamais au chargement de la page ;
 *   - pas de Web Audio, donc pas de fondus par courbe de gain. Les
 *     transitions se font au volume, par paliers rapprochés — moins fin
 *     qu'un ramp exponentiel, imperceptible en pratique.
 * ════════════════════════════════════════════════════════════════
 */

window.YouTubeEngine = (() => {
  const POPUP_FEATURES = 'width=560,height=360,menubar=no,toolbar=no,location=no';
  const FADE_MS = 260;
  const SEEK_FADE_MS = 120;

  let win = null;          // la fenêtre séparée
  let player = null;       // l'objet YT.Player, qui vit DANS cette fenêtre
  let volume = 85;         // 0–100, échelle de l'API YouTube
  let endedHandlers = [];
  let currentId = null;
  let onNeedWindow = null; // prévenu quand la fenêtre manque

  const isOpen = () => !!win && !win.closed;

  /** Prévient la console qu'il faut un geste de l'hôte. */
  function requireWindow() {
    if (typeof onNeedWindow === 'function') onNeedWindow();
    throw new Error('La fenêtre de lecture est fermée. Rouvre-la pour continuer.');
  }

  /**
   * Ouvre la fenêtre et y installe le lecteur.
   *
   * Doit être appelée depuis un gestionnaire d'événement : les
   * navigateurs bloquent toute ouverture qui ne descend pas d'un clic.
   */
  async function openWindow() {
    if (isOpen()) return true;

    win = window.open('/play/player-window.html', 'blindtest-player', POPUP_FEATURES);
    if (!win) return false;   // bloqué par le navigateur

    // La fenêtre nous signale que son lecteur est prêt. On l'attend
    // plutôt que de sonder : l'API YouTube met parfois deux secondes à
    // s'initialiser sur une connexion lente.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('La fenêtre de lecture n\'a pas répondu.')), 15000);
      const onReady = (e) => {
        if (e.source !== win || !e.data || e.data.type !== 'yt-ready') return;
        clearTimeout(timer);
        window.removeEventListener('message', onReady);
        player = { post: (cmd, arg) => win.postMessage({ type: 'yt-cmd', cmd, arg }, location.origin) };
        resolve();
      };
      window.addEventListener('message', onReady);
    });

    window.addEventListener('message', onMessage);
    player.post('setVolume', volume);
    return true;
  }

  function onMessage(e) {
    if (e.source !== win || !e.data) return;
    if (e.data.type === 'yt-ended') endedHandlers.forEach(fn => fn());
    if (e.data.type === 'yt-state') lastState = e.data.state;
  }

  let lastState = { playing: false, current: 0, duration: 0 };

  // ─── Contrat commun ─────────────────────────────────────────

  /**
   * @param {string} ref identifiant de vidéo (à la place d'un nom de fichier)
   */
  async function play(ref, startOffsetMs = 0) {
    if (!isOpen()) requireWindow();
    currentId = ref;
    player.post('load', { id: ref, startSeconds: Math.max(0, startOffsetMs / 1000), volume });
  }

  async function skip(deltaSec) {
    if (!isOpen()) return null;
    // Fondu court de part et d'autre : sans lui, un saut produit un
    // à-coup net, l'API ne proposant pas de courbe de volume.
    player.post('fadeSeek', { delta: deltaSec, fadeMs: SEEK_FADE_MS, volume });
    const target = Math.max(0, lastState.current + deltaSec);
    return Math.round(target * 1000);
  }

  function togglePause() {
    if (!isOpen()) return false;
    const next = !lastState.playing;
    player.post(next ? 'play' : 'pause');
    lastState.playing = next;
    return next;
  }

  /** Baisse sans interrompre — le morceau continue à la révélation. */
  function duck(level = 0.35) {
    if (!isOpen()) return;
    player.post('fadeTo', { target: Math.round(volume * level), fadeMs: 800 });
  }

  /** Défait un duck — le volume voulu n'a pas changé, seul le réel. */
  function unduck() {
    if (!isOpen()) return;
    player.post('fadeTo', { target: volume, fadeMs: 600 });
  }

  async function stop() {
    if (!isOpen()) return;
    player.post('fadeTo', { target: 0, fadeMs: FADE_MS });
    // On attend la FIN du fondu avant d'arrêter : couper au milieu
    // laisserait le volume à une valeur intermédiaire, que la commande
    // 'stop' rétablit ensuite au volume voulu.
    await new Promise(r => setTimeout(r, FADE_MS + 40));
    player.post('stop');
    currentId = null;
  }

  function setVolume(v) {
    volume = Math.round(Math.max(0, Math.min(1, v)) * 100);
    if (isOpen()) player.post('setVolume', volume);
  }

  const position  = () => (isOpen() ? { current: lastState.current, duration: lastState.duration } : null);
  const isPlaying = () => isOpen() && lastState.playing;
  const onEnded   = (fn) => { endedHandlers.push(fn); };

  // ─── Équivalents des fonctions de dossier ───────────────────
  //  Le lecteur demande « ai-je de quoi jouer ce morceau ? ». En mode
  //  YouTube la réponse est dans la donnée elle-même : un identifiant
  //  suffit, il n'y a pas de dossier à charger.

  const has     = (ref) => !!ref;
  const missing = () => [];
  const count   = () => Infinity;

  return {
    // contrat commun
    play, skip, stop, duck, unduck, togglePause, setVolume,
    position, isPlaying, onEnded, has, missing, count,
    // propre à ce moteur
    openWindow, isOpen, closeWindow: () => { if (isOpen()) win.close(); win = null; player = null; },
    onNeedWindow: (fn) => { onNeedWindow = fn; },
  };
})();
