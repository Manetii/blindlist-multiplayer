/**
 * ════════════════════════════════════════════════════════════════
 *  CONSOLE DE JEU — hôte
 * ════════════════════════════════════════════════════════════════
 *
 *  Pilote une soirée : lecture audio locale, manches, révélation,
 *  scoring, podium.
 *
 *  LE SERVEUR NE LANCE JAMAIS UN MORCEAU. Quand un automatisme mûrit
 *  côté serveur (tout le monde a voté, tout le monde est prêt), il
 *  émet un HOST_CUE ; c'est ce poste qui exécute. Le PC perd
 *  l'initiative, pas le contrôle — et l'audio ne quitte jamais le
 *  disque de l'hôte.
 *
 *  Le dossier est rechargé à chaque session : les objets File ne sont
 *  pas persistables, et les handles de la File System Access API ne le
 *  sont qu'en IndexedDB et pas dans tous les navigateurs. Redemander
 *  le dossier coûte un clic et fonctionne partout.
 * ════════════════════════════════════════════════════════════════
 */

(() => {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  /**
   * PANNEAUX — repris de panels.js (v1).
   *
   * L'état vit dans localStorage et se reflète en classes sur <body> :
   * c'est ce qui permet au vinyle et au titre de réagir à l'ouverture
   * des panneaux sans que le JS ait à les toucher.
   */
  const Panels = (() => {
    const KEY = 'blindtest:panels';
    const MOBILE = 900;
    let st = { players: false, playlist: true };

    const isMobile = () => window.innerWidth < MOBILE;

    function init() {
      try {
        const saved = JSON.parse(localStorage.getItem(KEY));
        if (saved && typeof saved === 'object' && !isMobile()) {
          st.players = !!saved.players; st.playlist = !!saved.playlist;
        } else if (isMobile()) {
          st.players = false; st.playlist = false;
        }
      } catch { /* stockage indisponible */ }
      apply();

      // Le passage desktop → mobile ferme tout : deux panneaux
      // superposés en plein écran seraient inutilisables.
      let was = isMobile();
      window.addEventListener('resize', () => {
        const now = isMobile();
        if (now !== was) { was = now; if (now) closeAll(); }
      });
    }

    function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} }
    function toggle(p) { st[p] = !st[p]; save(); apply(); }
    function close(p)  { if (st[p]) { st[p] = false; save(); apply(); } }
    function closeAll() { st.players = false; st.playlist = false; save(); apply(); }
    const isAnyOpen = () => st.players || st.playlist;

    /** Mode TV : tout fermer si quelque chose est ouvert, tout ouvrir sinon. */
    function toggleAll() {
      if (isAnyOpen()) closeAll();
      else { st.players = true; st.playlist = true; save(); apply(); }
    }

    function apply() {
      document.body.classList.toggle('panel-players-open',  st.players);
      document.body.classList.toggle('panel-playlist-open', st.playlist);
      document.body.classList.toggle('panels-all-closed',   !isAnyOpen());

      const tp = $('#tab-players'), tl = $('#tab-playlist'), tv = $('#btn-mode-tv');
      if (tp) tp.classList.toggle('active', st.players);
      if (tl) tl.classList.toggle('active', st.playlist);
      if (tv) {
        tv.classList.toggle('active', !isAnyOpen());
        tv.title = isAnyOpen()
          ? 'Mode TV : fermer tous les panneaux'
          : 'Sortir du Mode TV : ouvrir les panneaux';
      }
    }

    return { init, toggle, close, closeAll, toggleAll, isAnyOpen };
  })();

  const S = {
    code: null, hostToken: null, socket: null,
    sort: 'no', anonymize: true, settings: {},
    party: null, tracks: [], players: [],
    round: null,          // { trackId, roundId, track, startOffsetMs }
    votes: [],
    adjustments: new Map(),
    computed: null,
    paused: false,
  };

  let toastTimer;
  /**
   * Moteur de lecture, choisi une fois pour toutes au démarrage.
   *
   * Les deux moteurs exposent le même contrat : le reste de la console
   * ne sait pas lequel elle pilote. C'est ce qui permet aux deux modes
   * de coexister sans que la logique de partie connaisse la différence.
   */
  let Engine = window.AudioEngine;
  const isYouTube = () => Engine === window.YouTubeEngine;

  /** Réf. de lecture d'un morceau : un fichier, ou un identifiant vidéo. */
  function playRef(t) {
    if (!t) return null;
    // En mode YouTube, source_id EST l'identifiant de vidéo : le
    // serveur l'a extrait et vérifié à la collecte, il n'y a pas à le
    // redéduire de l'URL ici.
    return isYouTube() ? (t.source_id || null) : t.file_name;
  }

  function status(msg, kind) {
    const el = $('#game-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'game-status ' + (kind || '');
  }

  function toast(msg, bad = false) {
    status(msg, bad ? 'error' : 'success');
    setTimeout(() => status(''), 3000);
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (bad ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
  }

  const view = (n) => $$('[data-view]').forEach(v => v.classList.toggle('active', v.dataset.view === n));

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Host-Token': S.hostToken },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return { ok: false, data: {} }; }
    let data = null;
    try { data = await res.json(); } catch { /* vide */ }
    return { ok: res.ok, data: data || {} };
  }

  // ═══════════════════════════════════════════════════════════
  //  1. Chargement du dossier
  // ═══════════════════════════════════════════════════════════

  async function pickFolder() {
    if (window.showDirectoryPicker) {
      let dir;
      try { dir = await window.showDirectoryPicker(); } catch { return; }
      await FolderStore.remember(S.code, dir);
      onFolder(await FolderStore.listFiles(dir));
      return;
    }
    // Repli pour Brave et Firefox, qui n'ont pas la File System Access API.
    $('#g-folder-input').click();
  }

  /**
   * Tente de reprendre le dossier déjà désigné pendant la préparation.
   *
   * Deux temps : d'abord en silence si la permission est encore
   * accordée, sinon on propose un bouton qui la redemande — un clic de
   * confirmation au lieu d'un sélecteur complet.
   */
  async function tryRecallFolder() {
    if (!FolderStore.supported()) return false;

    const silent = await FolderStore.recall(S.code);
    if (silent) {
      onFolder(await FolderStore.listFiles(silent));
      // Notification, pas bandeau : une bonne nouvelle n'a pas à rester
      // à l'écran toute la soirée. Seuls les problèmes persistent, parce
      // qu'eux demandent une action.
      toast('Dossier retrouvé depuis la préparation.');
      return true;
    }

    const stored = await FolderStore.recall(S.code, { ask: false });
    if (stored === null) {
      // Un handle existe peut-être mais sans permission : on propose de
      // la réactiver plutôt que de refaire tout le parcours.
      $('#g-folder-report').innerHTML =
        '<div class="banner info">Un dossier a été utilisé pendant la préparation. ' +
        '<button class="btn-key-moment" id="g-folder-recall" style="margin-left:.5rem">Le réutiliser</button></div>';
      const btn = $('#g-folder-recall');
      if (btn) btn.addEventListener('click', async () => {
        const dir = await FolderStore.recall(S.code, { ask: true });
        if (!dir) { toast('Dossier introuvable — choisis-le à nouveau.', true); return; }
        onFolder(await FolderStore.listFiles(dir));
      });
    }
    return false;
  }

  function onFolder(fileList) {
    const { indexed, ignored } = AudioEngine.loadFiles(fileList);
    const expected = S.tracks.map(t => t.file_name);
    const missing = AudioEngine.missing(expected);
    const el = $('#g-folder-report');

    if (!indexed) {
      el.innerHTML = '<div class="banner bad">Aucun fichier audio dans ce dossier.</div>';
      return;
    }

    // Sans ce rendu, la playlist gardait les états calculés AVANT le
    // chargement : tous les morceaux marqués « absent », donc ni
    // cliquables ni écoutables jusqu'au prochain rafraîchissement.
    renderAll();

    /*
     * Succès : une notification, pas un bandeau.
     *
     * « Playlist complète » est une confirmation ponctuelle. L'afficher
     * en permanence occupait le panneau pour redire ce que la liste
     * montre déjà — aucun morceau marqué absent.
     *
     * Échec partiel : le bandeau reste, lui. Nommer les fichiers
     * manquants n'a d'intérêt que si l'hôte peut y revenir, ce qui
     * suppose de pouvoir les relire.
     */
    if (missing.length) {
      el.innerHTML =
        `<div class="banner warn">${indexed} fichier(s) chargé(s), mais ${missing.length} introuvable(s) :
           ${missing.filter(Boolean).map(n => `<code>${n}</code>`).join(', ') || '(nom non enregistré)'}.
           Ces morceaux seront ignorés pendant la partie.</div>`;
    } else {
      el.innerHTML = '';
      toast(`${indexed} fichier(s) chargé(s) — playlist complète.`);
    }
    if (ignored) toast(`${ignored} fichier(s) sans numéro ignoré(s).`);
  }

  // ═══════════════════════════════════════════════════════════
  //  2. Ouverture du salon
  // ═══════════════════════════════════════════════════════════

  function openRoom() {
    if (S.socket) { emitOpen(); return; }
    S.socket = io();
    wire();
    S.socket.on('connect', () => { setConn(true); emitOpen(); });
    S.socket.on('disconnect', () => setConn(false));
  }

  function emitOpen() {
    S.socket.emit(EVENTS.HOST_OPEN_ROOM, { code: S.code, hostToken: S.hostToken }, (res) => {
      if (!res || !res.ok) { toast((res && res.error) || 'Ouverture impossible.', true); return; }

      S.party = res.state.room;
      S.settings = res.state.room.settings || {};

      // PERSISTANCE : après un rafraîchissement de la page, on retrouve
      // les morceaux déjà joués. Les scores, eux, arrivent avec les
      // joueurs — ils viennent du journal en base.
      played.clear();
      for (const id of (res.state.room.playedTrackIds || [])) played.add(id);
      renderOptions();
      S.players = res.state.players;
      S.tracks = res.tracks;
      S.name = res.state.room.name;
      S.sourceMode = res.state.room.sourceMode || 'fichiers';
      selectEngine();
      renderRoomStatus();
      $('#g-code').textContent = res.state.room.code;
      renderRejoinQR();
      S.paused = res.state.room.paused;

      // Reprise après coupure : le serveur dit ce qui reste à faire.
      const pending = res.pending || {};
      if (pending.action === 'reveal') {
        toast('Reprise : tous ont voté, il reste à révéler.');
        S.votes = pending.votes || [];
      } else if (pending.action === 'scores') {
        toast('Reprise : le scoring de la dernière manche n\'a pas été validé.');
      }

      if (res.state.round && res.state.round.active) {
        S.round = { roundId: null, trackId: res.state.round.trackId,
                    track: S.tracks.find(t => t.id === res.state.round.trackId) };
        S.votes = res.state.round.votes || S.votes;
      }

      renderAll();
      view('game');
    });
  }

  /**
   * État du salon dans la barre du haut.
   *
   * Un seul endroit dit désormais où en est la salle : connexion,
   * salon ouvert et manche en cours étaient exposés à trois endroits
   * différents de l'écran.
   */
  function setConn(on) {
    S.connected = on;
    renderRoomStatus();
  }

  /**
   * QR de secours, au pied du panneau joueurs.
   *
   * Chargé à la demande et une seule fois : un appel réseau au
   * démarrage du lecteur pour une image qui ne sert qu'en cas de
   * pépin serait mal placé.
   */
  let qrDone = false;
  function renderRejoinQR() {
    const el = $('#g-qr');
    if (!el || qrDone || !S.code) return;
    qrDone = true;
    const url = `${location.origin}/j/${S.code}`;
    const img = new Image();
    img.alt = 'QR code pour rejoindre la soirée';
    img.onload = () => { el.innerHTML = ''; el.appendChild(img); };
    img.onerror = () => {
      el.innerHTML = '<div class="fallback">QR indisponible hors ligne — dicte le code.</div>';
    };
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=6&data='
            + encodeURIComponent(url);
  }

  /**
   * Aiguille vers le bon moteur, et adapte le lecteur en conséquence.
   *
   * En mode YouTube il n'y a pas de dossier à charger : le pied du
   * panneau playlist perd ses commandes de fichier, et le vinyle cède
   * la place à un rappel de la fenêtre de lecture.
   */
  function selectEngine() {
    const youtube = S.sourceMode === 'youtube';
    Engine = youtube ? window.YouTubeEngine : window.AudioEngine;
    document.body.classList.toggle('mode-youtube', youtube);

    if (!youtube) return;

    Engine.onNeedWindow(() => {
      status('La fenêtre de lecture est fermée — rouvre-la pour continuer.', 'error');
      $('#yt-reopen').classList.remove('hidden');
    });
    Engine.onEnded(() => { if (S.round) status('Morceau terminé.'); });
  }

  /**
   * Ouvre la fenêtre de lecture si besoin.
   *
   * Appelée depuis le clic de lancement, jamais au chargement : les
   * navigateurs bloquent toute ouverture de fenêtre qui ne descend pas
   * d'un geste de l'utilisateur.
   */
  async function ensurePlayerWindow() {
    if (!isYouTube() || Engine.isOpen()) return true;
    const ok = await Engine.openWindow().catch(() => false);
    if (!ok) {
      status('Autorise les fenêtres surgissantes pour ce site, puis réessaie.', 'error');
      $('#yt-reopen').classList.remove('hidden');
      return false;
    }
    $('#yt-reopen').classList.add('hidden');
    return true;
  }

  function renderRoomStatus() {
    RoomStatus.render($('#g-status'), {
      name: S.name || 'Soirée',
      connected: S.connected !== false,
      roomOpen: true,
      roundActive: !!(S.round && S.round.active !== false),
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  3. Événements serveur
  // ═══════════════════════════════════════════════════════════

  function wire() {
    S.socket.on(EVENTS.STATE_PLAYERS, (players) => { S.players = players; renderPlayers(); });
    S.socket.on(EVENTS.STATE_SCORES,  (players) => { S.players = players; renderPlayers(); });

    S.socket.on(EVENTS.STATE_VOTE_PROGRESS, (t) => {
      // Les votes restent en mémoire pour le calcul des points, mais ne
      // sont plus affichés : seul le compte l'est.
      S.votes = t.votes || [];
      // La liste porte l'attente : sans ce marquage, un vote entrant
      // n'aurait plus rien fait bouger à l'écran.
      if (Array.isArray(t.pendingIds)) {
        for (const p of S.players) p.voted = t.pendingIds.indexOf(p.id) === -1;
        renderPlayers();
      }
      setWaitKpi(t.voted, t.connected, 'vote');
      if (S.round && !S.round.revealed) {
        renderWaitingFor({ done: t.voted, connected: t.connected, pending: t.pending }, 'vote');
        // Manche enlisée : l'attente n'aboutira pas toute seule. On le
        // dit sans rien décider à la place de l'hôte.
        if (t.stalled) {
          status(`${(t.pending || []).join(', ')} n'${(t.pending || []).length > 1 ? 'ont' : 'a'} `
               + 'toujours pas voté — révèle quand tu veux (R).', 'error');
        }
      }
    });

    S.socket.on(EVENTS.STATE_COUNTDOWN, ({ seconds }) => {
      // L'hôte voit aussi le décompte : il sait que le morceau part et
      // n'appuie pas sur « lancer » en même temps.
      status(seconds ? `Lancement dans ${seconds} s…` : '', seconds ? 'success' : '');
    });

    S.socket.on(EVENTS.STATE_READY_PROGRESS, (t) => {
      setWaitKpi(t.ready, t.connected, 'ready');
      // Pendant une manche non révélée, c'est l'attente des votes qui
      // compte : ne pas écraser ce message.
      if (!S.round || S.round.revealed) {
        renderWaitingFor({ done: t.ready, connected: t.connected, pending: t.pending }, 'ready');
      }
    });

    /**
     * Signal d'automatisme. Le serveur a constaté une condition ; c'est
     * nous qui agissons, parce que l'audio et la réponse sont ici.
     */
    S.socket.on(EVENTS.HOST_CUE, ({ action, reason }) => {
      if (action === 'reveal' && S.round) { toast(`Révélation — ${reason}`); doReveal(); }
      if (action === 'advance' && !S.round) { toast(`Manche suivante — ${reason}`); startRound(); }
    });

    // Votes rattrapés après la fenêtre de grâce : on recalcule les
    // points sans que l'hôte ait à refermer et rouvrir la modale.
    S.socket.on(EVENTS.STATE_REVEAL, ({ votes, final }) => {
      if (!final) return;
      S.votes = votes || S.votes;
      if ($('#overlay').classList.contains('open') && S.answer) {
        S.computed = Scoring.compute(S.votes, S.answer.playerId, {
          blufferRule: S.settings.blufferRule !== false,
          trapperRule: S.settings.trapperRule === true,
        });
        renderScores();
        toast('Vote(s) de dernière seconde pris en compte.');
      }
    });

    // Les règles se changent depuis la console pendant que le lecteur
    // est ouvert : sans cette écoute, il continuerait de calculer les
    // points avec l'ancienne jusqu'au prochain rechargement.
    S.socket.on(EVENTS.STATE_SETTINGS, ({ settings }) => {
      S.settings = settings || S.settings;
      renderOptions();
      toast('Règles mises à jour depuis la console.');
    });

    S.socket.on(EVENTS.STATE_GAME_OVER, ({ standings }) => renderPodium(standings));
    S.socket.on(EVENTS.ERROR, (m) => toast(String(m), true));
  }

  // ═══════════════════════════════════════════════════════════
  //  4. Déroulement d'une manche
  // ═══════════════════════════════════════════════════════════

  async function startRound(trackId) {
    // La fenêtre de lecture doit exister AVANT d'annoncer la manche au
    // serveur : ouvrir après coup laisserait les joueurs sur un écran
    // de vote sans avoir rien entendu.
    if (!(await ensurePlayerWindow())) return;

    // Ne proposer que des morceaux réellement présents sur le disque :
    // lancer une manche sans fichier bloquerait la partie.
    const playable = S.tracks.filter(t =>
      Engine.has(playRef(t)) && !isPlayed(t.id));
    if (!playable.length) { toast('Plus aucun morceau jouable.', true); return; }

    const chosen = trackId
      ? S.tracks.find(t => t.id === trackId)
      : playable[Math.floor(Math.random() * playable.length)];

    S.socket.emit(EVENTS.HOST_START_ROUND, { trackId: chosen.id }, async (res) => {
      if (!res || !res.ok) {
        // Playlist épuisée : on montre le classement plutôt qu'une
        // erreur. C'est la fin normale d'une partie.
        if (res && res.gameOver) { renderPodiumFromServer(); return; }
        toast((res && res.error) || 'Lancement impossible.', true);
        return;
      }
      S.round = { roundId: res.roundId, trackId: chosen.id, track: chosen,
                  startOffsetMs: res.startOffsetMs };
      S.votes = [];
      S.adjustments.clear();
      setWaitKpi(0, S.players.filter(p => p.connected).length, 'vote');

      try {
        await Engine.play(playRef(chosen), res.startOffsetMs);
      } catch (err) {
        toast(err.message, true);
      }
      renderAll();
    });
  }

  async function doReveal() {
    if (!S.round) return;
    const t = S.round.track;

    // LA MUSIQUE CONTINUE, À PLEIN VOLUME. Couper — ou même baisser —
    // au moment de la révélation retire au morceau son moment le plus
    // agréable : celui où l'on peut enfin l'écouter en sachant ce que
    // c'est.

    const answer = {
      title: t.title, artist: t.artist, album: t.album,
      artworkUrl: t.artwork_url,
      player: t.proposed_by, playerId: t.proposed_by_id, color: t.color,
    };

    S.socket.emit(EVENTS.HOST_REVEAL, answer, (res) => {
      if (!res || !res.ok) { toast((res && res.error) || 'Révélation impossible.', true); return; }
      S.votes = res.votes || S.votes;
      openRevealModal(answer);
    });
  }

  function openRevealModal(answer) {
    const color = answer.color || '#00e5ff';
    $('#rc-title').textContent  = answer.title || '—';
    $('#rc-artist').textContent = answer.artist || 'Artiste inconnu';
    $('#rc-player').textContent = answer.player || '—';
    $('#rc-dot').style.setProperty('--rc-color', color);

    const art = $('#reveal-art'), ph = $('#reveal-art-placeholder');
    if (answer.artworkUrl) {
      art.src = answer.artworkUrl; art.style.display = 'block'; ph.style.display = 'none';
    } else {
      art.style.display = 'none'; ph.style.display = 'flex';
    }

    S.computed = Scoring.compute(S.votes, answer.playerId, {
      blufferRule: S.settings.blufferRule !== false,
      trapperRule: S.settings.trapperRule === true,
    });
    S.adjustments.clear();
    S.answer = answer;
    renderScores();
    $('#overlay').classList.add('open');
  }

  /**
   * Détail des points, ajustable avant validation.
   *
   * L'hôte voit POURQUOI chaque joueur marque, pas seulement combien :
   * c'est ce qui permet d'arbitrer un cas limite sans recalculer de
   * tête, et de justifier à la table.
   */
  function renderScores() {
    // Bloc 1 — le détail des votes, repris de la v1 : c'est ce que
    // l'hôte lit à voix haute à la table.
    const ownerId = (S.answer || {}).playerId;
    const votesHtml = S.votes.length
      ? S.votes.map(v => {
          const good = v.votedId === ownerId;
          return `<div class="sc-vote-row ${good ? 'sc-correct' : 'sc-wrong'}">
            <span class="sc-voter">${esc(v.voter)}</span>
            <span class="sc-arrow">→</span>
            <span class="sc-voted">${esc(v.voted)}</span>
            <span class="sc-mark">${good ? '✓' : '✗'}</span>
          </div>`;
        }).join('')
      : '<div class="empty-mini">Personne n\'a voté.</div>';

    const rows = S.players.map(p => {
      const base = S.computed.byPlayer.get(p.id);
      const adj = S.adjustments.get(p.id) || 0;
      const total = (base ? base.total : 0) + adj;
      const why = base ? Scoring.explain(base.reasons) : '';
      return { p, total, why, adj };
    }).filter(r => r.total !== 0 || r.why || r.adj);

    const scoresHtml = rows.length
      ? rows.map(r => `
          <div class="sc-player-row" style="--c:${esc(r.p.color)}">
            <span class="sc-player-name">
              ${esc(r.p.name)}
              <span class="sc-why">${esc(r.why || 'aucun point')}${r.adj ? ` · ajusté ${r.adj > 0 ? '+' : ''}${r.adj}` : ''}</span>
            </span>
            <span class="sc-adj">
              <button data-adj="-1" data-id="${esc(r.p.id)}">−</button>
              <button data-adj="1"  data-id="${esc(r.p.id)}">+</button>
            </span>
            <span class="sc-pts ${r.total === 0 ? 'zero' : ''}">${r.total > 0 ? '+' : ''}${r.total}</span>
          </div>`).join('')
      : '<div class="empty-mini">Aucun point cette manche.</div>';

    $('#scoring-panel').innerHTML = `
      <div class="sc-section">
        <div class="sc-section-label">Votes</div>
        <div class="sc-votes">${votesHtml}</div>
      </div>
      <div class="sc-section">
        <div class="sc-section-label">Points <span class="sc-hint">ajustables</span></div>
        ${scoresHtml}
      </div>`;

    $('#scoring-panel').querySelectorAll('[data-adj]').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.id;
        S.adjustments.set(id, (S.adjustments.get(id) || 0) + Number(b.dataset.adj));
        renderScores();
      });
    });
  }

  function validateScores() {
    const events = Scoring.withAdjustments(S.computed.events, S.adjustments);
    S.socket.emit(EVENTS.HOST_APPLY_SCORES, { events }, (res) => {
      if (!res || !res.ok) { toast('Enregistrement impossible.', true); return; }
      $('#overlay').classList.remove('open');
      nextRound();
    });
  }

  function nextRound() {
    S.socket.emit(EVENTS.HOST_NEXT_ROUND, {}, () => {
      markPlayed(S.round && S.round.trackId);
      S.round = null;
      S.votes = [];
      renderAll();
    });
  }

  /**
   * Le jukebox n'est ouvert QU'EN DEHORS d'une partie en cours.
   *
   * Avant le premier morceau, pour vérifier les fichiers et régler le
   * volume ; après le dernier, pour laisser tourner la playlist. Entre
   * deux manches, écouter un morceau au hasard le griller ait pour la
   * suite — et personne n'en a envie à ce moment-là.
   */
  function jukeboxOpen() {
    if (S.round) return false;
    return played.size === 0 || played.size >= S.tracks.length;
  }

  /**
   * Écoute libre d'un morceau, sans manche ni vote.
   *
   * Les indices restent visibles : on est hors jeu, il n'y a rien à
   * cacher — et c'est précisément ce qu'on veut voir pour vérifier
   * qu'un fichier est le bon.
   */
  async function preview(trackId) {
    if (!(await ensurePlayerWindow())) return;
    const t = S.tracks.find(x => x.id === trackId);
    if (!t) return;
    try {
      await Engine.play(playRef(t), 0);
      S.previewing = t;
      document.body.classList.remove('indices-hidden');
      $('#np-title').textContent  = t.title;
      $('#np-artist').textContent = `${t.artist} · proposé par ${t.proposed_by}`;
      $('#np-status').style.opacity = '1';
      $('#vinyl').classList.add('spinning');
      // La pochette aussi : hors jeu il n'y a rien a cacher, et c'est
      // precisement ce qu'on regarde pour verifier qu'un fichier est
      // le bon. Sans elle, le vinyle restait nu en ecoute libre alors
      // qu'il s'illustre en manche.
      setVinylArt(t.artwork_url);
      status('Écoute libre — aucune manche en cours');
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ─── Suivi des morceaux joués ───────────────────────────────

  const played = new Set();
  const isPlayed = (id) => played.has(id);
  const markPlayed = (id) => { if (id) played.add(id); };

  /**
   * Remet tous les morceaux dans le tirage.
   *
   * Purement local : la base garde la trace des manches jouées, et le
   * serveur refuse toujours de rejouer un morceau dans la MÊME session.
   * Ce bouton sert à repartir d'une playlist complète après une partie
   * de test, pas à rejouer un morceau en cours de soirée.
   */
  /**
   * Nouvelle partie sur la même playlist.
   *
   * Vider la liste localement ne suffisait pas : le serveur refuse de
   * rejouer un morceau dans la MÊME session. On ouvre donc une session
   * neuve — morceaux redisponibles, scores à zéro, personne à
   * reconnecter. La partie précédente reste en base.
   */
  function resetPlayed() {
    if (!S.socket) return;
    if (!confirm(
      'Commencer une nouvelle partie ?\n\n' +
      'Tous les morceaux redeviennent jouables et les scores repartent de zéro. ' +
      'Le classement de la partie précédente reste consultable.'
    )) return;

    S.socket.emit(EVENTS.HOST_NEW_SESSION, {}, (res) => {
      if (!res || !res.ok) { toast('Impossible de relancer.', true); return; }
      played.clear();
      S.round = null;
      S.votes = [];
      view('game');
      renderAll();
      toast(`Nouvelle partie — ${res.tracksTotal} morceaux.`);
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  5. Rendu
  // ═══════════════════════════════════════════════════════════

  /**
   * Applique les réglages venus de la console.
   *
   * Ils ne se MODIFIENT plus ici : un écran que la salle regarde n'est
   * pas l'endroit où l'on règle une partie. Seule reste la mise en
   * scène — le bouton œil et l'anonymisation.
   */
  function renderOptions() {
    const s = S.settings || {};
    // Hors manche, rien à masquer : le flou se pose au lancement.
    if (S.round) {
      document.body.classList.toggle('indices-hidden', s.hideIndices !== false);
    }
  }


  function renderAll() {
    renderRoomStatus();
    renderNowPlaying();
    renderPlayers();
    renderTracks();
    $('#game-counter').textContent = `${played.size}/${S.tracks.length} joués`;
    // Un seul bouton d'action à la fois — comme en v1 : soit on lance,
    // soit on révèle, jamais les deux.
    $('#btn-launch').classList.toggle('hidden', !!S.round);
    $('#btn-reveal').classList.toggle('hidden', !S.round);
    // « Lancer le morceau suivant » n'a pas de sens quand il n'y a pas
    // eu de precedent : le premier geste de la soiree merite d'etre
    // nomme pour ce qu'il est.
    $('#btn-launch').textContent = played.size === 0
      ? '▶ Démarrer la partie'
      : '▶ Lancer le morceau suivant';
    // Hors manche, l'avance rapide n'a rien a piloter : la garder
    // affichee suggere une commande qui ne fait rien. La lecture, la
    // pause et le clic sur la barre restent disponibles — verifier un
    // fichier en ecoute libre demande parfois d'y avancer.
    for (const id of ['#btn-back10', '#btn-fwd10', '#btn-fwd30']) {
      $(id).classList.toggle('hidden', !S.round);
    }
    document.body.classList.toggle('round-active', !!S.round);
  }

  /**
   * Bandeau du lecteur, repris de la v1.
   *
   * Le titre est AFFICHÉ mais FLOUTÉ par CSS (body.indices-hidden) au
   * lieu d'être remplacé par des tirets : l'hôte le lit en approchant
   * l'œil, la salle ne voit rien depuis le canapé, et le bouton 👁 le
   * révèle d'un coup pour la mise en scène.
   */
  /**
   * Compteur en direct. Passe au vert quand tout le monde a répondu —
   * c'est le seul signal que l'hôte a besoin de percevoir du coin de
   * l'œil pour savoir qu'il peut enchaîner.
   */
  /**
   * Compteur d'attente unique.
   *
   * Le serveur ne peut pas attendre des votes ET des « prêts » en même
   * temps : evaluateReveal et evaluateAdvance s'excluent. Le libellé
   * bascule donc au lieu d'occuper deux cases.
   *
   * ATTENTION à la bascule : les joueurs peuvent se déclarer prêts DÈS
   * l'écran de révélation. Une manche révélée attend donc des « prêts »,
   * pas des votes.
   */
  function waitKind() {
    return (S.round && !S.round.revealed) ? 'vote' : 'ready';
  }

  function setWaitKpi(value, total, kind) {
    if (kind !== waitKind()) return;      // phase dépassée, on ignore
    $('#pl-kpi').textContent = `${value}/${total} ${kind === 'vote' ? 'votes' : 'prêts'}`;
  }

  /** Pochette sur le vinyle, ou pastille centrale a defaut. */
  function setVinylArt(url) {
    const art = $('#vinyl-art'), dot = $('#vinyl-dot');
    if (url) {
      art.src = url; art.style.display = 'block'; dot.style.display = 'none';
    } else {
      art.style.display = 'none'; dot.style.display = 'block';
    }
  }

  function renderNowPlaying() {
    const vinyl = $('#vinyl'), art = $('#vinyl-art'), dot = $('#vinyl-dot');

    if (!S.round) {
      $('#np-title').textContent  = 'En attente…';
      $('#np-artist').textContent = 'Lance le morceau suivant pour commencer';
      $('#np-status').style.opacity = '0';
      vinyl.classList.remove('spinning');
      art.style.display = 'none'; dot.style.display = 'block';
      document.body.classList.remove('indices-hidden');
      return;
    }

    const t = S.round.track;
    $('#np-title').textContent  = t.title || '—';
    $('#np-artist').textContent = t.artist || 'Artiste inconnu';
    $('#np-status').style.opacity = '1';
    vinyl.classList.add('spinning');

    setVinylArt(t.artwork_url);
    // Chaque manche repart indices masqués — sauf si l'hôte a désactivé
    // l'option.
    document.body.classList.toggle('indices-hidden', S.settings.hideIndices !== false);
  }

  /**
   * Panneau joueurs.
   *
   *  Il porte désormais l'attente, à la place des compteurs du centre.
   *  Nommer vaut mieux que compter : « 3/5 votes » oblige à chercher
   *  qui manque, alors que la liste le montre. Le décompte reste en
   *  titre de panneau, pour le coup d'œil de loin.
   *
   *  Un seul état par ligne : pendant le vote c'est « a voté », après
   *  la révélation c'est « prêt ». Les deux ne coexistent jamais, et
   *  les afficher ensemble ferait lire deux colonnes dont une éteinte.
   */
  function renderPlayers() {
    const connected = S.players.filter(p => p.connected);
    $('#pl-count').textContent = connected.length;

    const voting = !!(S.round && !S.round.revealed);
    const done = connected.filter(p => voting ? p.voted : p.ready).length;
    $('#pl-kpi').textContent = S.round || S.round === null && done
      ? `${done}/${connected.length} ${voting ? 'votes' : 'prêts'}`
      : '';

    $('#pl-list').innerHTML = S.players.map(p => {
      /*
       * L'état se lit à la carte, pas à un mot.
       *
       * « A voté » ou « prêt » écrits à côté d'une carte déjà verte
       * disaient deux fois la même chose, dans une colonne étroite où
       * chaque caractère rogne le pseudo. Le décompte est dans le titre
       * du panneau ; la carte marque les lignes.
       */
      const done = voting ? p.voted : p.ready;
      return `
      <div class="pitem ${p.connected ? '' : 'offline'} ${done ? 'done' : ''}"
           title="${done ? (voting ? 'A voté' : 'Prêt') : ''}">
        <div class="pitem-main">
          <span class="pitem-dot on" style="--c:${esc(p.color)}"></span>
          <span class="pitem-name">${esc(p.name)}</span>
          ${p.canBeAnswer ? '' : '<span class="tag-mini">sans morceau</span>'}
          <span class="pitem-score">${p.score}</span>
        </div>
      </div>`;
    }).join('');
  }

  /**
   * Ordre d'affichage de la playlist.
   *
   * « Non joués d'abord » est le tri utile en cours de soirée : il
   * remonte ce qui reste sans masquer ce qui est passé.
   */
  function sortedTracks() {
    const list = S.tracks.slice();
    const by = {
      no:     (a, b) => a.acquisition_no - b.acquisition_no,
      artist: (a, b) => (a.artist || '').localeCompare(b.artist || '', 'fr'),
      title:  (a, b) => (a.title  || '').localeCompare(b.title  || '', 'fr'),
      player: (a, b) => (a.proposed_by || '').localeCompare(b.proposed_by || '', 'fr'),
      played: (a, b) => (isPlayed(a.id) - isPlayed(b.id)) || (a.acquisition_no - b.acquisition_no),
    };
    return list.sort(by[S.sort] || by.no);
  }

  /**
   * L'anonymisation est FORCÉE dès qu'une partie est engagée.
   *
   * Le switch reste utile avant le premier morceau — vérifier que les
   * associations sont correctes — mais une fois la partie lancée,
   * afficher les propriétaires sur un écran que la salle regarde
   * révélerait toutes les réponses d'un coup.
   */
  function inGame() { return !!S.round || played.size > 0; }
  function anonymized() { return S.anonymize || inGame(); }

  function renderTracks() {
    $('#tr-count').textContent = S.tracks.length;
    $('#btn-reset-played').disabled = played.size === 0;
    const anonBox = $('#tr-anon');
    if (anonBox) { anonBox.checked = anonymized(); anonBox.disabled = inGame(); }
    $('#tr-list').innerHTML = sortedTracks().map(t => {
      const absent = !Engine.has(playRef(t));
      const cls = ['track-item'];
      if (isPlayed(t.id)) cls.push('played');
      if (S.round && S.round.trackId === t.id) cls.push('now');
      if (absent) cls.push('absent');
      // Le badge reste présent quand on anonymise — seul son contenu
      // change. Sans ça, la ligne bougerait à chaque bascule et l'œil
      // repérerait immédiatement quelle ligne a changé.
      const badge = anonymized()
        ? '<span class="track-player-badge anon" title="Anonymisé">•••</span>'
        : `<span class="track-player-badge" style="--c:${esc(t.color)}">${esc(t.proposed_by)}</span>`;

      return `
        <div class="${cls.join(' ')}" data-track="${esc(t.id)}">
          <span class="track-idx">${String(t.acquisition_no).padStart(3, '0')}</span>
          <span class="grow">${esc(t.artist)} — ${esc(t.title)}</span>
          ${badge}
          ${absent && !isYouTube() ? '<span class="tag-mini">absent</span>' : ''}
        </div>`;
    }).join('');

    // JUKEBOX — hors manche, un clic écoute le morceau sans lancer de
    // tour. C'est la preview de la v1 : vérifier un fichier, régler le
    // volume avant l'arrivée des invités, ou simplement faire tourner
    // la playlist entre deux parties.
    //
    // Le bouton ▶ de chaque ligne, lui, lance une vraie manche.
    if (jukeboxOpen()) {
      $('#tr-list').querySelectorAll('.track-item:not(.absent)').forEach(el => {
        el.addEventListener('click', () => preview(el.dataset.track));
      });
    }
  }

  /**
   * Bandeau d'attente, sous la liste des joueurs.
   *
   * UN SEUL message, qui bascule selon la phase : qui doit encore voter
   * pendant la manche, qui doit encore se déclarer prêt entre deux.
   *
   * On n'affiche JAMAIS pour qui chacun a voté. C'était pratique au
   * développement, mais cet écran est visible de la salle : révéler les
   * cibles donnerait la réponse avant l'heure.
   */
  function renderWaitingFor(tally, kind) {
    const el = $('#ready-strip');
    if (!el) return;
    if (!tally) { el.innerHTML = ''; return; }

    const verb = kind === 'vote' ? 'ont voté' : 'prêts';
    el.innerHTML = tally.pending && tally.pending.length
      ? `<strong>${tally.done}/${tally.connected}</strong> ${verb} · on attend ${esc(tally.pending.join(', '))}`
      : `<strong>${tally.done}/${tally.connected}</strong> ${verb}`;
  }

  function renderPodium(standings) {
    $('#pod-list').innerHTML = (standings || []).map((s, i) => `
      <div class="sc-player-row" style="--c:${esc(s.color)}">
        <span style="font-family:'Bebas Neue';color:var(--muted);width:1.5rem">${i + 1}</span>
        <span class="sc-player-name">${esc(s.display_name)}</span>
        <span class="sc-pts">${s.score}</span>
      </div>`).join('');
    view('podium');
  }

  // ─── Boucle d'affichage du lecteur ──────────────────────────

  setInterval(() => {
    const pos = Engine.position();
    if (!pos || !pos.duration) return;
    $('#time-cur').textContent = mmss(pos.current);
    $('#time-tot').textContent = mmss(pos.duration);
    $('#progress-fill').style.width = `${(pos.current / pos.duration) * 100}%`;
    $('#btn-pause').textContent = Engine.isPlaying() ? '❚❚' : '▶';
    $('#vinyl').classList.toggle('spinning', Engine.isPlaying());
  }, 500);

  // ═══════════════════════════════════════════════════════════
  //  6. Commandes
  // ═══════════════════════════════════════════════════════════

  /** Avance ou recule, et consigne l'offset réellement joué. */
  async function skip(sec) {
    const ms = await Engine.skip(sec);
    if (ms != null && S.round) S.socket.emit(EVENTS.HOST_SET_OFFSET, { ms });
  }

  /** Saut absolu (clic sur la barre de progression). */
  async function skipTo(targetSec) {
    const pos = Engine.position();
    if (!pos) return;
    await skip(targetSec - pos.current);
  }

  async function renderPodiumFromServer() {
    const { ok, data } = await api('GET', `/api/host/parties/${S.code}/sessions`);
    if (ok) renderPodium(data.standings);
  }

  function bind() {
    $('#g-folder-btn').addEventListener('click', pickFolder);
    $('#g-folder-input').addEventListener('change', (e) => {
      if (e.target.files.length) onFolder(e.target.files);
      e.target.value = '';
    });

    $('#btn-launch').addEventListener('click', () => startRound());
    $('#btn-reveal').addEventListener('click', doReveal);
    $('#btn-pause').addEventListener('click', () => Engine.togglePause());
    $('#btn-back10').addEventListener('click', () => skip(-10));
    $('#btn-fwd10').addEventListener('click', () => skip(10));
    $('#btn-fwd30').addEventListener('click', () => skip(30));
    $('#vol-slider').addEventListener('input', (e) => {
      Engine.setVolume(e.target.value / 100);
      $('#vol-val').textContent = e.target.value + '%';
    });

    // Bouton œil : révèle les indices pour la mise en scène.
    $('#btn-indices').addEventListener('click', () =>
      document.body.classList.toggle('indices-hidden'));

    // Seek par clic sur la barre, comme en v1.
    $('#progress-bar').addEventListener('click', async (e) => {
      const pos = Engine.position();
      if (!pos || !pos.duration) return;
      const r = e.currentTarget.getBoundingClientRect();
      await skipTo(((e.clientX - r.left) / r.width) * pos.duration);
    });

    $('#btn-validate-scores').addEventListener('click', validateScores);
    $('#btn-cancel-scores').addEventListener('click', () => $('#overlay').classList.remove('open'));
    // Clic sur le fond ferme sans valider — le tour reste actif.
    $('#overlay').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) $('#overlay').classList.remove('open');
    });

    // Panneaux
    $('#tab-players').addEventListener('click',  () => Panels.toggle('players'));
    $('#tab-playlist').addEventListener('click', () => Panels.toggle('playlist'));
    $('#close-players').addEventListener('click',  () => Panels.close('players'));
    $('#close-playlist').addEventListener('click', () => Panels.close('playlist'));
    $('#btn-mode-tv').addEventListener('click', () => Panels.toggleAll());

    // Outils de playlist
    $('#tr-sort').addEventListener('change', (e) => { S.sort = e.target.value; renderTracks(); });
    $('#tr-anon').addEventListener('change', (e) => {
      S.anonymize = e.target.checked;
      if (!S.anonymize && inGame()) {
        toast('Anonymisation maintenue : une partie est en cours.', true);
        e.target.checked = true;
        S.anonymize = true;
      }
      renderTracks();
    });
    $('#btn-reset-played').addEventListener('click', resetPlayed);

    // Aide
    $('#btn-help').addEventListener('click', () => $('#help-overlay').classList.add('open'));
    $('#help-overlay').addEventListener('click', () => $('#help-overlay').classList.remove('open'));

    /**
     * Terminer la partie.
     *
     * Remet le lecteur dans l'état où il était avant le premier
     * morceau : musique coupée, manche close, boutons réinitialisés.
     * Auparavant le bouton se contentait d'afficher le podium, et l'on
     * revenait sur un lecteur qui croyait encore une manche en cours.
     *
     * Le salon reste ouvert et les joueurs connectés.
     */
    $('#btn-end').addEventListener('click', async () => {
      if (!confirm('Terminer la partie et afficher les scores ?\n\nLe salon reste ouvert : tu pourras revenir au lecteur ou en relancer une.')) return;

      await Engine.stop();
      if (S.round) S.socket.emit(EVENTS.HOST_NEXT_ROUND, {});
      S.round = null;
      S.votes = [];
      S.previewing = null;
      $('#overlay').classList.remove('open');
      renderAll();
      renderWaitingFor(null);
      status('');
      renderPodiumFromServer();
    });

    const close = () => {
      if (!confirm('Fermer le salon ?\nLa partie sera terminée et les joueurs déconnectés.')) return;
      S.socket.emit(EVENTS.HOST_CLOSE_ROOM, {}, () => { location.href = '/h/' + S.code; });
    };
    $('#pod-close').addEventListener('click', close);
    // Le salon reste ouvert : on revient au lecteur, panneaux compris.
    $('#pod-back').addEventListener('click', () => { view('game'); renderAll(); });




    // Raccourcis : en soirée, on ne regarde pas l'écran pour cliquer.
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;

      switch (e.code) {
        case 'Space':      e.preventDefault(); Engine.togglePause(); break;
        case 'ArrowRight': e.preventDefault(); skip(10);  break;
        case 'ArrowLeft':  e.preventDefault(); skip(-10); break;
        // Action principale contextuelle, comme en v1 : le même geste
        // lance ou révèle selon l'état de la manche.
        case 'Enter':      e.preventDefault(); S.round ? doReveal() : startRound(); break;
        case 'KeyT':       Panels.toggleAll(); break;
        case 'KeyJ':       Panels.toggle('players'); break;
        case 'KeyP':       Panels.toggle('playlist'); break;
        case 'KeyH':       document.body.classList.toggle('indices-hidden'); break;
        case 'KeyR':       if (S.round) doReveal(); break;
        case 'KeyN':       if (!S.round) startRound(); break;
        case 'KeyA':       $('#tr-anon').click(); break;
        case 'Escape':
          $('#help-overlay').classList.remove('open');
          $('#overlay').classList.remove('open');
          break;
        default:
          if (e.key === '?') $('#help-overlay').classList.add('open');
      }
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Amorçage
  // ═══════════════════════════════════════════════════════════

  async function boot() {
    bind();
    Panels.init();
    const m = location.pathname.match(/^\/h\/([A-Za-z0-9]+)\/play/);
    if (!m) { location.href = '/h'; return; }
    S.code = m[1].toUpperCase();

    // Le lien de retour etait fige sur /h — l'ecran de creation. On
    // revient a la console de CETTE soiree, sur l'etape de lancement.
    $('#back-console').href = `/h/${S.code}?step=2`;

    let parties = {};
    try { parties = JSON.parse(localStorage.getItem('blindtest:parties') || '{}'); } catch { /* ignore */ }
    const known = parties[S.code];
    if (!known) { toast('Soirée inconnue de ce navigateur.', true); setTimeout(() => location.href = '/h', 1500); return; }
    S.hostToken = known.hostToken;

    const { ok, data } = await api('GET', `/api/host/parties/${S.code}/tracks`);
    if (!ok) { toast('Playlist introuvable.', true); return; }
    S.tracks = data.tracks;
    S.name = known.name || 'Partie';
    renderRoomStatus();
    $('#g-code').textContent = S.code;
    renderRejoinQR();

    // Le salon s'ouvre IMMÉDIATEMENT : arriver ici, c'est déjà être
    // dans sa soirée. Le chargement du dossier n'est plus une étape
    // préalable mais une action du panneau playlist, qu'on peut refaire
    // à tout moment — après un rafraîchissement, par exemple.
    openRoom();

    if (!S.tracks.length) {
      $('#g-folder-report').innerHTML =
        '<div class="banner bad">Aucun morceau jouable. Verrouille la collecte et vérifie les fichiers depuis la console de préparation.</div>';
      $('#g-folder-btn').disabled = true;
      return;
    }

    await tryRecallFolder();
  }

  boot();
})();
