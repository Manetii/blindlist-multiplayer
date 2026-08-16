/**
 * ════════════════════════════════════════════════════════════════
 *  SUPERVISION
 * ════════════════════════════════════════════════════════════════
 *
 *  Écrans A1 et A2. Derrière la porte globale (HOST_PASSWORD).
 *
 *  Sa vraie utilité n'est pas d'administrer mais de DÉBOGUER : voir
 *  côte à côte l'état de la base et l'état RAM du salon. C'est leur
 *  divergence qui explique la plupart des symptômes bizarres en pleine
 *  soirée — un salon fermé alors que la session est ouverte, un
 *  minuteur qui court sans raison, un signal en attente d'un hôte
 *  déconnecté.
 * ════════════════════════════════════════════════════════════════
 */

(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };

  let toastTimer;
  function toast(msg, bad = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (bad ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = '/login?next=/admin'; return { ok: false, data: {} }; }
    let data = null;
    try { data = await res.json(); } catch { /* vide */ }
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  const ago = (iso) => {
    if (!iso) return '—';
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return `il y a ${s} s`;
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
    return `il y a ${Math.round(s / 86400)} j`;
  };

  // ─── A1 — Vue d'ensemble ────────────────────────────────────

  async function loadOverview() {
    const { ok, data } = await api('GET', '/api/admin/overview');
    if (!ok) return;

    $('#server-line').textContent =
      `${Math.round(data.server.uptimeSec / 60)} min · ${data.server.memoryMb} Mo · base ${data.server.dbOk ? 'OK' : 'HS'}`;

    const sec = data.security || {};
    $('#security-warning').innerHTML = sec.adminPasswordSet ? '' : `
      <div class="banner bad" style="margin-bottom:1rem">
        <b>ADMIN_PASSWORD n'est pas défini.</b> Cette page ${sec.hostPasswordSet
          ? 's\'ouvre avec le mot de passe hôte — tout animateur peut supprimer les soirées.'
          : 'est accessible sans aucun mot de passe.'}
        Ajoute <code>ADMIN_PASSWORD=…</code> dans ton fichier <code>.env</code>, puis redémarre le serveur.
      </div>`;

    $('#kpis').innerHTML = [
      ['Soirées',        data.parties.length],
      ['Salons ouverts', data.live.rooms],
      ['Joueurs en jeu', data.live.players],
      ['Minuteurs',      data.live.timers],
    ].map(([k, v]) => `<div class="kpi"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');

    $('#p-count').textContent = data.parties.length;
    $('#parties').innerHTML = data.parties.length
      ? data.parties.map(partyRow).join('')
      : '<p class="empty">Aucune soirée.</p>';

    document.querySelectorAll('details.detail').forEach(d => {
      // Chargement paresseux : le détail est coûteux (cinq requêtes) et
      // n'a d'intérêt que sur la soirée qu'on inspecte.
      d.addEventListener('toggle', () => {
        if (d.open && !d.dataset.loaded) loadDetail(d.dataset.code, d);
      });
    });
    document.querySelectorAll('[data-del]').forEach(b =>
      b.addEventListener('click', (e) => { e.preventDefault(); deleteParty(b.dataset.del); }));
    document.querySelectorAll('[data-close]').forEach(b =>
      b.addEventListener('click', (e) => { e.preventDefault(); closeRoom(b.dataset.close); }));
  }

  function partyRow(p) {
    return `
      <details class="detail" data-code="${esc(p.code)}">
        <summary>
          <span class="pcode">${esc(p.code)}</span>
          <span class="grow" style="flex:1">
            ${esc(p.name)}
            <span class="sub" style="display:block;font-size:.72rem;color:var(--muted)">
              ${p.participants} joueur(s) · ${p.tracks} morceau(x) · ${ago(p.last_activity_at)}
            </span>
          </span>
          <span class="tag${p.roomOpen ? ' ok' : ''}">${p.state}${p.roomOpen ? ' · EN JEU' : ''}</span>
        </summary>
        <div class="body" id="body-${esc(p.code)}">
          <p class="muted small" style="padding:.6rem 0">Chargement…</p>
        </div>
      </details>`;
  }

  // ─── A2 — Détail ────────────────────────────────────────────

  async function loadDetail(code, node) {
    const { ok, data } = await api('GET', `/api/admin/parties/${code}`);
    const el = $(`#body-${code}`);
    if (!ok) { el.innerHTML = '<p class="empty">Détail indisponible.</p>'; return; }
    node.dataset.loaded = '1';

    const parts = [];

    parts.push('<div class="eyebrow" style="margin:.7rem 0 .4rem">Participants</div>');
    parts.push(data.roster.length
      ? data.roster.map(r => `
          <div class="report-line">
            <span class="grow" style="flex:1">${esc(r.display_name)}</span>
            <span class="sub">${r.claimed ? 'revendiqué' : 'libre'}${r.can_be_answer ? '' : ' · hors grille'}</span>
          </div>`).join('')
      : '<p class="empty">Aucun.</p>');

    if (data.duplicates.length) {
      parts.push(`<div class="banner warn" style="margin-top:.7rem">${data.duplicates.length} doublon(s) non tranché(s)</div>`);
    }

    // L'état RAM à côté de l'état base : c'est leur divergence qui
    // explique les symptômes inexplicables.
    if (data.room) {
      const r = data.room;
      parts.push('<div class="eyebrow" style="margin:.9rem 0 .4rem">Salon (RAM)</div>');
      parts.push(`
        <div class="report-line"><span class="grow" style="flex:1">Hôte</span>
          <span class="sub ${r.hostOnline ? 'live' : ''}">${r.hostOnline ? 'connecté' : 'absent'}</span></div>
        <div class="report-line"><span class="grow" style="flex:1">Morceaux joués</span>
          <span class="sub">${r.tracksPlayed} / ${r.tracksTotal}</span></div>
        <div class="report-line"><span class="grow" style="flex:1">Manche</span>
          <span class="sub">${r.round.active ? (r.round.revealed ? 'révélée' : 'en cours') : 'aucune'} · ${r.round.votes} vote(s)</span></div>
        ${r.paused ? '<div class="banner warn" style="margin-top:.5rem">Partie en pause</div>' : ''}
        ${r.pendingCue ? `<div class="banner info" style="margin-top:.5rem">Signal en attente : ${esc(r.pendingCue.action)}</div>` : ''}`);

      const timers = Object.entries(r.timers).filter(([, v]) => v != null);
      if (timers.length) {
        parts.push('<div class="eyebrow" style="margin:.7rem 0 .3rem">Minuteurs</div>');
        parts.push(timers.map(([k, v]) => `
          <div class="report-line"><span class="grow" style="flex:1">${esc(k)}</span>
            <span class="sub">${Math.round(v / 1000)} s</span></div>`).join(''));
      }
    }

    if (data.sessions.length) {
      parts.push('<div class="eyebrow" style="margin:.9rem 0 .4rem">Sessions</div>');
      parts.push(data.sessions.map(s => `
        <div class="report-line">
          <span class="grow" style="flex:1">${new Date(s.opened_at).toLocaleString('fr-FR')}</span>
          <span class="sub">${s.rounds} manche(s) · ${s.closed_at ? 'close' : 'OUVERTE'}</span>
        </div>`).join(''));
    }

    parts.push(`
      <div class="btn-row" style="margin-top:1rem">
        <a class="btn ghost sm" href="/j/${esc(code)}" target="_blank">Vue joueur</a>
        ${data.room ? `<button class="btn ghost sm" data-close="${esc(code)}">Fermer le salon</button>` : ''}
        <button class="btn danger sm" data-del="${esc(code)}">Supprimer la soirée</button>
      </div>`);

    el.innerHTML = parts.join('');
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteParty(code)));
    el.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeRoom(code)));
  }

  // ─── Actions ────────────────────────────────────────────────

  async function deleteParty(code) {
    if (!confirm(
      `Supprimer définitivement la soirée ${code} ?\n\n` +
      'Participants, morceaux, sessions et scores partent avec. Irréversible.'
    )) return;
    const { ok, data } = await api('DELETE', `/api/admin/parties/${code}`);
    if (!ok) { toast(data.error || 'Suppression impossible.', true); return; }
    toast(`Soirée ${code} supprimée.`);
    loadOverview();
  }

  async function closeRoom(code) {
    const { ok } = await api('POST', `/api/admin/parties/${code}/close-room`);
    toast(ok ? 'Salon fermé.' : 'Fermeture impossible.', !ok);
    loadOverview();
  }

  async function resetAll() {
    // Double confirmation : la seconde exige de recopier une phrase,
    // pour qu'un clic distrait ne détruise pas une soirée réelle.
    if (!confirm('Supprimer TOUTES les soirées et leurs données ?')) return;
    const typed = prompt('Tape « SUPPRIMER TOUT » pour confirmer.');
    if (typed !== 'SUPPRIMER TOUT') { toast('Annulé.'); return; }

    const { ok, data } = await api('POST', '/api/admin/maintenance/reset', { confirm: typed });
    if (!ok) { toast(data.error || 'Échec.', true); return; }
    toast(`${data.deleted} soirée(s) supprimée(s).`);
    loadOverview();
  }

  $('#refresh').addEventListener('click', loadOverview);
  $('#reset-all').addEventListener('click', resetAll);
  loadOverview();
})();
