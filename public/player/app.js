/**
 * ════════════════════════════════════════════════════════════════
 *  ESPACE PARTICIPANT
 * ════════════════════════════════════════════════════════════════
 *
 *  UNE SEULE DESTINATION DURABLE : /p/<code>/<jeton>.
 *  Le participant met ce lien en favori et le rouvre trois semaines
 *  plus tard sans se demander où il en est — c'est GET /api/me qui
 *  décide de l'écran à afficher selon l'état de la soirée.
 *
 *  Parcours : code → nom → collecte → attente → résultats
 *  Les deux premiers sont sautés quand le jeton est déjà connu.
 *
 *  Le jeton vit dans localStorage (pas sessionStorage) : il doit
 *  survivre à la fermeture de l'onglet, sinon le participant perd son
 *  panier au premier redémarrage du téléphone.
 * ════════════════════════════════════════════════════════════════
 */

(() => {
  'use strict';

  // Un jeton PAR SOIRÉE, pas un jeton unique.
  //
  // Avec une seule clé, scanner le QR d'une nouvelle soirée rechargeait
  // l'ancienne : le jeton stocké l'emportait sur le code de l'URL, sans
  // qu'on sache à quelle soirée il appartenait. On indexe donc par code.
  const KEY_TOKENS = 'blindtest:tokens';   // { CODE: jeton }
  const KEY_LAST   = 'blindtest:lastCode';

  const state = {
    token: null,
    code: null,
    party: null,
    me: null,
    tracks: [],       // panier
    quota: null,
    results: [],      // derniers résultats de recherche
    sources: [],      // filtres actifs — vide = défaut du serveur
    available: [],    // sources annoncées par le serveur
  };

  // ─── Utilitaires ────────────────────────────────────────────

  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function show(name) {
    $$('[data-screen]').forEach(el => el.classList.toggle('active', el.dataset.screen === name));
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  function fmtDuration(ms) {
    if (!ms) return '';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  /** Appel API. Le jeton part en en-tête, jamais en query string. */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { 'X-Participant-Token': state.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* réponse vide */ }
    return { status: res.status, ok: res.ok, data: json || {} };
  }

  // ─── Persistance ────────────────────────────────────────────

  function loadTokens() {
    try { return JSON.parse(localStorage.getItem(KEY_TOKENS) || '{}'); }
    catch { return {}; }
  }

  function saveSession(token, code) {
    const all = loadTokens();
    if (code) all[code] = token;
    try {
      localStorage.setItem(KEY_TOKENS, JSON.stringify(all));
      if (code) localStorage.setItem(KEY_LAST, code);
    } catch { /* navigation privée restrictive */ }
    state.token = token;
    state.code  = code || state.code;
  }

  /** Jeton d'une soirée donnée, ou du dernier accès si aucun code. */
  function loadToken(code) {
    const all = loadTokens();
    if (code) return all[code] || null;
    try {
      const last = localStorage.getItem(KEY_LAST);
      return last ? all[last] || null : null;
    } catch { return null; }
  }

  /** Oublie une soirée précise, ou celle en cours. */
  function forgetSession(code) {
    const c = code || state.code;
    const all = loadTokens();
    if (c) delete all[c];
    try { localStorage.setItem(KEY_TOKENS, JSON.stringify(all)); } catch { /* ignore */ }
    state.token = null;
  }

  /** Le jeton peut venir de l'URL (/p/CODE/JETON) ou du stockage local. */
  function tokenFromUrl() {
    const m = location.pathname.match(/^\/p\/[A-Za-z0-9]+\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function codeFromUrl() {
    const m = location.pathname.match(/^\/(?:r|j|p)\/([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : null;
  }

  // ═══════════════════════════════════════════════════════════
  //  V2 — Saisie du code
  // ═══════════════════════════════════════════════════════════

  function normalizeCode(v) {
    return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  async function submitCode(raw) {
    const code = normalizeCode(raw !== undefined ? raw : $('#code-input').value);
    const err = $('#code-error');
    err.textContent = '';

    if (code.length < 4) {
      err.textContent = 'Le code fait au moins 4 caractères.';
      err.classList.add('shake');
      setTimeout(() => err.classList.remove('shake'), 400);
      return false;
    }

    $('#code-btn').disabled = true;
    $('#code-btn').textContent = 'Vérification…';
    const { ok, data } = await api('GET', `/api/join/${code}`);
    $('#code-btn').disabled = false;
    $('#code-btn').textContent = 'Continuer';

    if (!ok) {
      err.textContent = data.error || 'Aucune soirée avec ce code.';
      err.classList.add('shake');
      setTimeout(() => err.classList.remove('shake'), 400);
      return false;
    }

    renderClaim(data);
    show('claim');
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  //  V3 — Revendication du nom
  // ═══════════════════════════════════════════════════════════

  function renderClaim(data) {
    state.party = data.party;
    $('#claim-party').textContent = data.party.name;

    // Auto-inscription : proposée seulement si la soirée l'autorise.
    // Sinon le joueur choisirait un nom que l'hôte n'attend pas, et
    // ses morceaux n'auraient pas de propriétaire prévu.
    const canCreate = data.party.selfRegistration === true;
    $('#claim-create').classList.toggle('hidden', !canCreate);

    const list = $('#claim-list');
    if (!data.participants.length) {
      list.innerHTML = canCreate
        ? '<p class="empty">Personne pour l\'instant — sois le premier.</p>'
        : '<p class="empty">Les inscriptions sont closes pour cette soirée.</p>';
      return;
    }

    list.innerHTML = data.participants.map(p => `
      <button class="name-tile" data-id="${esc(p.id)}" style="--c:${esc(p.color)}"
              ${p.claimed ? 'disabled' : ''}>
        <span>${esc(p.displayName)}</span>
        ${p.claimed ? '<span class="taken">déjà pris</span>' : ''}
      </button>
    `).join('');

    list.querySelectorAll('.name-tile:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => claim(data.party.code, btn.dataset.id));
    });
  }

  /** Crée puis revendique un nom, quand la soirée autorise l'inscription. */
  async function createName() {
    const input = $('#claim-new-name');
    const name = input.value.trim();
    const err = $('#claim-error');
    err.textContent = '';
    if (!name) { input.focus(); return; }

    const btn = $('#claim-new-btn');
    btn.disabled = true;
    const { ok, data } = await api('POST', `/api/join/${state.party.code}/register`, { displayName: name });
    btn.disabled = false;

    if (!ok) {
      err.textContent = data.error || 'Création impossible.';
      // Nom déjà pris : on pré-remplit une variante plutôt que de
      // laisser le joueur deviner.
      if (data.suggestions && data.suggestions.length) {
        input.value = data.suggestions[0];
        input.select();
        err.textContent += ` Essaie « ${data.suggestions.join(' », « ')} ».`;
      }
      return;
    }

    saveSession(data.token, state.party.code);
    state.code = state.party.code;
    history.replaceState(null, '', data.magicLink);
    await resolve();
  }

  async function claim(code, participantId) {
    const err = $('#claim-error');
    err.textContent = '';

    const { ok, data } = await api('POST', `/api/join/${code}/claim/${participantId}`);
    if (!ok) {
      // 409 : quelqu'un a pris ce nom entre l'affichage et le clic.
      // On rafraîchit la liste plutôt que de laisser un écran périmé.
      err.textContent = data.error || 'Ce nom vient d\'être pris.';
      const refresh = await api('GET', `/api/join/${code}`);
      if (refresh.ok) renderClaim(refresh.data);
      return;
    }

    saveSession(data.token, code);
    state.code = code;
    // On remplace l'URL par le lien magique : le participant peut alors
    // mettre la page en favori et y revenir directement.
    history.replaceState(null, '', data.magicLink);
    await resolve();
  }

  // ═══════════════════════════════════════════════════════════
  //  P0 — Résolveur
  // ═══════════════════════════════════════════════════════════

  /**
   * Veille sur l'état de la soirée pendant la phase asynchrone.
   *
   * DEUX MÉCANISMES COMPLÉMENTAIRES :
   *
   *   - un canal WebSocket, qui pousse le changement dès qu'il se
   *     produit. C'est lui qui fait basculer l'écran en une seconde
   *     quand l'hôte verrouille ou ouvre le salon.
   *
   *   - un sondage de secours toutes les 15 s, au cas où le socket
   *     serait tombé sans qu'on le sache. Il ne coûte presque rien et
   *     évite qu'un incident réseau laisse quelqu'un bloqué toute la
   *     soirée sur un écran périmé.
   */
  let watchSocket = null;

  function startWatching() {
    if (watchSocket || !state.token || typeof io === 'undefined') return;
    watchSocket = io();
    watchSocket.on('connect', () => {
      watchSocket.emit(EVENTS.PLAYER_WATCH, { token: state.token });
    });
    watchSocket.on(EVENTS.STATE_PARTY_CHANGED, () => {
      // On ne fait pas confiance au contenu du message : on redemande
      // au résolveur, seul juge de l'écran à afficher.
      resolve();
    });
  }

  let pollTimer = null;
  function schedulePoll(currentScreen) {
    clearTimeout(pollTimer);
    if (!['panier', 'attente', 'resultats'].includes(currentScreen)) return;
    pollTimer = setTimeout(async () => {
      if (document.hidden) { schedulePoll(currentScreen); return; }
      const { ok, data } = await api('GET', '/api/me');
      if (ok && data.screen !== currentScreen) { resolve(); return; }
      schedulePoll(currentScreen);
    }, 15000);
  }

  async function resolve() {
    clearTimeout(pollTimer);
    show('loading');
    const { ok, status, data } = await api('GET', '/api/me');

    if (!ok) {
      if (status === 401) {
        forgetSession(state.code);
        toast('Ce lien n\'est plus valide.', true);
        show('code');
        return;
      }
      toast(data.error || 'Erreur serveur.', true);
      show('code');
      return;
    }

    state.party  = data.party;
    state.code   = data.party.code;
    state.me     = data.me;
    state.tracks = data.tracks;
    state.quota  = data.quota;
    state.submitted = data.submitted === true;

    // Le bandeau pseudo/score n'a de sens que pendant la partie.
    if (data.screen !== 'jeu' && window.PlayerHeader) window.PlayerHeader.hide();

    schedulePoll(data.screen);
    startWatching();

    switch (data.screen) {
      case 'panier':    renderCollect(); show('collect'); break;
      case 'attente':   renderWait();    show('wait');    break;
      case 'resultats': await renderStandings(); show('results'); break;
      case 'jeu':
        // La phase de jeu a sa propre logique (WebSocket, votes,
        // entracte). On lui passe la main avec l'identité déjà résolue.
        window.PlayerGame.enter(state.token, {
          id: data.me.id, name: data.me.displayName, color: data.me.color,
        });
        break;
      default: show('code');
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  P1 — Collecte
  // ═══════════════════════════════════════════════════════════

  function renderCollect() {
    $('#collect-party').textContent = state.party.name;
    const me = $('#collect-me');
    me.textContent = state.me.displayName;
    me.style.setProperty('--c', state.me.color);
    renderQuota();
    renderBasket();
    renderSubmit();
  }

  /**
   * Jauge de quota — l'élément signature.
   *
   * Un segment par emplacement disponible, un trait sous le dernier
   * segment requis. Une barre de progression classique ne saurait pas
   * exprimer une fourchette : on lit ici « il m'en manque un » et
   * « il me reste deux emplacements » d'un même coup d'œil.
   */
  function renderQuota(justAdded = false) {
    const { min, max } = state.quota;
    const n = state.tracks.length;

    $('#segments').innerHTML = Array.from({ length: max }, (_, i) => {
      const cls = ['seg'];
      if (i < n) cls.push('filled');
      if (i === min - 1) cls.push('threshold');
      if (justAdded && i === n - 1) cls.push('pulse');
      return `<div class="${cls.join(' ')}"></div>`;
    }).join('');

    $('#quota-count').textContent = `${n} / ${max}`;

    const hint = $('#quota-hint');
    if (n < min) {
      const missing = min - n;
      hint.textContent = `Encore ${missing} pour atteindre le minimum`;
      hint.classList.remove('done');
    } else if (n < max) {
      hint.textContent = `Minimum atteint · ${max - n} emplacement${max - n > 1 ? 's' : ''} libre${max - n > 1 ? 's' : ''}`;
      hint.classList.add('done');
    } else {
      hint.textContent = 'Sélection complète';
      hint.classList.add('done');
    }
  }

  function trackRow(t, mode) {
    const art = t.artworkUrl || t.artwork_url;
    const inBasket = mode === 'result' && isInBasket(t);
    const full = state.tracks.length >= state.quota.max;

    // Seuls DEUX modes affichent une action. Tout le reste est en
    // lecture seule — c'est le défaut sûr : un mode inconnu ne doit pas
    // faire apparaître un bouton « + » qui ne peut qu'échouer, comme
    // c'était le cas sur l'écran d'attente.
    let button = '';
    if (mode === 'basket') {
      button = `<button class="track-act remove" data-remove="${esc(t.id)}" aria-label="Retirer">−</button>`;
    } else if (mode === 'result') {
      button = `<button class="track-act" data-add="${esc(t.sourceId)}"
                   ${inBasket || full ? 'disabled' : ''}
                   aria-label="Ajouter">${inBasket ? '✓' : '+'}</button>`;
    }

    return `
      <div class="track${inBasket ? ' in-basket' : ''}">
        ${art ? `<img src="${esc(art)}" alt="" loading="lazy">` : '<div class="noart"></div>'}
        <div class="track-info">
          <div class="track-title">${esc(t.title)}</div>
          <div class="track-sub">${mode === 'result' && t.source ? `<span class="src-tag src-${esc(t.source)}">${esc(t.source)}</span> ` : ''}${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}${
            t.durationMs || t.duration_ms ? ' · ' + fmtDuration(t.durationMs || t.duration_ms) : ''}</div>
        </div>
        ${button}
      </div>`;
  }

  function isInBasket(t) {
    return state.tracks.some(b => b.source === t.source && b.source_id === t.sourceId);
  }

  /**
   * Bouton de validation.
   *
   * Deux états seulement, et une règle : modifier son panier après
   * validation la révoque côté serveur. On réaffiche donc toujours
   * l'état renvoyé par l'API plutôt que de le déduire localement.
   */
  function renderSubmit() {
    const el = $('#submit-zone');
    const n = state.tracks.length;
    const { min } = state.quota;

    if (state.submitted) {
      el.innerHTML = `
        <div class="banner good" style="margin-bottom:.6rem">
          Sélection validée. L'hôte sait que tu as terminé.
        </div>
        <button class="btn ghost full" id="unsubmit-btn">Modifier ma sélection</button>`;
      $('#unsubmit-btn').addEventListener('click', unsubmitList);
      return;
    }

    const short = n < min;
    el.innerHTML = `
      <button class="btn full" id="submit-btn" ${short ? 'disabled' : ''}>
        ${short ? `Encore ${min - n} morceau${min - n > 1 ? 'x' : ''}` : 'Valider ma sélection'}
      </button>
      <p class="muted small" style="text-align:center;margin-top:.5rem">
        Tu pourras encore la modifier ensuite.
      </p>`;
    if (!short) $('#submit-btn').addEventListener('click', submitList);
  }

  async function submitList() {
    const { ok, data } = await api('POST', '/api/me/submit');
    if (!ok) { toast(data.error || 'Validation impossible.', true); if (data.closed) resolve(); return; }
    state.submitted = true;
    renderSubmit();
    toast('Sélection validée.');
  }

  async function unsubmitList() {
    const { ok, data } = await api('DELETE', '/api/me/submit');
    if (!ok) { toast(data.error || 'Modification impossible.', true); if (data.closed) resolve(); return; }
    state.submitted = false;
    renderSubmit();
  }

  function renderBasket() {
    const el = $('#basket');
    if (!state.tracks.length) {
      el.innerHTML = '<p class="empty">Rien pour l\'instant.<br>Cherche un morceau pour commencer.</p>';
      return;
    }
    el.innerHTML = state.tracks.map(t => trackRow(t, 'basket')).join('');
    el.querySelectorAll('[data-remove]').forEach(b => {
      b.addEventListener('click', () => removeTrack(b.dataset.remove));
    });
  }

  /**
   * Filtres de source.
   *
   * Repliés dans une seule ligne de puces : la plupart du temps le
   * défaut convient, et on ne veut pas transformer une recherche en
   * formulaire. Ils n'apparaissent qu'après la première recherche,
   * quand le serveur a dit quelles sources existent.
   */
  function renderSourceFilters() {
    const el = $('#source-filters');
    if (!el || !state.available || !state.available.length) return;
    el.innerHTML = state.available.map(s => {
      const on = !state.sources || !state.sources.length || state.sources.includes(s.name);
      return `<button class="src-chip ${on ? 'on' : ''}" data-src="${esc(s.name)}">${esc(s.label)}</button>`;
    }).join('');

    el.querySelectorAll('[data-src]').forEach(b => b.addEventListener('click', () => {
      const all = state.available.map(s => s.name);
      let cur = (state.sources && state.sources.length) ? state.sources.slice() : all.slice();
      const n = b.dataset.src;
      cur = cur.includes(n) ? cur.filter(x => x !== n) : [...cur, n];
      // Tout décocher n'a pas de sens : on revient au défaut du serveur.
      state.sources = cur.length ? cur : [];
      renderSourceFilters();
      doSearch();
    }));
  }

  function renderSearchResults() {
    const el = $('#results');
    if (!state.results.length) {
      el.innerHTML = '<p class="empty">Aucun résultat pour cette recherche.</p>';
      return;
    }
    el.innerHTML = state.results.map(t => trackRow(t, 'result')).join('');
    el.querySelectorAll('[data-add]').forEach(b => {
      b.addEventListener('click', () => {
        const t = state.results.find(x => String(x.sourceId) === b.dataset.add);
        if (t) addTrack(t);
      });
    });
  }

  // ─── Recherche ──────────────────────────────────────────────

  let searchSeq = 0;

  async function doSearch() {
    const q = $('#search-input').value.trim();
    if (q.length < 2) return;

    const seq = ++searchSeq;
    $('#results').innerHTML = '<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>';

    const params = new URLSearchParams({ q });
    if (state.sources && state.sources.length) params.set('sources', state.sources.join(','));
    const { ok, data } = await api('GET', `/api/search?${params}`);
    // Une réponse plus lente d'une recherche antérieure ne doit pas
    // écraser des résultats plus récents.
    if (seq !== searchSeq) return;

    if (!ok) {
      $('#results').innerHTML = `<p class="empty">${esc(data.error || 'La recherche a échoué.')}</p>`;
      return;
    }

    state.results = data.tracks || [];
    state.available = data.available || state.available;
    renderSourceFilters();
    renderSearchResults();

    // Une source en panne ne doit pas faire échouer la recherche : on
    // affiche les résultats des autres et on signale l'absente.
    if (data.errors && data.errors.length) {
      toast(`${data.errors.map(e => e.source).join(', ')} indisponible`, true);
    }
  }

  // ─── Ajout par lien collé ───────────────────────────────────

  let pasted = null;   // { source, sourceId, url } en attente de titre/artiste

  /**
   * Deux temps : on vérifie d'abord le lien, puis on demande titre et
   * artiste. Demander les trois d'un coup ferait saisir des champs
   * pour un lien qui sera peut-être rejeté.
   */
  async function pasteUrl() {
    const err = $('#paste-error');
    err.textContent = '';

    if (!pasted) {
      const url = $('#paste-url').value.trim();
      if (!url) return;
      const { ok, data } = await api('POST', '/api/search/resolve-url', { url });
      if (!ok) { err.textContent = data.error || 'Lien non reconnu.'; return; }

      pasted = data.track;
      $('#paste-fields').classList.remove('hidden');
      $('#paste-btn').textContent = `Ajouter ce morceau (${data.platform})`;
      $('#paste-title').focus();
      return;
    }

    const title  = $('#paste-title').value.trim();
    const artist = $('#paste-artist').value.trim();
    if (!title || !artist) { err.textContent = 'Titre et artiste sont nécessaires.'; return; }

    await addTrack({ ...pasted, title, artist, durationMs: null, artworkUrl: null });
    resetPaste();
  }

  function resetPaste() {
    pasted = null;
    $('#paste-url').value = '';
    $('#paste-title').value = '';
    $('#paste-artist').value = '';
    $('#paste-fields').classList.add('hidden');
    $('#paste-btn').textContent = 'Vérifier le lien';
    $('#paste-error').textContent = '';
  }

  // ─── Panier ─────────────────────────────────────────────────

  async function addTrack(t) {
    const { ok, data } = await api('POST', '/api/me/tracks', {
      source: t.source, sourceId: t.sourceId,
      title: t.title, artist: t.artist, album: t.album,
      durationMs: t.durationMs, artworkUrl: t.artworkUrl, url: t.url,
    });

    if (!ok) {
      toast(data.error || 'Ajout impossible.', true);
      // 409 sur état : la collecte vient de se fermer pendant la saisie.
      if (data.closed || data.state) resolve();
      return;
    }

    state.tracks.push(data.track);
    state.submitted = false;   // le serveur vient de révoquer la validation
    renderQuota(true);
    renderBasket();
    renderSubmit();
    renderSearchResults();
    toast(`« ${t.title} » ajouté`);
  }

  async function removeTrack(trackId) {
    const { ok, data } = await api('DELETE', `/api/me/tracks/${trackId}`);
    if (!ok) {
      toast(data.error || 'Suppression impossible.', true);
      if (data.closed || data.state) resolve();
      return;
    }
    state.tracks = data.tracks;
    state.submitted = false;
    renderQuota();
    renderBasket();
    renderSubmit();
    renderSearchResults();
  }

  // ─── Feuille du panier ──────────────────────────────────────

  function toggleSheet(force) {
    const open = force !== undefined ? force : !$('#sheet').classList.contains('open');
    $('#sheet').classList.toggle('open', open);
    $('#sheet-backdrop').classList.toggle('open', open);
    $('#quota-bar').classList.toggle('open', open);
  }

  // ═══════════════════════════════════════════════════════════
  //  P2 / P7
  // ═══════════════════════════════════════════════════════════

  function renderWait(customText) {
    $('#wait-party').textContent = state.party.name;

    // Rappeler qui l'on est : trois semaines après avoir rejoint, on ne
    // se souvient plus sous quel nom on joue.
    const me = $('#wait-me');
    if (me && state.me) {
      me.innerHTML = `Tu joues en tant que <b style="color:${esc(state.me.color)}">${esc(state.me.displayName)}</b>`;
    }

    const texts = {
      verrouillee: 'Les envois sont clos. L\'hôte prépare la playlist.',
      prete: 'Tout est prêt. Rendez-vous le jour J.',
    };
    $('#wait-text').textContent =
      customText || texts[state.party.state] || 'La soirée n\'a pas encore commencé.';

    $('#wait-basket').innerHTML = state.tracks.length
      ? '<h2 style="font-family:Bebas Neue;letter-spacing:.06em;margin:1rem 0 .5rem">Ta sélection</h2>'
        + state.tracks.map(t => trackRow(t, 'readonly')).join('')
      : '';
  }

  async function renderStandings() {
    const { ok, data } = await api('GET', '/api/me/results');
    if (!ok) return;
    $('#results-party').textContent = data.party.name;
    $('#standings').innerHTML = data.standings.map((s, i) => `
      <div class="standing" style="--c:${esc(s.color)}">
        <span class="rank">${i + 1}</span>
        <span>${esc(s.display_name)}</span>
        <span class="pts">${s.score}</span>
      </div>
    `).join('') || '<p class="empty">Aucune partie jouée.</p>';
  }

  // ═══════════════════════════════════════════════════════════
  //  Amorçage
  // ═══════════════════════════════════════════════════════════

  function bindEvents() {
    // Code
    const codeInput = $('#code-input');
    codeInput.addEventListener('input', () => {
      const pos = codeInput.selectionStart;
      codeInput.value = normalizeCode(codeInput.value);
      codeInput.setSelectionRange(pos, pos);
    });
    codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') submitCode(); });
    $('#code-btn').addEventListener('click', () => submitCode());

    $('#paste-btn').addEventListener('click', pasteUrl);
    $('#paste-url').addEventListener('input', () => { if (pasted) resetPaste(); });

    $('#claim-new-btn').addEventListener('click', createName);
    $('#claim-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') createName(); });

    // Sortir d'une soirée sans dépendre d'un QR. On n'efface QUE celle-ci :
    // les autres jetons du téléphone restent valides.
    $$('[data-action="switch"]').forEach(b => {
      b.addEventListener('click', () => {
        forgetSession(state.code);
        state.party = null; state.me = null; state.tracks = [];
        history.replaceState(null, '', '/player');
        $('#code-input').value = '';
        show('code');
      });
    });

    $$('[data-action="back-to-code"]').forEach(b => {
      b.addEventListener('click', () => { $('#code-input').value = ''; show('code'); });
    });

    // Recherche
    $('#search-btn').addEventListener('click', doSearch);
    $('#search-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doSearch(); $('#search-input').blur(); }
    });

    // Feuille
    $('#quota-bar').addEventListener('click', () => toggleSheet());
    $('#quota-bar').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSheet(); }
    });
    $('#sheet-backdrop').addEventListener('click', () => toggleSheet(false));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleSheet(false); });
  }

  /**
   * Amorçage — l'ordre de priorité est la clé de tout.
   *
   *   1. Jeton dans l'URL  : lien magique explicite, il gagne toujours.
   *   2. Code dans l'URL   : QR ou lien de salon. On cherche un jeton
   *                          POUR CETTE SOIRÉE ; à défaut, écran de
   *                          choix du nom. Un jeton d'une AUTRE soirée
   *                          ne doit surtout pas s'appliquer ici.
   *   3. Rien dans l'URL   : dernière soirée visitée, si connue.
   */
  // Revenir sur l'onglet est le moment où l'on veut l'information la
  // plus fraîche : on ne fait pas attendre le prochain cycle.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token && !window.PlayerGame.isInGame()) resolve();
  });

  async function boot() {
    bindEvents();

    const urlToken = tokenFromUrl();
    const urlCode  = codeFromUrl();

    if (urlToken) {
      state.token = urlToken;
      state.code  = urlCode || '';
      saveSession(urlToken, state.code);
      await resolve();
      return;
    }

    if (urlCode) {
      const known = loadToken(urlCode);
      if (known) {
        state.token = known;
        state.code  = urlCode;
        await resolve();
        return;
      }
      // Aucun jeton pour CETTE soirée : on passe au choix du nom, même
      // si le téléphone en connaît d'autres.
      $('#code-input').value = urlCode;
      if (await submitCode(urlCode)) return;
      show('code');
      return;
    }

    const last = loadToken();
    if (last) {
      state.token = last;
      try { state.code = localStorage.getItem(KEY_LAST) || ''; } catch { /* ignore */ }
      await resolve();
      return;
    }
    show('code');
  }

  /**
   * Surface exposée à game.js : les écrans de jeu ont besoin de
   * basculer d'écran, d'afficher un toast et de redemander au
   * résolveur où aller quand le salon disparaît.
   */
  let currentScreen = null;

  window.PlayerApp = {
    show: (n) => { currentScreen = n; show(n); },
    current: () => currentScreen,
    toast,
    reresolve: resolve,
  };

  boot();
})();
