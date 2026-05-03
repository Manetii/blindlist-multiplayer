/**
 * ════════════════════════════════════════════════════════════════
 *  VOTE SCREEN — Sélection puis validation
 * ════════════════════════════════════════════════════════════════
 *
 *  Étapes :
 *   1. Le joueur tape sur une tuile → sélectionnée (visuel pulse)
 *   2. Le bouton "Valider mon vote" devient actif
 *   3. Le joueur peut changer sa sélection avant de valider
 *   4. Validation → le serveur reçoit le vote
 *   5. Après validation, le joueur peut encore changer :
 *      - re-tap sur un autre nom = nouvelle sélection (non encore validée)
 *      - re-tap sur "Valider" = écrase l'ancien vote côté serveur
 *
 *  Tant que le Host n'a pas révélé, le joueur peut modifier.
 * ════════════════════════════════════════════════════════════════ */

const VoteScreen = (() => {
  const gridEl       = document.getElementById('vote-grid');
  const validateBtn  = document.getElementById('vote-validate-btn');
  const statusEl     = document.getElementById('vote-status');

  let selected   = null;  // pseudo sélectionné mais pas encore validé
  let confirmed  = null;  // pseudo dont le vote a été envoyé au serveur

  function render(players, myPseudo) {
    selected  = null;
    confirmed = null;
    updateValidateBtn();
    statusEl.textContent = '';
    statusEl.className   = 'vote-status';

    const others = players.filter(p => p.name !== myPseudo);

    gridEl.innerHTML = others.map((p, i) => {
      const initial = [...p.name][0] || '?';
      return `
        <button class="vote-tile"
                data-pseudo="${SharedUtils.esc(p.name)}"
                style="--c:${p.color}; animation-delay:${i * 50}ms">
          <span class="vote-tile-glow"></span>
          <span class="vote-tile-initial">${SharedUtils.esc(initial.toUpperCase())}</span>
          <span class="vote-tile-name">${SharedUtils.esc(p.name)}</span>
        </button>
      `;
    }).join('');

    gridEl.querySelectorAll('.vote-tile').forEach(btn => {
      btn.addEventListener('click', () => select(btn.dataset.pseudo, btn));
    });
  }

  /** Sélection d'un joueur (provisoire, pas encore validée). */
  function select(pseudo, btn) {
    if (selected === pseudo) {
      // Re-tap sur la même tuile = désélection
      selected = null;
      btn.classList.remove('selected');
    } else {
      // Désélectionner l'ancienne, sélectionner la nouvelle
      gridEl.querySelectorAll('.vote-tile.selected').forEach(t => t.classList.remove('selected'));
      btn.classList.add('selected');
      selected = pseudo;
      if ('vibrate' in navigator) navigator.vibrate(20);
    }
    updateValidateBtn();
    updateStatusForUnsavedChange();
  }

  /** Le joueur a cliqué sur "Valider". On envoie au serveur. */
  function validate() {
    if (!selected) return;
    PlayerSocket.vote(selected);
    confirmed = selected;

    statusEl.innerHTML = `<span class="status-icon">✓</span> Vote envoyé pour <strong>${SharedUtils.esc(selected)}</strong>`;
    statusEl.className = 'vote-status confirmed';

    // Marquer la tuile validée
    gridEl.querySelectorAll('.vote-tile').forEach(t => {
      t.classList.toggle('confirmed', t.dataset.pseudo === confirmed);
    });

    if ('vibrate' in navigator) navigator.vibrate([15, 30, 60]);

    updateValidateBtn();
  }

  /** Au moment du reveal, valide automatiquement la sélection en attente
   *  si l'utilisateur a oublié de cliquer "Valider".
   *  Renvoie le pseudo voté si un vote a été envoyé, sinon null. */
  function flushPendingVote() {
    if (selected && selected !== confirmed) {
      const wasSelected = selected;
      console.log('[vote] Auto-validation au reveal pour', wasSelected);
      validate();
      return wasSelected;
    }
    return null;
  }

  function updateValidateBtn() {
    if (!selected) {
      validateBtn.disabled = true;
      validateBtn.textContent = 'Choisis un joueur';
      return;
    }
    if (selected === confirmed) {
      // Vote déjà validé pour ce joueur, le bouton est inactif
      validateBtn.disabled = true;
      validateBtn.textContent = '✓ Vote envoyé';
      return;
    }
    validateBtn.disabled = false;
    if (confirmed) {
      validateBtn.textContent = `Changer pour ${selected}`;
    } else {
      validateBtn.textContent = `Valider mon vote (${selected})`;
    }
  }

  /** Affiche un avertissement si on a changé de sélection après validation. */
  function updateStatusForUnsavedChange() {
    if (confirmed && selected !== confirmed) {
      statusEl.innerHTML = `<span class="status-icon">!</span> Tu avais voté pour <strong>${SharedUtils.esc(confirmed)}</strong> — clique sur Valider pour changer`;
      statusEl.className = 'vote-status pending';
    } else if (confirmed && selected === confirmed) {
      statusEl.innerHTML = `<span class="status-icon">✓</span> Vote envoyé pour <strong>${SharedUtils.esc(confirmed)}</strong>`;
      statusEl.className = 'vote-status confirmed';
    } else if (!confirmed) {
      statusEl.textContent = '';
      statusEl.className = 'vote-status';
    }
  }

  // ─── Init des handlers du bouton Valider ────────────────────
  function init() {
    if (validateBtn) {
      validateBtn.addEventListener('click', validate);
    }
  }

  return { render, init, validate, flushPendingVote };
})();

window.VoteScreen = VoteScreen;
