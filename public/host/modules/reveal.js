/**
 * ════════════════════════════════════════════════════════════════
 *  REVEAL — Overlay de révélation + intégration scoring
 * ════════════════════════════════════════════════════════════════
 *
 *  open() :
 *    - Affiche la carte avec titre/artiste/joueur
 *    - Saute au moment clé (avec fade)
 *    - Démarre visualizer + confetti
 *    - Pousse le reveal aux joueurs
 *    - Calcule la proposition de scoring et l'affiche
 *
 *  Le bouton "+1 Point" historique est remplacé par :
 *    - "Valider les points"  (applique la proposition + ajustements manuels)
 *    - "Annuler"             (ferme sans rien attribuer)
 * ════════════════════════════════════════════════════════════════ */

Host.Reveal = (() => {

  let isOpen = false;

  function open() {
    const S = Host.State;
    if (S.currentIdx === -1) return;
    Host.AudioEngine.ensureAudioCtx();

    const t = S.tracks[S.currentIdx];
    const p = S.players.find((pl) => pl.name === t.player);
    const color = p ? p.color : "#00e5ff";

    document.getElementById("rc-title").textContent  = t.title  || "—";
    document.getElementById("rc-artist").textContent = t.artist || "Artiste inconnu";

    // Pochette
    const artZone     = document.getElementById("reveal-art-zone");
    const placeholder = document.getElementById("reveal-art-placeholder");
    const oldImg = artZone.querySelector("img.reveal-art");
    if (oldImg) oldImg.remove();

    if (t.art) {
      placeholder.style.display = "none";
      const img = document.createElement("img");
      img.className = "reveal-art";
      img.src = t.art;
      img.alt = "Pochette";
      artZone.insertBefore(img, placeholder);
    } else {
      placeholder.style.display = "flex";
    }

    // Joueur (pastille colorée)
    const dot  = document.getElementById("rc-dot");
    const name = document.getElementById("rc-player");
    if (p) {
      name.textContent = p.name;
      name.style.color = color;
      dot.style.background = color;
      dot.style.setProperty("--rc-color", color);
      document.getElementById("reveal-card").style.setProperty("--rc-color", color);
    } else {
      name.textContent = "— Aucun joueur défini —";
      name.style.color = "#5a7080";
      dot.style.background = "#5a7080";
      document.getElementById("reveal-card").style.setProperty("--rc-color", "#5a7080");
    }

    // Ouvre l'overlay
    document.getElementById("overlay").classList.add("open");
    isOpen = true;

    // Pousse le reveal aux joueurs.
    // ⚠ On envoie t.artDataUrl (base64) et pas t.art (blob URL local du
    //   Host, invalide pour les autres navigateurs).
    if (Host.Socket) {
      Host.Socket.reveal({
        title:  t.title  || "",
        artist: t.artist || "",
        player: t.player || "",
        art:    t.artDataUrl || null,
      });
    }

    // Calcule et affiche la proposition de scoring.
    // ⚠ Petit délai (350ms) pour laisser arriver les votes auto-validés
    // qui ont été envoyés juste après le STATE_REVEAL côté joueur.
    setTimeout(() => {
      if (Host.Scoring && Host.Socket && isOpen) {
        const votes = Array.from(Host.Socket.getCurrentVotes().entries())
          .map(([voter, voted]) => ({ voter, voted }));
        const proposal = Host.Scoring.computeProposal(votes, t.player || null);
        Host.Scoring.renderProposal(proposal, votes, t.player || null);
      }
    }, 350);

    // Saute au moment clé puis lance visualizer + confetti
    // (sauf si l'option "Aller au moment clé au reveal" est désactivée — auquel cas
    // la musique continue depuis sa position actuelle).
    const shouldJump = (t.keyMoment !== null)
                    && (!Host.Match || Host.Match.getJumpToKeyMomentOnReveal());
    if (shouldJump) {
      Host.Controls.jumpToKeyMoment(true);
      setTimeout(() => {
        Host.Visualizer.startVisualizer(color);
      }, 500);
    } else {
      if (S.audio.paused) S.audio.play().catch(() => {});
      setTimeout(() => {
        Host.Visualizer.startVisualizer(color);
      }, 300);
    }
  }

  /** Ferme l'overlay (déclenché par "Annuler" ou clic sur le fond).
   *  Ferme juste l'écran de reveal SANS valider les scores ni terminer le tour.
   *  Le tour reste donc actif (le bouton "Révéler" reste disponible). */
  function close(e) {
    // Si appelé depuis un onclick sur l'overlay, ne fermer que si clic exact sur le fond
    if (e && e.target !== document.getElementById("overlay")) return;
    if (!isOpen) return;
    Host.Scoring.cancel();   // cancel appelle closeWithoutEnding()
  }

  /** Fermeture sans terminer le tour : juste cacher l'overlay et arrêter
   *  les animations. Utilisé quand on annule le reveal sans valider. */
  function closeWithoutEnding() {
    if (!isOpen) return;
    isOpen = false;
    document.getElementById("overlay").classList.remove("open");
    Host.Visualizer.stopVisualizer();
    // ⚠ On NE marque PAS le morceau comme joué
    // ⚠ On NE termine PAS le tour côté Match (le tour reste actif)
    // ⚠ On NE reset PAS la manche côté serveur (les joueurs gardent leur écran de vote)
    // → Le bouton "Révéler" reste disponible, le tour reste en cours
  }

  /** Fermeture avec validation des scores : termine le tour proprement.
   *  Utilisé après applyScores(). */
  function closeAfterScoring() {
    if (!isOpen) return;
    isOpen = false;
    document.getElementById("overlay").classList.remove("open");
    Host.Visualizer.stopVisualizer();

    // Marque le morceau comme joué
    Host.Game.markCurrentAsPlayed();

    // Marque la fin du tour côté Match (réactive le bouton "Lancer un nouveau tour")
    if (Host.Match) Host.Match.markRoundEnded();

    // Reset de la manche pour les joueurs
    if (Host.Socket) Host.Socket.nextRound();

    // Note : on NE remet PAS le lecteur en "En attente" entre les tours.
    // Le morceau qui vient d'être révélé reste affiché jusqu'au prochain
    // "Lancer un nouveau tour" qui le remplacera.
  }

  return { open, close, closeAfterScoring, closeWithoutEnding };
})();
