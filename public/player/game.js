/**
 * ════════════════════════════════════════════════════════════════
 *  JOUEUR — phase de jeu
 * ════════════════════════════════════════════════════════════════
 *
 *  PORTAGE DES ÉCRANS V1. Le balisage, les styles et la mécanique de
 *  vote (sélection provisoire → validation → possibilité de changer)
 *  sont repris tels quels du jeu d'origine. Trois changements
 *  seulement, tous imposés par l'architecture v2 :
 *
 *    1. L'identité est un participantId, plus un pseudo. Les tuiles
 *       portent data-id ; le pseudo n'est qu'un libellé. Renommer
 *       devient gratuit et la reconnexion cesse d'être un cas
 *       particulier.
 *
 *    2. La grille vient du SERVEUR (voteOptions) au lieu d'être
 *       filtrée localement : elle exclut aussi les participants sans
 *       morceau, qui ne peuvent pas être la bonne réponse.
 *
 *    3. Un bouton « prêt » s'ajoute à l'écran d'attente. C'est lui qui
 *       déclenche la manche suivante — le téléphone donne le rythme,
 *       le PC exécute.
 *
 *  L'auto-validation au reveal est conservée : un joueur qui a choisi
 *  sans valider ne doit pas perdre son vote.
 * ════════════════════════════════════════════════════════════════
 */

window.PlayerGame = (() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };

  let socket = null;
  const g = {
    me: null,            // { id, name, color }
    players: [],
    options: [],
    selected: null,      // choisi, pas encore validé
    confirmed: null,     // vote envoyé au serveur
    ready: false,
  };

  const banner = { selfOffline: false, hostOffline: false };

  function renderBanner() {
    const el = $('#connection-banner');
    if (!el) return;
    const msg = banner.selfOffline ? 'Connexion perdue · reconnexion en cours…'
              : banner.hostOffline ? 'L\'hôte s\'est déconnecté…'
              : null;
    if (msg) $('#cb-text').textContent = msg;
    el.classList.toggle('visible', !!msg);
  }

  // ─── Connexion ──────────────────────────────────────────────

  function enter(token, me) {
    g.me = me;
    PlayerHeader.setPseudo(me.name, me.color);

    if (socket) { join(token); return; }
    socket = io();
    wire();
    socket.on('connect', () => { banner.selfOffline = false; renderBanner(); join(token); });
    socket.on('disconnect', () => { banner.selfOffline = true; renderBanner(); });
  }

  function join(token) {
    socket.emit(EVENTS.PLAYER_JOIN, { token }, (res) => {
      if (!res || !res.ok) {
        // Salon pas encore ouvert : le résolveur décidera où atterrir.
        if (res && res.noRoom) window.PlayerApp.reresolve();
        return;
      }
      g.me = res.me;
      g.players = res.state.players;
      g.options = res.options || [];
      g.confirmed = res.myVote || null;
      g.selected = res.myVote || null;
      g.ready = !!res.ready;

      PlayerHeader.setPseudo(g.me.name, g.me.color);
      syncScore();
      banner.hostOffline = !res.hostOnline;
      renderBanner();
      route(res.state);
    });
  }

  function route(st) {
    if (st.round && st.round.revealed) { renderReveal(st.round); return; }
    if (st.round && st.round.active)   { renderVote(); return; }
    renderWaiting();
  }

  function syncScore() {
    const me = g.players.find(p => p.id === (g.me || {}).id);
    if (me) PlayerHeader.setScore(me.score);
  }

  function wire() {
    socket.on(EVENTS.STATE_PLAYERS, (players) => {
      g.players = players;
      const me = players.find(p => p.id === (g.me || {}).id);
      if (me) g.ready = me.ready;
    });

    socket.on(EVENTS.STATE_SCORES, (players) => { g.players = players; syncScore(); });

    socket.on(EVENTS.STATE_ROUND_START, ({ options }) => {
      g.options = options || g.options;
      g.ready = false;              // nouvelle manche : plus personne n'est prêt
      countdown('#countdown', '#cd-num', 0);
      countdown('#reveal-countdown', '#reveal-cd-num', 0);
      renderVote();
      if ('vibrate' in navigator) navigator.vibrate([20, 60, 20]);
    });

    socket.on(EVENTS.STATE_REVEAL, (round) => {
      // Auto-validation : une sélection non validée ne doit pas être
      // perdue parce que le joueur a hésité une seconde de trop.
      const auto = flushPendingVote();

      // Le serveur ne connaît pas encore ce vote au moment où il envoie
      // le reveal. On l'injecte localement pour que le verdict soit
      // juste tout de suite ; la rediffusion du serveur confirmera.
      if (auto && g.me && !(round.votes || []).some(v => v.voterId === g.me.id)) {
        round = {
          ...round,
          votes: [...(round.votes || []),
                  { voterId: g.me.id, votedId: auto, voter: g.me.name, voted: nameOf(auto) }],
        };
      }
      renderReveal(round);
      if ('vibrate' in navigator) navigator.vibrate(40);
    });

    socket.on(EVENTS.STATE_INTERMISSION, () => {
      // On NE bascule PAS vers l'écran d'attente si le joueur est déjà
      // sur la révélation : le bouton « prêt » y est, et l'envoyer sur
      // un second écran identique ferait doublon. Il reste devant la
      // réponse, le décompte se met à jour sous ses yeux.
      if (window.PlayerApp.current() === 'reveal') { updateReadyBtn(); return; }
      countdown('#reveal-countdown', '#reveal-cd-num', 0);
      renderWaiting();
    });

    socket.on(EVENTS.STATE_READY_PROGRESS, (t) => {
      // Le décompte n'est plus affiché côté joueur : nommer les
      // retardataires est le travail de l'écran que la salle regarde,
      // et le voir aussi sur son téléphone transformait l'attente en
      // pression. Seul l'état du bouton reste synchronisé.
      const me = t.pendingIds ? !t.pendingIds.includes((g.me || {}).id) : g.ready;
      g.ready = me;
      updateReadyBtn();
    });

    // Le décompte s'affiche sur LES DEUX écrans où l'on peut être prêt.
    // Après la première manche, les joueurs restent sur la révélation :
    // n'animer que l'écran d'attente laissait un silence de trois
    // secondes qui ressemblait à un blocage.
    socket.on(EVENTS.STATE_COUNTDOWN, ({ seconds }) => {
      countdown('#countdown', '#cd-num', seconds);
      countdown('#reveal-countdown', '#reveal-cd-num', seconds);
    });

    socket.on(EVENTS.STATE_PAUSED, ({ paused }) => {
      $('#waiting-title').textContent = paused ? 'Pause' : 'En attente';
      $('#waiting-sub').textContent = paused
        ? 'L\'hôte a mis la partie en pause.'
        : 'Le prochain morceau démarre quand tout le monde est prêt.';
      $('#ready-btn').style.display = paused ? 'none' : '';
    });

    socket.on(EVENTS.STATE_HOST_STATUS, ({ online }) => {
      banner.hostOffline = !online; renderBanner();
    });

    /*
     * Filet : tout signe de vie lève le bandeau.
     *
     * Le retour de l'hôte est annoncé par un seul message. S'il se perd
     * — un joueur qui rejoint pile entre l'émission et son entrée dans
     * le salon, une reconnexion socket au mauvais moment — le bandeau
     * reste affiché pour le reste de la soirée alors que tout
     * fonctionne. Or n'importe quel autre message venant du salon
     * prouve qu'un hôte est là : une manche ne démarre pas toute seule.
     */
    socket.onAny((event) => {
      if (event === EVENTS.STATE_HOST_STATUS) return;   // lui seul peut l'allumer
      if (!banner.hostOffline) return;
      banner.hostOffline = false;
      renderBanner();
    });

    socket.on(EVENTS.STATE_GAME_OVER, ({ standings }) => renderPodium(standings));
    socket.on(EVENTS.STATE_ROOM_CLOSED, () => window.PlayerApp.reresolve());
  }

  /** Anime un décompte, ou le masque si seconds est nul. */
  function countdown(boxSel, numSel, seconds) {
    const el = $(boxSel);
    if (!el) return;
    clearInterval(el._t);
    if (!seconds) { el.classList.add('hidden'); return; }

    let n = seconds;
    el.classList.remove('hidden');
    $(numSel).textContent = n;
    el._t = setInterval(() => {
      if (--n <= 0) { clearInterval(el._t); el.classList.add('hidden'); return; }
      $(numSel).textContent = n;
      // Le rebond redémarre à chaque chiffre : le mouvement dit que
      // quelque chose avance, même sans regarder le nombre.
      el.classList.remove('waiting-countdown'); void el.offsetWidth;
      el.classList.add('waiting-countdown');
    }, 1000);
  }

  // ─── WAITING / entracte ─────────────────────────────────────

  function renderWaiting() {
    $('#waiting-title').textContent = 'En attente';
    $('#waiting-sub').textContent = 'Le prochain morceau démarre quand tout le monde est prêt.';
    $('#countdown').classList.add('hidden');
    updateReadyBtn();
    window.PlayerApp.show('waiting');
  }

  /** Les deux boutons « prêt » (attente et révélation) restent alignés. */
  function updateReadyBtn() {
    [['#ready-btn', 'Je suis prêt'], ['#reveal-ready-btn', 'Je suis prêt pour la suite']]
      .forEach(([sel, label]) => {
        const b = $(sel);
        if (!b) return;
        b.textContent = g.ready ? '✓ Prêt — annuler' : label;
        b.classList.toggle('is-ready', g.ready);
        b.disabled = false;
        b.style.display = '';
      });
  }

  function toggleReady() {
    g.ready = !g.ready;
    updateReadyBtn();
    socket.emit(EVENTS.PLAYER_READY, { ready: g.ready });
    if ('vibrate' in navigator) navigator.vibrate(15);
  }

  // ─── VOTE — mécanique reprise de la v1 ──────────────────────

  function renderVote() {
    g.selected = null;
    g.confirmed = null;
    $('#vote-status').textContent = '';
    $('#vote-status').className = 'vote-status';

    $('#vote-grid').innerHTML = g.options.map((o, i) => {
      const initial = [...o.name][0] || '?';
      return `
        <button class="vote-tile" data-id="${esc(o.id)}"
                style="--c:${esc(o.color)}; animation-delay:${i * 50}ms">
          <span class="vote-tile-glow"></span>
          <span class="vote-tile-initial">${esc(initial.toUpperCase())}</span>
          <span class="vote-tile-name">${esc(o.name)}</span>
        </button>`;
    }).join('');

    $('#vote-grid').querySelectorAll('.vote-tile').forEach(btn => {
      btn.addEventListener('click', () => select(btn.dataset.id, btn));
    });

    updateValidateBtn();
    window.PlayerApp.show('vote');
  }

  /** Sélection provisoire. Re-taper la même tuile la désélectionne. */
  function select(id, btn) {
    const grid = $('#vote-grid');
    if (g.selected === id) {
      g.selected = null;
      btn.classList.remove('selected');
    } else {
      grid.querySelectorAll('.vote-tile.selected').forEach(t => t.classList.remove('selected'));
      btn.classList.add('selected');
      g.selected = id;
      if ('vibrate' in navigator) navigator.vibrate(20);
    }
    updateValidateBtn();
    updateStatus();
  }

  function validate() {
    if (!g.selected) return;
    socket.emit(EVENTS.PLAYER_VOTE, { votedId: g.selected }, (res) => {
      if (!res || !res.ok) {
        $('#vote-status').innerHTML = `<span class="status-icon">!</span> ${esc((res && res.reason) || 'Vote refusé')}`;
        $('#vote-status').className = 'vote-status pending';
        return;
      }
      g.confirmed = g.selected;
      $('#vote-status').innerHTML =
        `<span class="status-icon">✓</span> Vote envoyé pour <strong>${esc(nameOf(g.confirmed))}</strong>`;
      $('#vote-status').className = 'vote-status confirmed';
      $('#vote-grid').querySelectorAll('.vote-tile').forEach(t => {
        t.classList.toggle('confirmed', t.dataset.id === g.confirmed);
      });
      if ('vibrate' in navigator) navigator.vibrate([15, 30, 60]);
      updateValidateBtn();
    });
  }

  /**
   * Valide une sélection en attente au moment du reveal.
   * @returns {string|null} l'identifiant voté, pour affichage immédiat
   */
  function flushPendingVote() {
    if (!g.selected || g.selected === g.confirmed) return null;
    const id = g.selected;
    validate();
    return id;
  }

  function updateValidateBtn() {
    const b = $('#vote-validate-btn');
    if (!g.selected) { b.disabled = true; b.textContent = 'Choisis un joueur'; return; }
    if (g.selected === g.confirmed) { b.disabled = true; b.textContent = '✓ Vote envoyé'; return; }
    b.disabled = false;
    b.textContent = g.confirmed
      ? `Changer pour ${nameOf(g.selected)}`
      : `Valider mon vote (${nameOf(g.selected)})`;
  }

  function updateStatus() {
    const el = $('#vote-status');
    if (g.confirmed && g.selected !== g.confirmed) {
      el.innerHTML = `<span class="status-icon">!</span> Tu avais voté pour <strong>${esc(nameOf(g.confirmed))}</strong> — clique sur Valider pour changer`;
      el.className = 'vote-status pending';
    } else if (g.confirmed) {
      el.innerHTML = `<span class="status-icon">✓</span> Vote envoyé pour <strong>${esc(nameOf(g.confirmed))}</strong>`;
      el.className = 'vote-status confirmed';
    } else {
      el.textContent = '';
      el.className = 'vote-status';
    }
  }

  const nameOf = (id) => {
    const o = g.options.find(x => x.id === id) || g.players.find(x => x.id === id);
    return o ? o.name : '?';
  };

  // ─── REVEAL — verdict repris de la v1 ───────────────────────

  function renderReveal({ answer, votes }) {
    const a = answer || {};
    votes = votes || [];

    $('#reveal-title').textContent  = a.title || '—';
    $('#reveal-artist').textContent = a.artist || 'Artiste inconnu';
    $('#reveal-player').textContent = a.player || '— inconnu —';

    const color = a.color || '#00e5ff';
    $('#reveal-player').style.color = color;
    $('#reveal-player-dot').style.background = color;
    $('#reveal-player-dot').style.boxShadow = `0 0 16px ${color}`;

    const myId = (g.me || {}).id;
    const myVote   = votes.find(v => v.voterId === myId);
    const trouveur = myVote && myVote.votedId === a.playerId;
    const bluffeur = a.playerId !== myId && votes.some(v => v.votedId === myId);

    const el = $('#reveal-verdict');
    if (trouveur && bluffeur) {
      el.className = 'reveal-verdict correct';
      el.innerHTML = '<span class="verdict-icon">★</span> Combo : trouvé + tu as bluffé !';
    } else if (trouveur) {
      el.className = 'reveal-verdict correct';
      el.innerHTML = '<span class="verdict-icon">✓</span> Bien joué, tu as trouvé !';
    } else if (bluffeur) {
      el.className = 'reveal-verdict bluff';
      el.innerHTML = '<span class="verdict-icon">★</span> Tu as bluffé un autre joueur !';
    } else if (!myVote) {
      el.className = 'reveal-verdict skipped';
      el.innerHTML = '<span class="verdict-icon">−</span> Tu n\'as pas voté';
    } else if (a.playerId === myId) {
      el.className = 'reveal-verdict skipped';
      el.innerHTML = '<span class="verdict-icon">♪</span> C\'était ton morceau';
    } else {
      el.className = 'reveal-verdict wrong';
      el.innerHTML = `<span class="verdict-icon">✗</span> Tu avais voté ${esc(myVote.voted)}`;
    }

    const art = $('#reveal-art');
    const ph  = $('#reveal-art-placeholder');
    if (a.artworkUrl) {
      art.src = a.artworkUrl;
      art.style.display = 'block';
      ph.style.display = 'none';
    } else {
      art.style.display = 'none';
      ph.style.display = 'flex';
    }

    updateReadyBtn();
    window.PlayerApp.show('reveal');
  }

  // ─── PODIUM ─────────────────────────────────────────────────

  function renderPodium(standings) {
    $('#podium-list').innerHTML = (standings || []).map((s, i) => `
      <div class="standing" style="--c:${esc(s.color)}">
        <span class="rank">${i + 1}</span>
        <span>${esc(s.display_name)}</span>
        <span class="pts">${s.score}</span>
      </div>`).join('');
    window.PlayerApp.show('podium');
  }

  // ─── Amorçage ───────────────────────────────────────────────

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const v = $('#vote-validate-btn');
    if (v) v.addEventListener('click', validate);
    ['#ready-btn', '#reveal-ready-btn'].forEach(sel => {
      const b = $(sel);
      if (b) b.addEventListener('click', toggleReady);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  /** Vrai quand la phase de jeu a la main (WebSocket actif). */
  const isInGame = () => !!socket && !!g.me;

  return { enter, isInGame };
})();
