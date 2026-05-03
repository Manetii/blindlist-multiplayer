/**
 * ════════════════════════════════════════════════════════════════
 *  PLAYERS — Création et gestion des joueurs côté Host
 * ════════════════════════════════════════════════════════════════
 *
 *  Le Host crée localement les joueurs (pseudo + couleur auto).
 *  Un bouton "Publier les joueurs" envoie au serveur.
 *  Le score est local côté Host et est synchronisé au serveur
 *  lors de l'attribution d'un point (HOST_AWARD_POINT).
 * ════════════════════════════════════════════════════════════════ */

Host.Players = (() => {

  /** Ajoute un joueur depuis l'input. Idempotent sur le pseudo. */
  function addPlayer() {
    const S = Host.State;
    const inp = document.getElementById("inp-player");
    const name = inp.value.trim();
    if (!name || S.players.find((p) => p.name === name)) return;
    S.players.push({
      name,
      color: S.COLORS[S.players.length % S.COLORS.length],
      score: 0,
      connected: false,
    });
    inp.value = "";
    render();
    if (Host.Storage) Host.Storage.autoSave();
  }

  function render() {
    const S = Host.State;
    const el = document.getElementById("players-list");
    if (!S.players.length) {
      el.innerHTML = '<div class="empty">Ajoute des joueurs…</div>';
      return;
    }
    el.innerHTML = S.players
      .map(
        (p, i) => {
          const connClass = p.connected ? 'connected' : 'disconnected';
          const connTitle = p.connected ? 'Connecté' : 'Hors ligne';
          return `
      <div class="player-row">
        <div class="player-dot ${connClass}" style="background:${p.color}" title="${connTitle}"></div>
        <div class="player-name">${SharedUtils.esc(p.name)}</div>
        <button class="btn-score" onclick="Host.Players.changeScore(${i},-1)" title="Retirer un point">−</button>
        <div class="player-score">${p.score}</div>
        <button class="btn-score" onclick="Host.Players.changeScore(${i},1)" title="Ajouter un point">+</button>
        <button class="btn-del-player" onclick="Host.Players.removePlayer(${i})" title="Supprimer">✕</button>
      </div>`;
        }
      )
      .join("");
  }

  function changeScore(idx, delta) {
    const S = Host.State;
    S.players[idx].score = Math.max(0, S.players[idx].score + delta);
    render();
    if (Host.Storage) Host.Storage.autoSave();
  }

  function removePlayer(idx) {
    const S = Host.State;
    S.players.splice(idx, 1);
    render();
    if (Host.Storage) Host.Storage.autoSave();
  }

  /** Reset les scores de tous les joueurs à 0. */
  function resetScores() {
    const S = Host.State;
    if (!S.players.length) return;
    if (!confirm('Remettre tous les scores à 0 ?')) return;
    S.players.forEach(p => { p.score = 0; });
    render();
    if (Host.Storage) Host.Storage.autoSave();
    if (Host.Socket) Host.Socket.resetScores();
  }

  /** Init : branche l'event Enter sur l'input pour valider l'ajout. */
  function init() {
    document.getElementById("inp-player").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addPlayer();
    });
  }

  return { init, addPlayer, render, changeScore, removePlayer, resetScores };
})();
