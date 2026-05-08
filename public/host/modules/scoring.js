/**
 * ════════════════════════════════════════════════════════════════
 *  SCORING — Calcul et validation des points en fin de tour
 * ════════════════════════════════════════════════════════════════
 *
 *  Règles disponibles :
 *    R1 — Trouveur (TOUJOURS actif)
 *         +1 par joueur ayant voté pour le bon owner
 *    R2 — Bluffeur (configurable, par défaut activé)
 *         +1 par joueur "bluffé" : un non-owner reçoit 1 point pour
 *         chaque autre joueur qui a voté pour lui
 *    R3 — Piégeur (configurable, par défaut désactivé)
 *         L'owner gagne +1 par joueur n'ayant pas voté pour lui
 *
 *  Les règles R2/R3 sont contrôlées via Host.Match.getScoringRules().
 *
 *  Workflow :
 *    1. computeProposal(votes, owner)  → renvoie un objet
 *       { "Alice": { points:1, reasons:["A trouvé Bob"] }, ... }
 *    2. renderProposal(proposal)        → affiche le panneau dans le reveal
 *       avec boutons +/- pour ajuster
 *    3. applyScores()                   → envoie au serveur via Socket
 *
 *  Le Host peut modifier manuellement avant de valider.
 * ════════════════════════════════════════════════════════════════ */

Host.Scoring = (() => {

  // Proposition courante — modifiable par le Host avant validation
  let currentProposal = {};   // { pseudo: { points, reasons:[] } }
  let lastVotes  = [];        // gardé pour ré-affichage si besoin
  let lastOwner  = null;

  /** Calcule la répartition des points selon les règles activées. */
  function computeProposal(votes, ownerName) {
    const proposal = {};

    // Init pour tous les joueurs (ils peuvent avoir 0 point)
    Host.State.players.forEach(p => {
      proposal[p.name] = { points: 0, reasons: [] };
    });

    // Récupère les règles de scoring activées
    const rules = (Host.Match && Host.Match.getScoringRules)
      ? Host.Match.getScoringRules()
      : { bluffer: true, confirmation: false };

    // ═══ R1 — Trouveur (toujours actif) ═══
    // Chaque joueur qui a voté pour le bon owner gagne +1
    if (ownerName) {
      votes.forEach(({ voter, voted }) => {
        if (voted === ownerName && proposal[voter]) {
          proposal[voter].points += 1;
          proposal[voter].reasons.push(`A trouvé ${ownerName}`);
        }
      });
    }

    // ═══ R2 — Bluffeur (optionnel) ═══
    // Un non-owner gagne +1 pour CHAQUE joueur qui a voté pour lui
    // (modifié : auparavant +1 fixe si au moins 1 vote, désormais +1 par bluffé)
    // Note : le vote de l'owner lui-même est exclu — il vote "blanc" pour
    // ne pas paraître suspect, son vote ne doit pas générer de points bluffeur.
    if (rules.bluffer) {
      const votesByCandidate = new Map();  // candidate -> count
      votes.forEach(({ voter, voted }) => {
        if (voter === ownerName) return;   // ignorer le vote de l'owner
        votesByCandidate.set(voted, (votesByCandidate.get(voted) || 0) + 1);
      });

      votesByCandidate.forEach((count, candidate) => {
        if (candidate === ownerName) return;    // l'owner n'est pas un bluffeur
        if (!proposal[candidate]) return;        // joueur inconnu
        proposal[candidate].points += count;
        proposal[candidate].reasons.push(
          count === 1
            ? `A bluffé 1 joueur`
            : `A bluffé ${count} joueurs`
        );
      });
    }

    // ═══ R3 — Piégeur (optionnel) ═══
    // L'owner gagne +1 par joueur ayant voté pour quelqu'un d'autre que lui
    if (rules.confirmation && ownerName && proposal[ownerName]) {
      const wrongVoters = votes.filter(v => v.voted !== ownerName).length;
      if (wrongVoters > 0) {
        proposal[ownerName].points += wrongVoters;
        proposal[ownerName].reasons.push(
          wrongVoters === 1
            ? `A piégé 1 joueur (n'a pas voté pour lui)`
            : `A piégé ${wrongVoters} joueurs (n'ont pas voté pour lui)`
        );
      }
    }

    return proposal;
  }

  /** Construit l'affichage détaillé pour le panneau du reveal. */
  function renderProposal(proposal, votes, ownerName) {
    currentProposal = proposal;
    lastVotes = votes;
    lastOwner = ownerName;

    const wrap = document.getElementById('scoring-panel');
    if (!wrap) return;

    // Ligne récap des votes (qui a voté pour qui)
    const votesList = votes.length
      ? votes.map(v => {
          const voterP = Host.State.players.find(p => p.name === v.voter);
          const votedP = Host.State.players.find(p => p.name === v.voted);
          const correct = v.voted === ownerName;
          const cVoter = voterP ? voterP.color : '#5a7080';
          const cVoted = votedP ? votedP.color : '#5a7080';
          return `
            <div class="sc-vote-row ${correct ? 'sc-correct' : 'sc-wrong'}">
              <span class="sc-voter" style="color:${cVoter}">${SharedUtils.esc(v.voter)}</span>
              <span class="sc-arrow">→</span>
              <span class="sc-voted" style="color:${cVoted}">${SharedUtils.esc(v.voted)}</span>
              <span class="sc-mark">${correct ? '✓' : '✗'}</span>
            </div>
          `;
        }).join('')
      : `<div class="sc-empty">Aucun vote ce tour</div>`;

    // Ligne par joueur avec ses points + raisons + boutons +/-
    const rows = Host.State.players.map(p => {
      const entry = proposal[p.name] || { points: 0, reasons: [] };
      const badge = entry.points > 0 ? `+${entry.points}` :
                    entry.points < 0 ? `${entry.points}` : '0';
      const reasons = entry.reasons.length
        ? entry.reasons.map(r => `<span class="sc-reason">${SharedUtils.esc(r)}</span>`).join('')
        : '<span class="sc-reason sc-no-reason">—</span>';
      return `
        <div class="sc-player-row">
          <span class="sc-dot" style="background:${p.color}"></span>
          <span class="sc-name">${SharedUtils.esc(p.name)}</span>
          <div class="sc-reasons">${reasons}</div>
          <div class="sc-controls">
            <button class="sc-adjust" onclick="Host.Scoring.adjust('${SharedUtils.esc(p.name)}',-1)">−</button>
            <span class="sc-points sc-points-${entry.points >= 1 ? 'plus' : (entry.points < 0 ? 'minus' : 'zero')}">${badge}</span>
            <button class="sc-adjust" onclick="Host.Scoring.adjust('${SharedUtils.esc(p.name)}',1)">+</button>
          </div>
        </div>
      `;
    }).join('');

    wrap.innerHTML = `
      <div class="sc-section">
        <div class="sc-section-label">Répartition des votes</div>
        <div class="sc-votes">${votesList}</div>
      </div>
      <div class="sc-section">
        <div class="sc-section-label">Points du tour <span class="sc-hint">(ajustables)</span></div>
        <div class="sc-players">${rows}</div>
      </div>
    `;
    wrap.style.display = 'block';

    // Active le bouton "Valider"
    const validateBtn = document.getElementById('btn-validate-scores');
    if (validateBtn) validateBtn.disabled = false;
  }

  /** Ajustement manuel d'un joueur ±1. */
  function adjust(pseudo, delta) {
    if (!currentProposal[pseudo]) {
      currentProposal[pseudo] = { points: 0, reasons: [] };
    }
    currentProposal[pseudo].points += delta;
    if (delta > 0) {
      currentProposal[pseudo].reasons.push('Ajustement manuel +1');
    } else {
      currentProposal[pseudo].reasons.push('Ajustement manuel −1');
    }
    // Re-render avec la proposition mise à jour
    renderProposal(currentProposal, lastVotes, lastOwner);
  }

  /** Valide et envoie les points au serveur. */
  function applyScores() {
    if (!currentProposal || Object.keys(currentProposal).length === 0) return;

    const points = {};
    Object.entries(currentProposal).forEach(([name, entry]) => {
      if (entry.points !== 0) points[name] = entry.points;

      // Mettre à jour aussi localement (state.players)
      const local = Host.State.players.find(p => p.name === name);
      if (local) local.score = Math.max(0, local.score + entry.points);
    });

    Host.Players.render();

    // Envoie au serveur (qui propagera STATE_SCORES aux joueurs)
    if (Host.Socket) Host.Socket.applyScores(points);

    // Sauvegarde locale
    if (Host.Storage) Host.Storage.autoSave();

    // Reset visuel + ferme le reveal
    reset();
    Host.Reveal.closeAfterScoring();
  }

  /** Annule le scoring sans rien appliquer. Le tour reste actif :
   *  on peut re-cliquer sur "Révéler" et reprendre depuis là. */
  function cancel() {
    reset();
    Host.Reveal.closeWithoutEnding();
  }

  function reset() {
    currentProposal = {};
    lastVotes  = [];
    lastOwner  = null;
    const wrap = document.getElementById('scoring-panel');
    if (wrap) {
      wrap.innerHTML = '';
      wrap.style.display = 'none';
    }
    const btn = document.getElementById('btn-validate-scores');
    if (btn) btn.disabled = true;
  }

  return {
    computeProposal, renderProposal,
    adjust, applyScores, cancel, reset,
  };
})();
