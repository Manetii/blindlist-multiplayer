/**
 * ════════════════════════════════════════════════════════════════
 *  CONSOLE HÔTE
 * ════════════════════════════════════════════════════════════════
 *
 *  Écrans H1 à H6 : créer une soirée, gérer les participants, suivre
 *  la complétion, arbitrer les doublons, verrouiller, vérifier les
 *  fichiers.
 *
 *  LE hostToken NE QUITTE JAMAIS CE NAVIGATEUR.
 *  Il prouve la propriété de la soirée et n'est lisible en clair
 *  qu'une seule fois, à la création. On le range aussitôt dans
 *  localStorage ; le perdre rend la soirée inaccessible depuis ce
 *  poste. Il part en en-tête, jamais dans une URL — une URL finit
 *  dans les logs, l'historique et l'en-tête Referer.
 *
 *  Le PC gère, le téléphone joue. Cette console ne rejoint jamais un
 *  salon : l'hôte y entre comme n'importe quel participant, depuis
 *  son téléphone, avec le lien partagé.
 * ════════════════════════════════════════════════════════════════
 */

(() => {
  'use strict';

  const STORE = 'blindtest:parties';   // { CODE: {hostToken, name} }

  const state = {
    code: null,
    hostToken: null,
    party: null,
    participants: [],
    progress: [],
    duplicates: [],
    manifest: [],
  };

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };

  function view(name) {
    $$('[data-view]').forEach(v => v.classList.toggle('active', v.dataset.view === name));
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (bad ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  // ─── Stockage des soirées possédées ─────────────────────────

  function loadParties() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; }
  }
  function saveParty(code, hostToken, name) {
    const all = loadParties();
    all[code] = { hostToken, name };
    try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* ignore */ }
  }
  function forgetParty(code) {
    const all = loadParties();
    delete all[code];
    try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { /* ignore */ }
  }

  // ─── Appels API ─────────────────────────────────────────────

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.hostToken ? { 'X-Host-Token': state.hostToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return { ok: false, data: {} }; }
    let data = null;
    try { data = await res.json(); } catch { /* réponse vide */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  // ═══════════════════════════════════════════════════════════
  //  H1 — Choix ou création
  // ═══════════════════════════════════════════════════════════

  /**
   * Purge les soirées que ce navigateur croit posséder mais qui
   * n'existent plus côté serveur — typiquement supprimées depuis la
   * page d'administration. Sans ça, elles restent affichées et mènent
   * à une erreur au clic.
   */
  async function pruneDeleted() {
    const all = loadParties();
    const codes = Object.keys(all);
    if (!codes.length) return;

    const checks = await Promise.all(codes.map(async (c) => {
      try {
        const res = await fetch(`/api/join/${c}`);
        return { code: c, gone: res.status === 404 };
      } catch {
        return { code: c, gone: false };   // réseau muet : on ne supprime rien
      }
    }));

    let removed = 0;
    for (const { code, gone } of checks) if (gone) { forgetParty(code); removed++; }
    if (removed) console.log(`[host] ${removed} soirée(s) disparue(s) retirée(s) de la liste locale`);
    return removed;
  }

  function renderPick() {
    const all = loadParties();
    const codes = Object.keys(all);
    $('#my-parties').classList.toggle('hidden', codes.length === 0);
    $('#my-parties-list').innerHTML = codes.map(c => `
      <div class="line" style="--c:var(--accent)">
        <a href="/h/${c}" style="display:flex;gap:.75rem;flex:1;text-decoration:none;color:inherit">
          <span style="font-family:'Bebas Neue';font-size:1.25rem;letter-spacing:.18em;color:var(--accent)">${esc(c)}</span>
          <span class="grow">${esc(all[c].name || 'Soirée')}</span>
        </a>
        <button class="icon-btn danger" data-forget="${esc(c)}" title="Retirer de cette liste">✕</button>
      </div>`).join('');

    // Retirer sans supprimer côté serveur : la soirée peut appartenir à
    // quelqu'un d'autre ou être reprise depuis un autre poste.
    $('#my-parties-list').querySelectorAll('[data-forget]').forEach(b =>
      b.addEventListener('click', () => {
        if (!confirm('Retirer cette soirée de la liste de ce navigateur ?\n\nElle n\'est pas supprimée du serveur, mais tu perdras l\'accès depuis ce poste.')) return;
        forgetParty(b.dataset.forget);
        renderPick();
      }));

    view('pick');
  }

  async function createParty() {
    const name = $('#np-name').value.trim();
    const err = $('#np-error');
    err.textContent = '';

    if (!name) { err.textContent = 'Donne un nom à la soirée.'; return; }

    $('#np-create').disabled = true;
    // Le quota se règle dans la console : c'est un paramètre du
    // fonctionnement de la soirée, pas de sa création, et l'hôte doit
    // pouvoir l'ajuster en voyant où en sont les paniers.
    //
    // selfRegistration est acquis : demander à l'hôte de saisir les
    // pseudos à la place des joueurs faisait double emploi avec l'écran
    // d'arrivée, qui gère déjà les homonymes.
    const { ok, data } = await api('POST', '/api/host/parties', {
      name, selfRegistration: true,
    });
    $('#np-create').disabled = false;

    if (!ok) { err.textContent = data.error || 'Création impossible.'; return; }

    saveParty(data.party.code, data.hostToken, data.party.name);
    location.href = '/h/' + data.party.code;
  }

  // ═══════════════════════════════════════════════════════════
  //  H0 — Console
  // ═══════════════════════════════════════════════════════════

  async function loadConsole() {
    const { ok, status, data } = await api('GET', `/api/host/parties/${state.code}`);
    if (!ok) {
      if (status === 404) {
        // Soirée disparue, ou jeton d'un autre navigateur.
        forgetParty(state.code);
        toast('Cette soirée est introuvable depuis ce navigateur.', true);
        setTimeout(() => { location.href = '/h'; }, 1600);
      }
      return;
    }

    state.party = data.party;
    state.participants = data.participants;
    state.progress = data.progress;
    saveParty(state.code, state.hostToken, data.party.name);

    if (data.party.state !== 'collecte') {
      state.duplicates = [];
    } else {
      const d = await api('GET', `/api/host/parties/${state.code}/duplicates`);
      state.duplicates = d.ok ? d.data.duplicates : [];
    }

    render();
    view('console');
    // Le plancher du quota arrive après coup : il ne conditionne pas
    // l'affichage, seulement la borne basse du champ.
    loadQuotaFloor();

    const t = new Date();
    $('#c-refreshed').textContent =
      `à jour · ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
    scheduleAutoRefresh();
  }

  /**
   * Rafraîchissement automatique pendant la collecte.
   *
   * Les paniers se remplissent pendant que l'hôte regarde son écran,
   * sans que rien ne le lui signale. Un sondage toutes les 20 s suffit :
   * c'est une phase asynchrone, pas du temps réel, et ça évite d'ouvrir
   * un WebSocket pour ça.
   *
   * Arrêté dès que la collecte est close — plus rien ne bouge ensuite.
   */
  let refreshTimer = null;
  function scheduleAutoRefresh() {
    clearTimeout(refreshTimer);
    if (!state.party || state.party.state !== 'collecte') return;
    refreshTimer = setTimeout(() => {
      if (document.hidden) { scheduleAutoRefresh(); return; }   // onglet en arrière-plan
      loadConsole();
    }, 20000);
  }

  /**
   * Plancher du quota. Chargé à part : il dépend des paniers, pas de la
   * soirée, et une seconde de retard sur cette ligne ne gêne personne.
   */
  async function loadQuotaFloor() {
    const { ok, data } = await api('GET', `/api/host/parties/${state.code}/quota-floor`);
    if (ok) { state.quotaFloor = data; renderQuota(); }
  }

  function render() {
    const p = state.party;
    $('#c-name').textContent = p.name;
    $('#c-state').textContent = p.state;
    $('#c-code').textContent = p.code;

    $('#c-url').textContent = shareUrl();
    renderQR(shareUrl());
    checkNetwork();

    renderQuota();
    renderGameOptions();
    renderSteps();
    renderPeople();
    renderProgress();
    renderDupes();
    renderLock();
  }

  /**
   * L'origine à diffuser.
   *
   * On mémorise le choix de l'hôte : rebasculer sur localhost à chaque
   * rechargement obligerait à re-scanner un QR inutilisable.
   */
  function shareOrigin() {
    try { return localStorage.getItem('blindtest:origin') || location.origin; }
    catch { return location.origin; }
  }
  function shareUrl() { return `${shareOrigin()}/j/${state.code}`; }

  /**
   * Si la console est ouverte sur localhost, le lien diffusé est
   * inutilisable depuis un téléphone — « localhost », sur un téléphone,
   * désigne le téléphone. On propose alors les adresses réseau du
   * serveur.
   */
  async function checkNetwork() {
    const el = $('#c-net');
    const onLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(shareOrigin());
    if (!onLocalhost) { el.classList.add('hidden'); return; }

    const { ok, data } = await api('GET', '/api/host/network');
    if (!ok || !data.addresses.length) { el.classList.add('hidden'); return; }

    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="banner warn">
        Ce lien pointe vers <b>localhost</b> : les téléphones ne pourront pas l'ouvrir.
      </div>
      <div class="btn-row" style="margin-top:.5rem">
        ${data.addresses.map(a => `
          <button class="btn ghost sm" data-origin="http://${a.address}:${data.port}">
            Utiliser ${a.address}
          </button>`).join('')}
      </div>`;

    el.querySelectorAll('[data-origin]').forEach(b => {
      b.addEventListener('click', () => {
        try { localStorage.setItem('blindtest:origin', b.dataset.origin); } catch {}
        toast('Lien mis à jour.');
        render();
      });
    });
  }

  /**
   * QR par API publique : aucune dépendance à embarquer. En réseau
   * local sans internet il ne s'affichera pas — d'où le lien en clair
   * juste à côté, qui reste la voie de secours.
   */
  function renderQR(url) {
    const el = $('#c-qr');
    const img = new Image();
    img.width = 148; img.height = 148; img.alt = 'QR code de la soirée';
    img.onload = () => { el.innerHTML = ''; el.appendChild(img); };
    img.onerror = () => { el.innerHTML = '<div class="fallback">QR indisponible hors ligne — partage le lien.</div>'; };
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=6&data=' + encodeURIComponent(url);
  }

  /**
   * ════════════════════════════════════════════════════════════
   *  LES TROIS ÉTAPES
   * ════════════════════════════════════════════════════════════
   *
   *  Collecte → Validation → Prête. Trois moments distincts, chacun
   *  avec ses propres blocs, et UN SEUL AFFICHÉ À LA FOIS.
   *
   *  L'ancienne page empilait tout : on faisait défiler pour trouver le
   *  bouton pertinent, et les blocs sans objet restaient à l'écran en
   *  grisé. Une préparation est une séquence — l'écran doit montrer où
   *  l'on en est, pas tout ce qui existe.
   *
   *  La navigation reste libre : on peut revenir en arrière consulter
   *  la complétion pendant la validation. Le fil met simplement en
   *  avant l'étape que l'état de la soirée désigne.
   * ════════════════════════════════════════════════════════════ */
  //  « Prête » nommait un ÉTAT, pas une tâche, et ne contenait qu'un
  //  bouton. Les trois libellés désignent maintenant trois actions.
  const STEPS = [
    { label: 'Collecte', title: 'Participants, quota et verrouillage' },
    { label: 'Fichiers', title: 'Récupérer et apparier les morceaux' },
    { label: 'Options',  title: 'Règles de jeu et lancement' },
  ];

  /** Étape que l'état de la soirée désigne comme courante. */
  function stepOfState(st) {
    if (st === 'collecte') return 0;
    if (st === 'verrouillee') return 1;
    return 2;                                  // prete, terminee, archivee
  }

  let currentStep = null;
  let lastNatural = null;

  /**
   * Etape demandee par l'URL (?step=N).
   *
   * C'est ce qui permet au lecteur de renvoyer vers l'etape de
   * lancement plutot que vers le haut de la console. Lue UNE fois, au
   * chargement : passe ce point, la navigation de l'hote prime.
   */
  function stepFromUrl() {
    const raw = new URLSearchParams(location.search).get('step');
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : null;
  }
  let requestedStep = stepFromUrl();

  function renderSteps() {
    const natural = stepOfState(state.party.state);

    // On se place sur l'étape naturelle au PREMIER rendu, et à chaque
    // fois que l'état de la soirée CHANGE. Entre-temps, la navigation
    // de l'hôte est respectée — sans quoi revenir consulter la collecte
    // après une partie terminée était impossible : le rendu suivant
    // ramenait aussitôt à la dernière étape.
    if (currentStep === null || natural !== lastNatural) currentStep = natural;
    // Une etape demandee par l'URL l'emporte sur l'etape naturelle, mais
    // une seule fois : sans cela, chaque rendu ramenerait l'hote a
    // l'etape du lien et rendrait le fil inutilisable.
    if (requestedStep !== null) { currentStep = requestedStep; requestedStep = null; }
    lastNatural = natural;

    $('#c-steps').innerHTML = STEPS.map((s, k) => {
      const cls = k < natural ? 'done' : k === natural ? 'now' : '';
      const here = k === currentStep ? ' viewing' : '';
      return `<button class="step ${cls}${here}" data-step="${k}">${esc(s.label)}</button>`;
    }).join('');
    $('#c-steps').querySelectorAll('[data-step]').forEach(b =>
      b.addEventListener('click', () => goStep(Number(b.dataset.step))));

    $('#step-title').textContent = STEPS[currentStep].title;
    $('#step-prev').disabled = currentStep === 0;
    $('#step-next').disabled = currentStep === STEPS.length - 1;

    document.querySelectorAll('.step-block').forEach(el => {
      el.classList.toggle('hidden', Number(el.dataset.step) !== currentStep);
    });

    // Les doublons n'ont d'intérêt que s'il y en a. Ils appartiennent à
    // la collecte : c'est le verrouillage qui fige la playlist, donc
    // c'est avant lui qu'il faut trancher.
    $('#s-dupes').classList.toggle('hidden',
      currentStep !== 0 || state.duplicates.length === 0);

    if (['prete', 'terminee'].includes(state.party.state)) {
      $('#play-btn').href = `/h/${state.party.code}/play`;
      $('#play-btn').classList.remove('disabled');
    } else {
      $('#play-btn').removeAttribute('href');
      $('#play-btn').classList.add('disabled');
    }
  }

  function goStep(n) {
    currentStep = Math.max(0, Math.min(STEPS.length - 1, n));
    renderSteps();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ─── H2 — Participants ──────────────────────────────────────

  function renderPeople() {
    $('#p-count').textContent = state.participants.length;
    const el = $('#p-list');
    if (!state.participants.length) {
      el.innerHTML = '<p class="empty">Ajoute les joueurs, puis partage le lien.<br>Chacun choisira son nom dans la liste.</p>';
      return;
    }
    el.innerHTML = state.participants.map(p => `
      <div class="line" style="--c:${esc(p.color)}">
        <span class="grow">${esc(p.display_name)}</span>
        <span class="tag ${p.claimed ? 'ok' : 'wait'}">${p.claimed ? 'connecté' : 'libre'}</span>
        <span class="acts">
          ${p.claimed ? `<button class="icon-btn" data-release="${p.id}" title="Libérer ce nom">↺</button>` : ''}
          <button class="icon-btn danger" data-remove="${p.id}" title="Supprimer">✕</button>
        </span>
      </div>`).join('');

    el.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removePerson(b.dataset.remove)));
    el.querySelectorAll('[data-release]').forEach(b => b.addEventListener('click', () => releasePerson(b.dataset.release)));
  }


  async function removePerson(id) {
    const p = state.participants.find(x => x.id === id);
    if (!confirm(`Supprimer ${p ? p.display_name : 'ce participant'} ?\nSes morceaux seront retirés de la playlist.`)) return;
    await api('DELETE', `/api/host/parties/${state.code}/participants/${id}`);
    await loadConsole();
  }

  async function releasePerson(id) {
    if (!confirm('Libérer ce nom ?\nLa personne qui l\'occupe perdra l\'accès à sa sélection.')) return;
    await api('POST', `/api/host/parties/${state.code}/participants/${id}/release`);
    toast('Nom libéré.');
    await loadConsole();
  }

  // ─── H3 — Complétion ────────────────────────────────────────

  function renderProgress() {
    const el = $('#prog-list');
    if (!state.progress.length) { el.innerHTML = '<p class="empty">Personne pour l\'instant.</p>'; return; }

    const min = state.party.min_tracks_per_person;
    const max = state.party.max_tracks_per_person;

    el.innerHTML = state.progress
      .slice()
      .sort((a, b) => a.tracks_submitted - b.tracks_submitted)
      .map(r => {
        const n = Number(r.tracks_submitted);
        const segs = Array.from({ length: max }, (_, i) =>
          `<i class="${i < n ? 'on' : ''}${i === min - 1 ? ' thr' : ''}"></i>`).join('');
        // Trois états distincts, trois relances différentes : pas assez
        // de morceaux, assez mais pas validé, terminé.
        const color = r.submitted ? 'var(--ok)' : r.meets_minimum ? 'var(--accent)' : 'var(--warn)';
        const tag = r.submitted
          ? '<span class="tag ok">validée</span>'
          : r.meets_minimum ? '<span class="tag">non validée</span>' : '';
        return `
          <div class="line" style="--c:${color}">
            <span class="grow">
              ${esc(r.display_name)}
              <span class="sub">${n} morceau${n > 1 ? 'x' : ''}${r.meets_minimum ? '' : ` · minimum ${min}`}</span>
            </span>
            <span class="segs">${segs}</span>
            ${tag}
          </div>`;
      }).join('');
  }

  // ─── H4 — Arbitrage ─────────────────────────────────────────

  function renderDupes() {
    const el = $('#dupe-list');
    if (!state.duplicates.length) { el.innerHTML = '<p class="empty">Aucun doublon.</p>'; return; }

    el.innerHTML = state.duplicates.map(d => `
      <div class="line" style="--c:var(--warn);flex-wrap:wrap">
        <span class="grow">
          ${esc(d.title)}<span class="sub">${esc(d.artist)}</span>
        </span>
        <span class="acts">
          ${d.claimants.map(c => `
            <button class="btn ghost sm" data-keep="${c.trackId}"
                    data-others="${d.claimants.filter(o => o.trackId !== c.trackId).map(o => o.trackId).join(',')}">
              Garder ${esc(c.displayName)}
            </button>`).join('')}
        </span>
      </div>`).join('');

    el.querySelectorAll('[data-keep]').forEach(b => {
      b.addEventListener('click', async () => {
        for (const id of b.dataset.others.split(',').filter(Boolean)) {
          await api('POST', `/api/host/parties/${state.code}/tracks/${id}/exclude`);
        }
        toast('Doublon tranché.');
        await loadConsole();
      });
    });
  }

  // ─── Quota et estimation ────────────────────────────────────

  /**
   * Champs de quota, plancher et estimation de charge.
   *
   * Le plancher est affiché SOUS le champ plutôt que découvert au
   * moment du refus : une contrainte qu'on ne voit qu'en la heurtant
   * passe pour un bug.
   */
  function renderQuota() {
    const p = state.party;
    const collecting = p.state === 'collecte';

    $('#q-min').value = p.min_tracks_per_person;
    $('#q-max').value = p.max_tracks_per_person;
    $('#q-min').disabled = !collecting;
    $('#q-max').disabled = !collecting;

    const floor = state.quotaFloor || { ceiling: 0, holders: [] };
    $('#q-max').min = Math.max(1, floor.ceiling);
    $('#q-floor').textContent = floor.ceiling
      ? `Pas moins de ${floor.ceiling} : ${floor.holders.join(', ')} ${
          floor.holders.length > 1 ? 'ont' : 'a'} déjà ce nombre.`
      : '';

    renderEstimate();
  }

  /**
   * Ce que le quota engage réellement.
   *
   * Choisir « 6 maximum » sans savoir que cela fait 36 fichiers à
   * réunir et trois heures de jeu, c'est choisir à l'aveugle. On compte
   * environ trois minutes par manche : extrait, votes, révélation et
   * la discussion qui va avec.
   */
  const MINUTES_PER_ROUND = 3;

  function renderEstimate() {
    const people = state.participants.length;
    const max = state.party.max_tracks_per_person;
    const el = $('#q-estimate');

    if (!people) {
      el.textContent = 'Partage le lien : l\'estimation apparaîtra dès les premières arrivées.';
      return;
    }
    const rounds = people * max;
    const minutes = rounds * MINUTES_PER_ROUND;
    const h = Math.floor(minutes / 60), m = minutes % 60;
    const duration = h ? `${h} h${m ? String(m).padStart(2, '0') : ''}` : `${m} min`;
    el.innerHTML =
      `<span>${people} participant${people > 1 ? 's' : ''} × ${max} morceaux ` +
      `= <b>${rounds} manches</b> · environ <b>${duration}</b> de jeu · ` +
      `<b>${rounds} fichiers</b> à réunir.</span>`;
  }

  /** Écrit un réglage, en remontant le motif du refus s'il y en a un. */
  async function saveSetting(patch, okMsg = 'Réglage enregistré.') {
    const { ok, data } = await api('PATCH', `/api/host/parties/${state.code}/settings`, patch);
    if (!ok) {
      // Le serveur peut refuser avec un motif précis — un quota sous un
      // panier déjà rempli. « Impossible » laisserait l'hôte sans rien
      // pour corriger.
      toast((data && data.error) || 'Enregistrement impossible.', true);
      await loadConsole();
      return false;
    }
    toast(okMsg);
    await loadConsole();
    return true;
  }

  // ─── Options de jeu ─────────────────────────────────────────

  /**
   * Les règles vivent ici, plus sur l'écran de jeu.
   *
   * Un réglage persisté en base est une propriété de la soirée ; l'écran
   * de jeu ne garde que ce qui relève de la mise en scène — le bouton
   * œil et l'anonymisation.
   */
  function renderGameOptions() {
    const p = state.party;
    $('#opt-hide-indices').checked  = p.hide_indices_default !== false;
    $('#opt-rule-bluffer').checked  = p.rule_bluffer_enabled !== false;
    $('#opt-rule-trapper').checked  = p.rule_trapper_enabled === true;
    const pct = p.key_moment_pct === undefined ? 25 : p.key_moment_pct;
    $('#opt-key-moment').value = pct;
    $('#opt-key-moment-val').textContent = `${pct} %`;
  }

  // ─── Verrouillage ───────────────────────────────────────────

  function renderLock() {
    const collecting = state.party.state === 'collecte';
    $('#lock-btn').classList.toggle('hidden', !collecting);
    // Rouvrir reste possible depuis « prête » : c'est ce qui permet
    // d'accueillir un retardataire ou de refaire une partie avec
    // d'autres morceaux, sans repartir d'une soirée neuve.
    // Rouvrir reste possible tant que la soirée n'est pas archivée :
    // accueillir un retardataire, ajouter un morceau, refaire une
    // partie la semaine suivante.
    $('#unlock-btn').classList.toggle('hidden',
      ['collecte', 'archivee'].includes(state.party.state));

    const below = state.progress.filter(r => !r.meets_minimum);
    $('#lock-hint').textContent = collecting
      ? (below.length
          ? `${below.length} participant(s) sous le minimum : ${below.map(r => r.display_name).join(', ')}. Tu peux verrouiller quand même.`
          : 'Tout le monde a atteint le minimum.')
      : 'La collecte est close. Les morceaux sont numérotés.';
  }

  async function lockParty() {
    const below = state.progress.filter(r => !r.meets_minimum);
    const warning = below.length
      ? `\n\n${below.map(r => `${r.display_name} (${r.tracks_submitted})`).join('\n')}\nsont sous le minimum et joueront quand même.`
      : '';
    if (!confirm('Verrouiller la collecte ?\nPlus personne ne pourra ajouter de morceau.' + warning)) return;

    const { ok, data } = await api('POST', `/api/host/parties/${state.code}/lock`);
    if (!ok) { toast(data.error || 'Verrouillage impossible.', true); return; }
    toast(`${data.numbered} morceaux numérotés.`);
    await loadConsole();
  }

  async function unlockParty() {
    if (!confirm(
      'Rouvrir la collecte ?\n\n' +
      'Les joueurs pourront à nouveau ajouter des morceaux. La numérotation ' +
      'et les vérifications de fichiers seront annulées — il faudra reverrouiller ' +
      'et réapparier ensuite.'
    )) return;

    const { ok, data } = await api('POST', `/api/host/parties/${state.code}/unlock`);
    if (!ok) { toast(data.error || 'Réouverture impossible.', true); return; }
    toast('Collecte rouverte.');
    await loadConsole();
  }

  // ─── H5 — Manifeste ─────────────────────────────────────────

  async function loadManifest() {
    const { ok, data } = await api('GET', `/api/host/parties/${state.code}/manifest`);
    if (!ok) return [];
    state.manifest = data.manifest;
    return data.manifest;
  }

  async function showManifest() {
    const rows = await loadManifest();
    const el = $('#man-list');
    el.classList.remove('hidden');
    el.innerHTML = rows.length
      ? rows.map(r => `
          <div class="report-line">
            <span class="no">${String(r.acquisition_no).padStart(3, '0')}</span>
            <span class="grow">${esc(r.artist)} — ${esc(r.title)}</span>
            <span class="sub">${esc(r.proposed_by)}</span>
          </div>`).join('')
      : '<p class="empty">Verrouille d\'abord la collecte.</p>';
  }

  /**
   * Export d'un fichier.
   *
   * On passe par fetch plutôt qu'un lien direct : le hostToken doit
   * voyager en en-tête, ce qu'un <a href> ne permet pas.
   */
  async function download(format, filename) {
    // L'export complet a sa propre route ; les autres formats passent
    // par le manifeste.
    const url = format === '__export__'
      ? `/api/host/parties/${state.code}/export`
      : `/api/host/parties/${state.code}/manifest?format=${format}`;
    const res = await fetch(url, { headers: { 'X-Host-Token': state.hostToken } });
    if (!res.ok) { toast('Export impossible.', true); return; }
    const blob = await res.blob();
    if (blob.size === 0) { toast('Aucune URL disponible pour ces morceaux.', true); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ─── Sauvegarde ─────────────────────────────────────────────

  async function exportParty() {
    await download('__export__', `soiree-${state.code}.json`);
  }

  /**
   * Importe une sauvegarde comme NOUVELLE soirée.
   *
   * Le fichier ne contient aucun jeton : les participants devront
   * revendiquer leur nom à nouveau. C'est le prix d'une sauvegarde
   * qu'on peut transmettre sans risque.
   */
  async function importParty(file) {
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch {
      toast('Fichier illisible.', true);
      return;
    }

    const { ok, data } = await api('POST', '/api/host/import', backup);
    if (!ok) { toast(data.error || 'Import impossible.', true); return; }

    saveParty(data.party.code, data.hostToken, data.party.name);
    toast(`${data.imported} morceau(x) importé(s)${data.orphans ? `, ${data.orphans} sans propriétaire` : ''}.`);
    setTimeout(() => { location.href = '/h/' + data.party.code; }, 900);
  }

  // ─── H6 — Vérification des fichiers ─────────────────────────

  /**
   * Confronte un dossier local au manifeste.
   *
   * AUCUN AUDIO NE QUITTE LE POSTE. On lit chaque fichier en mémoire,
   * on en mesure la durée exacte avec decodeAudioData, et on n'envoie
   * au serveur que le numéro et la durée. C'est la durée qui fait le
   * vrai travail : elle détecte qu'on a téléchargé un live ou un remix
   * là où le titre semblait correct.
   *
   * DEUX CHEMINS D'ACCÈS AU DOSSIER :
   *   - showDirectoryPicker (Chrome, Edge) — moderne et propre
   *   - <input webkitdirectory> — repli pour Brave, qui désactive la
   *     File System Access API, et pour Firefox qui ne l'implémente pas
   *
   * Le repli lit exactement les mêmes informations ; il montre juste
   * une boîte de dialogue moins élégante et avertit du nombre de
   * fichiers. On l'utilise dès que l'API moderne est absente.
   */
  async function verifyFolder() {
    if (window.showDirectoryPicker) {
      let dir;
      try { dir = await window.showDirectoryPicker(); }
      catch { return; }                     // annulation utilisateur

      // Mémorisé pour la console de jeu : le même dossier ne sera pas
      // redemandé au moment de lancer la soirée.
      await FolderStore.remember(state.code, dir);
      await processFiles(await FolderStore.listFiles(dir));
      return;
    }
    // Repli : on déclenche un <input type="file" webkitdirectory>.
    $('#folder-input').click();
  }

  /**
   * ════════════════════════════════════════════════════════════
   *  APPARIEMENT — modèle repris de /prepare (v1)
   * ════════════════════════════════════════════════════════════
   *
   *  Trois principes qui font toute la différence à l'usage :
   *
   *  1. ON N'AUTO-ASSIGNE QUE LE CERTAIN. Un appariement douteux
   *     n'est pas appliqué en silence : il devient une question posée
   *     à l'hôte, avec ses candidats classés.
   *
   *  2. SEUL LE NON-RÉSOLU EST À L'ÉCRAN. Les morceaux appariés se
   *     replient dans un dépliant. On ne relit que ce qui reste.
   *
   *  3. UN CLIC SUFFIT. Chaque candidat est un bouton, le meilleur est
   *     mis en avant. Écarter un morceau est une option parmi les
   *     autres, pas une manœuvre séparée.
   *
   *  AUCUN AUDIO NE QUITTE LE POSTE : on lit les tags et on mesure la
   *  durée localement, seuls le nom et la durée partent au serveur.
   * ════════════════════════════════════════════════════════════ */

  const AUTO_THRESHOLD = 0.82;   // au-delà : appariement appliqué sans question
  const AMBIGUITY_GAP  = 0.06;   // écart minimal avec le second candidat

  const EXCLUDE = '__exclude__';
  let mState = null;

  async function processFiles(fileList) {
    const report = $('#verify-report');
    const audioFiles = Array.from(fileList)
      .filter(f => /\.(mp3|m4a|flac|wav|ogg)$/i.test(f.name));

    if (!audioFiles.length) {
      report.innerHTML = '<div class="banner warn">Aucun fichier audio dans ce dossier.</div>';
      return;
    }

    const tracks = await loadManifestTracks();
    if (!tracks.length) {
      report.innerHTML = '<div class="banner warn">Verrouille d\'abord la collecte.</div>';
      return;
    }

    report.innerHTML = `<div class="banner info"><div class="spinner"></div> Lecture de ${audioFiles.length} fichiers…</div>`;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const files = [];
    for (const file of audioFiles) {
      let durationMs = null;
      try {
        const audio = await ctx.decodeAudioData(await file.arrayBuffer());
        durationMs = Math.round(audio.duration * 1000);
      } catch { /* illisible : on garde nom et tags */ }
      const tags = await Matching.readTags(file).catch(() => ({ title: '', artist: '' }));
      files.push({ file, name: file.name, durationMs, tags });
    }
    ctx.close();

    mState = { files, tracks, resolved: new Map(), excluded: new Set() };
    autoResolve();
    renderMatching();
  }

  async function loadManifestTracks() {
    const { ok, data } = await api('GET', `/api/host/parties/${state.code}/tracks`);
    if (ok) renderExcluded(data.excluded || []);
    return ok ? data.tracks : [];
  }

  /**
   * Appariement automatique — uniquement les cas sans ambiguïté.
   *
   * Deux conditions cumulées, comme en v1 : un score élevé ET un écart
   * suffisant avec le second candidat. Un morceau qui hésite entre deux
   * fichiers proches est une question, pas une réponse.
   */
  function autoResolve() {
    const { files, tracks } = mState;

    // Le préfixe numérique reste une certitude quand il existe.
    for (const f of files) {
      const m = f.name.match(/^(\d{1,3})[\s._-]/);
      if (!m) continue;
      const t = tracks.find(x => x.acquisition_no === parseInt(m[1], 10));
      if (t && !mState.resolved.has(t.id)) mState.resolved.set(t.id, f);
    }

    // Puis par score, du plus sûr au moins sûr.
    const ranked = tracks
      .filter(t => !mState.resolved.has(t.id))
      .map(t => ({ t, cands: candidatesFor(t) }))
      .sort((a, b) => (b.cands[0]?.score || 0) - (a.cands[0]?.score || 0));

    for (const { t, cands } of ranked) {
      const free = cands.filter(c => !isFileUsed(c.file));
      if (!free.length) continue;
      const [best, second] = free;
      const sure = best.score >= AUTO_THRESHOLD
                && (!second || best.score - second.score >= AMBIGUITY_GAP);
      if (sure) mState.resolved.set(t.id, best.file);
    }
  }

  const isFileUsed = (f) => [...mState.resolved.values()].includes(f);

  /** Candidats d'un morceau, classés par score décroissant. */
  function candidatesFor(track) {
    return mState.files
      .map(f => ({ file: f, score: Matching.score(f, track) }))
      .sort((a, b) => b.score - a.score);
  }

  // ─── Rendu ──────────────────────────────────────────────────

  /**
   * Tableau d'appariement — une ligne par morceau attendu.
   *
   * CHAQUE LIGNE PORTE UNE LISTE DÉROULANTE CONTENANT TOUS LES
   * FICHIERS, sans exception. C'est le point qui manquait : ne
   * proposer que les fichiers « libres » rendait impossible de
   * corriger un appariement automatique erroné, puisque le bon fichier
   * était déjà pris ailleurs.
   *
   * La liste est pré-sélectionnée sur le meilleur candidat et triée
   * par pertinence pour ce morceau-là : le bon choix est presque
   * toujours le premier. Les morceaux non résolus remontent en tête.
   */
  function renderMatching() {
    const { tracks, resolved, excluded } = mState;
    const pending = tracks.filter(t => !resolved.has(t.id) && !excluded.has(t.id));

    $('#verify-report').innerHTML = `
      <div class="match-summary">
        <div class="match-kpi high"><div class="v">${resolved.size}</div><div class="k">appariés</div></div>
        <div class="match-kpi check"><div class="v">${pending.length}</div><div class="k">à résoudre</div></div>
        <div class="match-kpi miss"><div class="v">${excluded.size}</div><div class="k">écartés</div></div>
      </div>
      ${pending.length
        ? '<p class="muted small">Les morceaux sans fichier sont en tête. Choisis dans la liste, ou écarte-les — une playlist plus courte ne bloque pas la soirée.</p>'
        : '<div class="banner good">Tous les morceaux ont un fichier.</div>'}`;

    $('#match-table').classList.remove('hidden');
    $('#match-actions').classList.remove('hidden');

    // Non résolus d'abord : c'est là que se porte l'attention.
    const ordered = tracks.slice().sort((a, b) => {
      const ra = resolved.has(a.id) || excluded.has(a.id);
      const rb = resolved.has(b.id) || excluded.has(b.id);
      if (ra !== rb) return ra ? 1 : -1;
      return a.acquisition_no - b.acquisition_no;
    });

    $('#match-table').innerHTML = ordered.map(renderRow).join('') + renderLeftovers();
    bindMatching();

    // JAMAIS désactivé : l'hôte doit toujours pouvoir enregistrer.
    $('#match-confirm').disabled = false;
    $('#match-confirm').textContent = pending.length
      ? `Enregistrer (${pending.length} sans fichier)`
      : 'Enregistrer l\'appariement';
  }

  const fmtDur = (ms) => ms
    ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`
    : '?';

  function renderRow(track) {
    const chosen = mState.resolved.get(track.id);
    const isExcluded = mState.excluded.has(track.id);

    // Tous les fichiers, classés par pertinence POUR CE MORCEAU.
    const ranked = mState.files
      .map(f => ({ f, score: Matching.score(f, track) }))
      .sort((a, b) => b.score - a.score);

    const options = [
      `<option value="">— aucun fichier —</option>`,
      `<option value="${EXCLUDE}" ${isExcluded ? 'selected' : ''}>— écarter ce morceau —</option>`,
      ...ranked.map(({ f, score }) => {
        // Marquer les fichiers déjà pris ailleurs sans les retirer :
        // les cacher empêcherait toute correction.
        const takenBy = takenElsewhere(f, track.id);
        const flag = takenBy ? ' ⟲ déjà utilisé' : '';
        return `<option value="${esc(f.name)}" ${chosen && chosen.name === f.name ? 'selected' : ''}>
          ${Math.round(score * 100)}% · ${esc(f.tags.title || f.name)}${f.tags.artist ? ' — ' + esc(f.tags.artist) : ''} · ${fmtDur(f.durationMs)}${flag}
        </option>`;
      }),
    ].join('');

    let cls = 'none', label = 'sans fichier';
    if (isExcluded) { cls = 'excluded'; label = 'écarté'; }
    else if (chosen) {
      const gap = (chosen.durationMs && track.duration_ms)
        ? Math.abs(chosen.durationMs - track.duration_ms) : 0;
      if (gap > Matching.DURATION_TOLERANCE_MS) {
        cls = 'medium'; label = `${Math.round(gap / 1000)} s d'écart`;
      } else {
        cls = 'high'; label = 'apparié';
      }
    }

    return `
      <div class="match-row ${cls}">
        <span class="match-no">${String(track.acquisition_no).padStart(3, '0')}</span>
        <span class="match-expected">
          ${esc(track.title)}
          <span class="sub">${esc(track.artist)} · ${fmtDur(track.duration_ms)} · ${esc(track.proposed_by)}</span>
        </span>
        <span class="match-arrow">←</span>
        <span class="match-file">
          <select data-track="${esc(track.id)}">${options}</select>
        </span>
        <span class="match-badge">${esc(label)}</span>
      </div>`;
  }

  /** Ce fichier est-il déjà attribué à un AUTRE morceau ? */
  function takenElsewhere(file, trackId) {
    for (const [id, f] of mState.resolved) {
      if (id !== trackId && f === file) return id;
    }
    return null;
  }

  function renderLeftovers() {
    const used = new Set(mState.resolved.values());
    const left = mState.files.filter(f => !used.has(f));
    if (!left.length) return '';
    return `
      <details class="match-done-box" style="margin-top:.7rem">
        <summary>Fichiers non utilisés (${left.length})</summary>
        <div style="margin-top:.5rem">${left.map(f =>
          `<div class="report-line"><span class="grow">${esc(f.name)}</span>
           <span class="sub">${esc(f.tags.artist || '')} ${esc(f.tags.title || '')} · ${fmtDur(f.durationMs)}</span></div>`
        ).join('')}</div>
      </details>`;
  }

  function bindMatching() {
    $('#match-table').querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', () => {
        const trackId = sel.dataset.track;
        const v = sel.value;

        if (v === EXCLUDE) {
          mState.excluded.add(trackId);
          mState.resolved.delete(trackId);
        } else if (!v) {
          mState.excluded.delete(trackId);
          mState.resolved.delete(trackId);
        } else {
          const f = mState.files.find(x => x.name === v);
          // Un fichier ne sert qu'une fois : on le libère de son
          // ancienne ligne plutôt que de laisser un doublon silencieux.
          for (const [id, other] of [...mState.resolved]) {
            if (other === f && id !== trackId) mState.resolved.delete(id);
          }
          mState.resolved.set(trackId, f);
          mState.excluded.delete(trackId);
        }
        renderMatching();
      });
    });
  }

  // ─── Enregistrement ─────────────────────────────────────────

  /**
   * Enregistre l'appariement.
   *
   * Les morceaux restés sans fichier sont ÉCARTÉS, après confirmation :
   * une playlist plus courte que prévu ne doit jamais empêcher de
   * lancer la soirée. C'est le comportement attendu quand un
   * téléchargement a échoué et qu'on veut jouer quand même.
   */
  async function confirmMatch() {
    const { tracks, resolved, excluded } = mState;
    const orphans = tracks.filter(t => !resolved.has(t.id) && !excluded.has(t.id));

    if (orphans.length) {
      const list = orphans.slice(0, 6).map(t => `· ${t.artist} — ${t.title}`).join('\n');
      const more = orphans.length > 6 ? `\n… et ${orphans.length - 6} autre(s)` : '';
      if (!confirm(
        `${orphans.length} morceau(x) sans fichier :\n\n${list}${more}\n\n` +
        `Ils seront écartés de la playlist. La soirée se jouera avec ` +
        `${resolved.size} morceau(x). Continuer ?`
      )) return;
      orphans.forEach(t => excluded.add(t.id));
    }

    // On ne fabrique une vignette QUE pour les morceaux qui n'en ont
    // pas : convertir une pochette coûte un décodage d'image, inutile
    // quand l'API en a déjà fourni une.
    const files = [];
    for (const [trackId, f] of resolved) {
      const track = tracks.find(t => t.id === trackId);
      const entry = { trackId, fileName: f.name, durationMs: f.durationMs };

      if (track && !track.artwork_url && f.tags && f.tags.picture) {
        entry.artworkUrl = await Matching.pictureToDataUrl(f.tags.picture);
      }
      if (track && !track.album && f.tags && f.tags.album) entry.album = f.tags.album;
      files.push(entry);
    }
    for (const trackId of excluded) {
      await api('POST', `/api/host/parties/${state.code}/tracks/${trackId}/exclude`);
    }

    const { ok, data } = await api('POST', `/api/host/parties/${state.code}/reconcile`, { files });
    if (!ok) { toast(data.error || 'Enregistrement impossible.', true); return; }

    await loadConsole();
    if (data.ready) {
      $('#match-table').classList.add('hidden');
      $('#match-actions').classList.add('hidden');
      renderReport(data);
      toast(`Prêt — ${data.verified.length} morceau(x) jouables.`);
      return;
    }
    // Écart de durée sur certaines lignes : on garde le tableau ouvert
    // pour corriger, plutôt que de renvoyer l'hôte au point de départ.
    mState.tracks = await loadManifestTracks();
    renderMatching();
    $('#verify-report').insertAdjacentHTML('afterbegin',
      `<div class="banner warn">${data.mismatched.length} durée(s) incohérente(s) — vérifie les lignes signalées.</div>`);
  }

  /** Remet dans la playlist un morceau précédemment écarté. */
  async function restoreTrack(trackId) {
    await api('POST', `/api/host/parties/${state.code}/tracks/${trackId}/restore`);
    toast('Morceau réintégré.');
    await loadConsole();
  }

  /** Les morceaux écartés restent visibles et réintégrables. */
  function renderExcluded(list) {
    const zone = $('#excluded-zone');
    zone.classList.toggle('hidden', list.length === 0);
    if (!list.length) return;
    $('#excluded-list').innerHTML = list.map(t => `
      <div class="line" style="--c:${esc(t.color)};opacity:.7">
        <span class="grow">${esc(t.artist)} — ${esc(t.title)}<span class="sub">${esc(t.proposed_by)}</span></span>
        <button class="btn ghost sm" data-restore="${esc(t.id)}">Réintégrer</button>
      </div>`).join('');
    $('#excluded-list').querySelectorAll('[data-restore]').forEach(b =>
      b.addEventListener('click', () => restoreTrack(b.dataset.restore)));
  }

  function renderReport(r) {
    const parts = [];
    parts.push(r.ready
      ? `<div class="banner good">✓ ${r.verified.length} fichiers vérifiés. La soirée est prête.</div>`
      : `<div class="banner warn">${r.verified.length} sur ${r.total} vérifiés — il reste ${r.missing.length + r.mismatched.length} problème(s).</div>`);

    if (r.mismatched.length) {
      parts.push('<div class="eyebrow" style="margin-top:.9rem">Durée incohérente</div>');
      parts.push(r.mismatched.map(m => `
        <div class="report-line">
          <span class="no">${String(m.acquisition_no).padStart(3, '0')}</span>
          <span class="grow">${esc(m.artist)} — ${esc(m.title)}</span>
          <span class="sub" style="color:var(--danger)">${esc(m.reason)}</span>
        </div>`).join(''));
    }
    if (r.missing.length) {
      parts.push('<div class="eyebrow" style="margin-top:.9rem">Fichiers absents</div>');
      parts.push(r.missing.map(m => `
        <div class="report-line">
          <span class="no">${String(m.acquisition_no).padStart(3, '0')}</span>
          <span class="grow">${esc(m.artist)} — ${esc(m.title)}</span>
        </div>`).join(''));
    }
    $('#verify-report').innerHTML = parts.join('');
  }

  // ═══════════════════════════════════════════════════════════
  //  Amorçage
  // ═══════════════════════════════════════════════════════════

  function bind() {
    $('#np-create').addEventListener('click', createParty);
    $('#np-name').addEventListener('keydown', e => { if (e.key === 'Enter') createParty(); });

    // Quota : on écrit sur « change », pas sur chaque frappe.
    $('#q-min').addEventListener('change', (e) =>
      saveSetting({ minTracks: Number(e.target.value) }, 'Minimum enregistré.'));
    $('#q-max').addEventListener('change', (e) =>
      saveSetting({ maxTracks: Number(e.target.value) }, 'Maximum enregistré.'));

    // Options de jeu.
    $('#opt-hide-indices').addEventListener('change', (e) =>
      saveSetting({ hideIndices: e.target.checked }));
    $('#opt-rule-bluffer').addEventListener('change', (e) =>
      saveSetting({ blufferRule: e.target.checked }));
    $('#opt-rule-trapper').addEventListener('change', (e) =>
      saveSetting({ trapperRule: e.target.checked }));
    // input pour le retour visuel immédiat, change pour l'écriture :
    // enregistrer à chaque pixel de glissement noierait le serveur.
    $('#opt-key-moment').addEventListener('input', (e) => {
      $('#opt-key-moment-val').textContent = `${e.target.value} %`;
    });
    $('#opt-key-moment').addEventListener('change', (e) =>
      saveSetting({ keyMomentPct: Number(e.target.value) }));

    $('#step-prev').addEventListener('click', () => goStep(currentStep - 1));
    $('#step-next').addEventListener('click', () => goStep(currentStep + 1));

    $('#lock-btn').addEventListener('click', lockParty);
    $('#unlock-btn').addEventListener('click', unlockParty);

    $('#man-csv').addEventListener('click', () => download('csv', `playlist-${state.code}.csv`));
    $('#man-urls').addEventListener('click', () => download('urls', `urls-${state.code}.txt`));
    $('#export-party').addEventListener('click', exportParty);
    $('#import-btn').addEventListener('click', () => $('#import-input').click());
    $('#import-input').addEventListener('change', (e) => {
      if (e.target.files[0]) importParty(e.target.files[0]);
      e.target.value = '';
    });
    $('#man-show').addEventListener('click', showManifest);
    $('#verify-btn').addEventListener('click', verifyFolder);
    $('#match-confirm').addEventListener('click', confirmMatch);
    $('#match-cancel').addEventListener('click', () => {
      $('#match-table').classList.add('hidden');
      $('#match-actions').classList.add('hidden');
      $('#verify-report').innerHTML = '';
      mState = null;
    });

    // Actualiser la vue : la collecte évolue pendant qu'on regarde
    // l'écran, sans que rien ne la pousse.
    $('#btn-refresh').addEventListener('click', () => loadConsole().then(() => toast('Actualisé.')));
    $('#folder-input').addEventListener('change', (e) => {
      if (e.target.files.length) processFiles(e.target.files);
      e.target.value = '';   // permet de resélectionner le même dossier
    });

    $('#c-copy').addEventListener('click', async () => {
      const url = shareUrl();
      try { await navigator.clipboard.writeText(url); toast('Lien copié.'); }
      catch {
        // clipboard indisponible hors HTTPS : on sélectionne pour que
        // l'hôte n'ait plus qu'à faire Ctrl+C.
        const range = document.createRange();
        range.selectNodeContents($('#c-url'));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        toast('Sélectionne et copie le lien.');
      }
    });
  }

  function boot() {
    bind();
    const m = location.pathname.match(/^\/h\/([A-Za-z0-9]+)/);
    if (!m) {
      renderPick();
      // Vérification en arrière-plan : l'affichage est immédiat, la
      // liste se corrige une seconde plus tard si besoin.
      pruneDeleted().then(n => { if (n) renderPick(); });
      return;
    }

    state.code = m[1].toUpperCase();
    const known = loadParties()[state.code];
    if (!known) {
      toast('Cette soirée n\'a pas été créée depuis ce navigateur.', true);
      renderPick();
      return;
    }
    state.hostToken = known.hostToken;
    loadConsole();
  }

  boot();
})();
