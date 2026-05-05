/**
 * ════════════════════════════════════════════════════════════════
 *  VISUALIZER — Bandeau de barres FFT en bas d'écran (reveal only)
 * ════════════════════════════════════════════════════════════════
 *
 *  Optimisations :
 *    - Une seule boucle sur les bins
 *    - Pas de gradient recréé à chaque barre
 *    - Amplification adaptative : la moyenne des 60 dernières frames
 *      sert de référence, ce qui rend les barres expressives même
 *      sur des morceaux peu compressés.
 *
 *  Réglages perception (mai 2025) :
 *    - Pondération bandes appliquée AUSSI à l'affichage (pas juste au
 *      calcul du gain). Les basses sont compressées (sinon elles
 *      saturent en permanence au plafond), les hautes sont boostées
 *      (sinon elles restent invisibles en bas du canvas).
 *    - Courbe perceptuelle plus douce (puissance 0.65 au lieu de sqrt
 *      0.5) pour étendre la dynamique visible sans tout pousser en haut.
 *
 *  startVisualizer(color) : démarre l'animation
 *  stopVisualizer()       : arrête et nettoie
 * ════════════════════════════════════════════════════════════════ */

Host.Visualizer = (() => {

  const BAR_COUNT  = 80;
  const HISTORY    = 60;     // frames pour la moyenne mobile (≈1s à 60fps)
  const MIN_GAIN   = 1.0;
  const MAX_GAIN   = 2.5;
  const TARGET     = 0.55;   // hauteur cible moyenne (55% du canvas)

  /**
   * Pondération par bande utilisée pour DEUX choses :
   *   1. Calcul du gain adaptatif : éviter que les basses (toujours
   *      très énergétiques en FFT brute) ne tirent toute la moyenne.
   *   2. Compression à l'affichage : les basses sont multipliées par
   *      < 1 (sinon elles saturent en permanence au plafond), les
   *      hautes par > 1 (sinon elles restent écrasées en bas).
   *
   * Compromis : on veut voir bouger les barres sur tout le spectre
   * sans clipper. Ces valeurs sont arrivées par tâtonnement sur
   * différents morceaux (rock, électro, classique).
   */
  function bandWeight(barIndex) {
    if (barIndex < 6)  return 0.35;   // sub-bass : très compressé
    if (barIndex < 14) return 0.55;   // bass : compressé
    if (barIndex < 24) return 0.80;   // low-mid : léger
    if (barIndex < 45) return 1.00;   // mid : référence
    if (barIndex < 60) return 1.15;   // high-mid : léger boost
    return 1.30;                      // high : boost franc
  }

  let history = [];

  function startVisualizer(color) {
    stopVisualizer();
    const S = Host.State;
    if (!S.analyser) return;
    S.currentVizColor = color || "#00e5ff";
    history = [];

    const canvas = document.getElementById("viz-canvas");
    const ctx2   = canvas.getContext("2d");
    const data   = new Uint8Array(S.analyser.frequencyBinCount);
    canvas.classList.add("active");

    // Parse couleur une seule fois
    const r = parseInt(S.currentVizColor.slice(1, 3), 16);
    const g = parseInt(S.currentVizColor.slice(3, 5), 16);
    const b = parseInt(S.currentVizColor.slice(5, 7), 16);

    const colorTop = `rgba(${r},${g},${b},0.95)`;
    const colorBot = `rgba(${r},${g},${b},0.35)`;

    // Pré-calcule les poids par barre (constant pendant l'animation)
    const weights = new Float32Array(BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i++) weights[i] = bandWeight(i);

    function draw() {
      S.vizRAF = requestAnimationFrame(draw);
      S.analyser.getByteFrequencyData(data);

      const W = window.innerWidth;
      const H = 120;
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width  = W;
        canvas.height = H;
      }

      ctx2.clearRect(0, 0, W, H);

      const barW = W / BAR_COUNT;
      const step = Math.floor(data.length / BAR_COUNT);

      // ─── Calcul des amplitudes brutes par barre ─────────────
      const bars = new Float32Array(BAR_COUNT);
      let weightedSum = 0;
      let weightTotal = 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        const base = i * step;
        for (let j = 0; j < step; j++) sum += data[base + j];
        const avg = sum / step;          // 0..255
        bars[i] = avg;

        // Loudness moyenne pondérée (basses moins comptées)
        const w = weights[i];
        weightedSum += (avg / 255) * w;
        weightTotal += w;
      }
      const meanThisFrame = weightedSum / weightTotal;

      // ─── Amplification adaptative ────────────────────────────
      history.push(meanThisFrame);
      if (history.length > HISTORY) history.shift();

      let avgRecent = 0;
      for (let i = 0; i < history.length; i++) avgRecent += history[i];
      avgRecent /= history.length;

      let gain = avgRecent > 0.001 ? TARGET / avgRecent : MIN_GAIN;
      if (gain < MIN_GAIN) gain = MIN_GAIN;
      if (gain > MAX_GAIN) gain = MAX_GAIN;

      // ─── Dessin des barres ───────────────────────────────────
      const grad = ctx2.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, colorTop);
      grad.addColorStop(1, colorBot);
      ctx2.fillStyle = grad;

      for (let i = 0; i < BAR_COUNT; i++) {
        // 1. Normaliser et appliquer le gain global
        // 2. Multiplier par le poids de bande (compresse basses, booste hautes)
        // 3. Courbe perceptuelle douce (puissance 0.65) pour éviter d'écraser
        //    les amplitudes intermédiaires
        let norm = (bars[i] / 255) * gain * weights[i];
        if (norm > 1) norm = 1;
        const perceptual = Math.pow(norm, 0.65);
        const barH = perceptual * H * 0.95;

        const x  = i * barW;
        const bx = x + barW * 0.12;
        const bw = barW * 0.76;
        const by = H - barH;
        const rx = Math.min(bw * 0.5, 3);

        ctx2.beginPath();
        if (barH > rx * 2) {
          ctx2.moveTo(bx + rx, by);
          ctx2.lineTo(bx + bw - rx, by);
          ctx2.quadraticCurveTo(bx + bw, by, bx + bw, by + rx);
          ctx2.lineTo(bx + bw, H);
          ctx2.lineTo(bx, H);
          ctx2.lineTo(bx, by + rx);
          ctx2.quadraticCurveTo(bx, by, bx + rx, by);
        } else if (barH > 0.5) {
          ctx2.rect(bx, by, bw, barH);
        }
        ctx2.closePath();
        ctx2.fill();
      }
    }
    draw();
  }

  function stopVisualizer() {
    const S = Host.State;
    if (S.vizRAF) {
      cancelAnimationFrame(S.vizRAF);
      S.vizRAF = null;
    }
    history = [];
    const canvas = document.getElementById("viz-canvas");
    if (canvas) {
      canvas.classList.remove("active");
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }
    const card = document.getElementById("reveal-card");
    if (card) {
      card.style.transform = "";
      card.style.boxShadow = "";
    }
  }

  return { startVisualizer, stopVisualizer };
})();
