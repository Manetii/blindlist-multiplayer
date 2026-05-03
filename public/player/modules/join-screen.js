/**
 * ════════════════════════════════════════════════════════════════
 *  JOIN SCREEN — Sélection du pseudo
 * ════════════════════════════════════════════════════════════════
 *
 *  Affiche la liste des joueurs créés par le Host. Le joueur
 *  tape sur son pseudo pour rejoindre la partie.
 *
 *  Si la liste est vide, affiche un message d'attente.
 *  Si un joueur est déjà connecté ailleurs, on l'indique.
 * ════════════════════════════════════════════════════════════════
 */

const JoinScreen = (() => {
  const listEl   = document.getElementById('join-list');
  const errorEl  = document.getElementById('join-error');
  const emptyEl  = document.getElementById('join-empty');

  let availablePlayers = [];

  function render(players) {
    availablePlayers = players;
    errorEl.textContent = '';

    if (!players.length) {
      emptyEl.style.display = 'block';
      listEl.innerHTML = '';
      return;
    }
    emptyEl.style.display = 'none';

    listEl.innerHTML = players.map((p, i) => {
      const taken = p.connected;
      return `
        <button class="join-tile ${taken ? 'taken' : ''}"
                data-pseudo="${SharedUtils.esc(p.name)}"
                style="--c:${p.color}"
                ${taken ? 'disabled' : ''}>
          <span class="join-tile-dot"></span>
          <span class="join-tile-name">${SharedUtils.esc(p.name)}</span>
          ${taken ? '<span class="join-tile-tag">connecté</span>' : ''}
        </button>
      `;
    }).join('');

    listEl.querySelectorAll('.join-tile:not(.taken)').forEach(btn => {
      btn.addEventListener('click', () => {
        const pseudo = btn.dataset.pseudo;
        select(pseudo, btn);
      });
    });
  }

  async function select(pseudo, btn) {
    btn.classList.add('selecting');
    errorEl.textContent = '';
    errorEl.classList.remove('shake');

    const result = await PlayerSocket.join(pseudo);

    if (!result.ok) {
      btn.classList.remove('selecting');
      errorEl.textContent = result.error || 'Erreur inconnue';
      // Animation d'attention
      errorEl.classList.add('shake');
      setTimeout(() => errorEl.classList.remove('shake'), 600);
      return;
    }

    // Succès → la suite est gérée par app.js qui écoute les events
    PlayerHeader.setPseudo(pseudo, getColor(pseudo));
    GameState.applyFullState(result.state);

    // Si on rejoint pendant qu'un tour est déjà commencé (et pas encore reveal),
    // on est "late joiner" : on reste en attente jusqu'au prochain tour.
    const r = result.state && result.state.round;
    if (r && r.active && !r.revealed) {
      GameState.markLateJoiner();
    }

    GameState.routeToCorrectScreen();
  }

  function getColor(pseudo) {
    const p = availablePlayers.find(x => x.name === pseudo);
    return p ? p.color : '#00e5ff';
  }

  return { render, getColor };
})();

window.JoinScreen = JoinScreen;
