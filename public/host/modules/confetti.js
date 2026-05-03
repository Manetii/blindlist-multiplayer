/**
 * ════════════════════════════════════════════════════════════════
 *  CONFETTI / FIREWORKS — Particules pendant le reveal
 * ════════════════════════════════════════════════════════════════
 *
 *  startConfetti(color) : burst initial + pluie continue
 *  stopConfetti()       : arrête et nettoie le canvas
 *
 *  Mix de confetti (rectangles/cercles) et d'emojis festifs.
 *  La couleur passée est privilégiée pour ~50% des particules,
 *  les autres prennent une couleur aléatoire de la palette.
 * ════════════════════════════════════════════════════════════════ */

Host.Confetti = (() => {

  function spawnParticle(x, y, color) {
    const S = Host.State;
    const type = Math.random() < 0.35 ? "emoji" : "confetti";
    return {
      type, x, y,
      vx: (Math.random() - 0.5) * 8,
      vy: -(Math.random() * 12 + 4),
      gravity: 0.38,
      alpha: 1,
      decay: 0.012 + Math.random() * 0.008,
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 8,
      size: type === "emoji" ? 18 + Math.random() * 22 : 6 + Math.random() * 8,
      color: color || S.COLORS[Math.floor(Math.random() * S.COLORS.length)],
      emoji: S.EMOJIS[Math.floor(Math.random() * S.EMOJIS.length)],
      shape: Math.random() < 0.5 ? "rect" : "circle",
    };
  }

  function burstFirework(canvas, color) {
    const S = Host.State;
    // Burst côté gauche
    const lx = Math.random() * canvas.width * 0.22;
    const ly = Math.random() * canvas.height * 0.5;
    for (let i = 0; i < 18; i++)
      S.confettiList.push(spawnParticle(lx, ly, color));

    // Burst côté droit
    const rx = canvas.width - Math.random() * canvas.width * 0.22;
    const ry = Math.random() * canvas.height * 0.5;
    for (let i = 0; i < 18; i++)
      S.confettiList.push(spawnParticle(rx, ry, color));
  }

  function startConfetti(color) {
    stopConfetti();
    const S      = Host.State;
    const canvas = document.getElementById("confetti-canvas");
    const ctx    = canvas.getContext("2d");
    canvas.classList.add("active");

    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    let frameCount = 0;

    function draw() {
      S.confettiRAF = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      frameCount++;
      // Spawn périodique pour pluie continue
      if (frameCount % 60 === 0) burstFirework(canvas, color);
      // Burst initial double
      if (frameCount === 1) {
        burstFirework(canvas, color);
        burstFirework(canvas, null);
      }

      // Pluie permanente depuis les bords du haut
      if (frameCount % 8 === 0) {
        for (let s = 0; s < 3; s++) {
          const side = Math.random() < 0.5 ? 0 : canvas.width;
          S.confettiList.push({
            ...spawnParticle(side + (Math.random() - 0.5) * 80, -10, null),
            vy: Math.random() * 3 + 1,
            vx: side === 0 ? Math.random() * 4 + 1 : -(Math.random() * 4 + 1),
            gravity: 0.05,
            decay: 0.005,
          });
        }
      }

      S.confettiList = S.confettiList.filter((p) => p.alpha > 0.02);

      for (const p of S.confettiList) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.99;
        p.alpha -= p.decay;
        p.rotation += p.rotSpeed;

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);

        if (p.type === "emoji") {
          ctx.font = `${p.size}px serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(p.emoji, 0, 0);
        } else {
          ctx.fillStyle = p.color;
          if (p.shape === "circle") {
            ctx.beginPath();
            ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          }
        }
        ctx.restore();
      }
    }
    draw();
  }

  function stopConfetti() {
    const S = Host.State;
    if (S.confettiRAF) {
      cancelAnimationFrame(S.confettiRAF);
      S.confettiRAF = null;             // Important : sinon nouveau startConfetti ne fait pas le stop
    }
    S.confettiList = [];                 // Vider les particules (fuite mémoire sinon)

    const canvas = document.getElementById("confetti-canvas");
    if (!canvas) return;
    canvas.classList.remove("active");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { startConfetti, stopConfetti };
})();
