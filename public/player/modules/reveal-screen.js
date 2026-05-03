/**
 * ════════════════════════════════════════════════════════════════
 *  REVEAL SCREEN — Résultat de la manche
 * ════════════════════════════════════════════════════════════════
 *
 *  Le serveur envoie l'événement state:reveal avec :
 *    { answer: { title, artist, player, art }, votes: [...] }
 *
 *  L'écran affiche :
 *    - Le titre + artiste
 *    - Qui a vraiment ajouté ce morceau (avec sa couleur)
 *    - Si le joueur courant avait juste ou pas (ligne perso)
 * ════════════════════════════════════════════════════════════════
 */

const RevealScreen = (() => {
  const titleEl   = document.getElementById('reveal-title');
  const artistEl  = document.getElementById('reveal-artist');
  const playerEl  = document.getElementById('reveal-player');
  const playerDotEl = document.getElementById('reveal-player-dot');
  const verdictEl = document.getElementById('reveal-verdict');
  const artEl     = document.getElementById('reveal-art');
  const artPlaceholderEl = document.getElementById('reveal-art-placeholder');

  function render({ answer, votes }, myPseudo) {
    titleEl.textContent  = answer.title  || '—';
    artistEl.textContent = answer.artist || 'Artiste inconnu';

    // Joueur qui avait choisi le morceau
    const realPlayer = answer.player || '— inconnu —';
    playerEl.textContent = realPlayer;

    // Couleur reprise depuis l'état partagé (le joueur a déjà la liste)
    const allPlayers = GameState.getPlayers();
    const realP = allPlayers.find(p => p.name === realPlayer);
    const color = realP ? realP.color : '#00e5ff';
    playerEl.style.color = color;
    playerDotEl.style.background = color;
    playerDotEl.style.boxShadow  = `0 0 16px ${color}`;

    // Verdict perso : on regarde 3 choses
    //   1. Ai-je voté pour le bon ? → Trouveur (+1 implicite)
    //   2. Quelqu'un a-t-il voté pour MOI alors que ce n'est pas mon morceau ? → Bluffeur
    //   3. Sinon → Raté
    const myVote = (votes || []).find(v => v.voter === myPseudo);
    const trouveur = myVote && myVote.voted === realPlayer;
    const bluffeur = realPlayer !== myPseudo
                  && (votes || []).some(v => v.voted === myPseudo);

    if (trouveur && bluffeur) {
      verdictEl.className = 'reveal-verdict correct';
      verdictEl.innerHTML = '<span class="verdict-icon">★</span> Combo : trouvé + tu as bluffé !';
    } else if (trouveur) {
      verdictEl.className = 'reveal-verdict correct';
      verdictEl.innerHTML = '<span class="verdict-icon">✓</span> Bien joué, tu as trouvé !';
    } else if (bluffeur) {
      verdictEl.className = 'reveal-verdict bluff';
      verdictEl.innerHTML = '<span class="verdict-icon">★</span> Tu as bluffé un autre joueur !';
    } else if (!myVote) {
      verdictEl.className = 'reveal-verdict skipped';
      verdictEl.innerHTML = '<span class="verdict-icon">−</span> Tu n\'as pas voté';
    } else if (realPlayer === myPseudo) {
      verdictEl.className = 'reveal-verdict skipped';
      verdictEl.innerHTML = '<span class="verdict-icon">♪</span> C\'était ton morceau';
    } else {
      verdictEl.className = 'reveal-verdict wrong';
      verdictEl.innerHTML = `<span class="verdict-icon">✗</span> Tu avais voté ${SharedUtils.esc(myVote.voted)}`;
    }

    // Pochette
    if (answer.art) {
      artEl.src = answer.art;
      artEl.style.display = 'block';
      artPlaceholderEl.style.display = 'none';
    } else {
      artEl.style.display = 'none';
      artPlaceholderEl.style.display = 'flex';
    }
  }

  return { render };
})();

window.RevealScreen = RevealScreen;
