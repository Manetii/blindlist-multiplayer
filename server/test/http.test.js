/**
 * Test HTTP de bout en bout — parcours hôte, participant, admin.
 *
 *   DATABASE_URL=postgres://... HOST_PASSWORD=secret \
 *   node server/test/http.test.js
 *
 * Démarre le vrai serveur et l'interroge par fetch, sans mock.
 */

const path = require('path');
const R  = path.join(__dirname, '..');
const db = require(R + '/db');

process.env.PORT = process.env.PORT || '3988';
const BASE = `http://127.0.0.1:${process.env.PORT}`;

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  ok  ' : 'ECHEC '} ${label}${extra ? ' — ' + extra : ''}`);
};

let cookie = '';

async function api(method, url, { body, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* page HTML ou CSV */ }
  return { status: res.status, json, text, res };
}

(async () => {
  const { start, server } = require(R + '/server');
  await start();
  await new Promise(r => setTimeout(r, 300));

  // ═══ Porte globale ═══
  // Créer une soirée est OUVERT : c'est le hostToken rendu à la
  // création qui la protège ensuite, pas un mot de passe partagé.
  ok('création de soirée ouverte', (await api('POST', '/api/host/parties', {
    body: { name: 'Ouverte' },
  })).status === 201);

  const login = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(process.env.ADMIN_PASSWORD || 'adminsecret') + '&next=/h',
    redirect: 'manual',
  });
  cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok('login admin pose un cookie', !!cookie && login.status === 302);

  ok('redirection ouverte bloquée', await (async () => {
    const r = await fetch(BASE + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=' + encodeURIComponent(process.env.ADMIN_PASSWORD || 'adminsecret') +
            '&next=' + encodeURIComponent('//evil.example.com'),
      redirect: 'manual',
    });
    return r.headers.get('location') === '/';
  })());

  // ═══ H1 — Création ═══
  const created = await api('POST', '/api/host/parties', {
    body: { name: 'Soirée test', minTracks: 1, maxTracks: 3 },
  });
  ok('création de soirée', created.status === 201, created.json.party.code);
  const code = created.json.party.code;
  const hostToken = created.json.hostToken;
  const H = { headers: { 'X-Host-Token': hostToken } };

  ok('console refusée sans jeton de soirée',
     (await api('GET', `/api/host/parties/${code}`)).status === 404);
  ok('console ouverte avec le bon jeton',
     (await api('GET', `/api/host/parties/${code}`, H)).status === 200);

  // ═══ H2 — Participants ═══
  const alice = await api('POST', `/api/host/parties/${code}/participants`, {
    ...H, body: { displayName: 'Alice' },
  });
  ok('ajout participant', alice.status === 201);
  const bob = await api('POST', `/api/host/parties/${code}/participants`, {
    ...H, body: { displayName: 'Bob' },
  });
  const dupe = await api('POST', `/api/host/parties/${code}/participants`, {
    ...H, body: { displayName: 'ALICE' },
  });
  ok('doublon → 409 + suggestions', dupe.status === 409 && dupe.json.suggestions.length > 0,
     dupe.json.suggestions.join(', '));

  // ═══ V3 — Revendication ═══
  const joinView = await api('GET', `/api/join/${code}`);
  ok('liste des noms publique', joinView.status === 200 && joinView.json.participants.length === 2);
  ok('aucun jeton exposé dans la liste',
     !JSON.stringify(joinView.json).match(/token/i));

  const claimA = await api('POST', `/api/join/${code}/claim/${alice.json.participant.id}`);
  ok('revendication', claimA.status === 201 && !!claimA.json.token, claimA.json.magicLink);
  const again = await api('POST', `/api/join/${code}/claim/${alice.json.participant.id}`);
  ok('seconde revendication → 409', again.status === 409);

  const claimB = await api('POST', `/api/join/${code}/claim/${bob.json.participant.id}`);
  const A = { headers: { 'X-Participant-Token': claimA.json.token } };
  const B = { headers: { 'X-Participant-Token': claimB.json.token } };

  // Un participant d'une autre soirée ne doit pas être revendicable ici.
  const other = await api('POST', '/api/host/parties', { body: { name: 'Autre' } });
  const otherP = await api('POST', `/api/host/parties/${other.json.party.code}/participants`, {
    headers: { 'X-Host-Token': other.json.hostToken }, body: { displayName: 'Zoé' },
  });
  ok('revendication inter-soirées refusée',
     (await api('POST', `/api/join/${code}/claim/${otherP.json.participant.id}`)).status === 404);

  // ═══ P0 — Résolveur ═══
  const me = await api('GET', '/api/me', A);
  ok('résolveur → panier en collecte', me.json.screen === 'panier',
     `quota ${me.json.quota.current}/${me.json.quota.max}`);
  ok('jeton invalide → 401',
     (await api('GET', '/api/me', { headers: { 'X-Participant-Token': 'nope' } })).status === 401);

  // ═══ P1 — Panier ═══
  const mk = n => ({ source: 'spotify', sourceId: 'sp:' + n, title: 'T' + n,
                     artist: 'Ar' + n, durationMs: 200000 });
  for (const n of [1, 2, 3]) await api('POST', '/api/me/tracks', { ...A, body: mk(n) });
  const over = await api('POST', '/api/me/tracks', { ...A, body: mk(4) });
  ok('quota max → 409', over.status === 409, over.json.error);

  await api('POST', '/api/me/tracks', { ...B, body: mk(1) });   // doublon inter-joueurs
  await api('POST', '/api/me/tracks', { ...B, body: mk(9) });

  const basket = await api('GET', '/api/me/tracks', A);
  ok('panier lisible', basket.json.tracks.length === 3);
  // On supprime le DERNIER : sp:1 doit survivre, c'est lui qui fait
  // doublon avec le panier de Bob et alimente le test d'arbitrage.
  const del = await api('DELETE', `/api/me/tracks/${basket.json.tracks[2].id}`, A);
  ok('suppression + recompactage',
     del.json.tracks.map(t => t.position).join(',') === '1,2');

  // ═══ H4 — Arbitrage ═══
  const dups = await api('GET', `/api/host/parties/${code}/duplicates`, H);
  ok('doublon inter-joueurs détecté', dups.json.duplicates.length === 1,
     dups.json.duplicates[0].claimants.map(c => c.displayName).join(' vs '));
  await api('POST',
    `/api/host/parties/${code}/tracks/${dups.json.duplicates[0].claimants[1].trackId}/exclude`, H);
  ok('arbitrage',
     (await api('GET', `/api/host/parties/${code}/duplicates`, H)).json.duplicates.length === 0);

  // ═══ H4 — Verrouillage ═══
  const locked = await api('POST', `/api/host/parties/${code}/lock`, H);
  ok('verrouillage', locked.status === 200 && locked.json.numbered === 3,
     `${locked.json.numbered} numérotés`);
  ok('sous-minimum signalé sans bloquer', Array.isArray(locked.json.belowMinimum));
  ok('ajout refusé après verrouillage',
     (await api('POST', '/api/me/tracks', { ...A, body: mk(7) })).status === 409);
  ok('résolveur → attente', (await api('GET', '/api/me', A)).json.screen === 'attente');

  // ═══ H5 — Manifeste ═══
  const man = await api('GET', `/api/host/parties/${code}/manifest`, H);
  ok('manifeste JSON', man.json.count === 3, man.json.manifest[0].expected_file_name);
  const csv = await api('GET', `/api/host/parties/${code}/manifest?format=csv`, H);
  ok('export CSV', csv.res.headers.get('content-type').includes('text/csv')
     && csv.text.split('\n').length === 4);

  // ═══ H6 — Vérification ═══
  // Numéros mélangés : on prend la première entrée telle qu'elle vient,
  // sans supposer qu'il s'agit du morceau n°1.
  const une = man.json.manifest[0];
  const partial = await api('POST', `/api/host/parties/${code}/reconcile`, {
    ...H,
    body: { files: [{ acquisitionNo: une.acquisition_no, fileName: 'a.mp3',
                      durationMs: une.duration_ms }] },
  });
  ok('vérification partielle', !partial.json.ready && partial.json.missing.length === 2);

  const full = await api('POST', `/api/host/parties/${code}/reconcile`, {
    ...H,
    body: { files: man.json.manifest.map(m => ({
      acquisitionNo: m.acquisition_no, fileName: m.expected_file_name,
      durationMs: m.duration_ms,
    })) },
  });
  ok('vérification complète → soirée prête',
     full.json.ready && full.json.party.state === 'prete');

  // ═══ A1/A2 — Admin ═══
  ok('admin fermée sans session', await (async () => {
    const saved = cookie; cookie = '';
    const r = await api('GET', '/api/admin/overview');
    cookie = saved;
    return r.status === 401;
  })());

  const adminLogin = await fetch(BASE + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(process.env.ADMIN_PASSWORD || 'adminsecret') + '&next=/admin',
    redirect: 'manual',
  });
  cookie = (adminLogin.headers.get('set-cookie') || '').split(';')[0];

  const overview = await api('GET', '/api/admin/overview');
  ok('vue admin', overview.status === 200 && overview.json.parties.length >= 2,
     `${overview.json.parties.length} soirées, db ${overview.json.server.dbOk}`);
  const detail = await api('GET', `/api/admin/parties/${code}`);
  ok('détail admin', detail.status === 200 && detail.json.roster.length === 2);
  ok('aucun secret exposé par l\'admin',
     !JSON.stringify(detail.json).match(/host_token|token_hash/i));

  // ═══ Divers ═══
  ok('/health', (await api('GET', '/health')).json.db === true);
  ok('404 JSON', (await api('GET', '/api/nexistepas')).status === 404);
  ok('page participant sans validation serveur',
     (await api('GET', `/p/${code}/nimportequoi`)).status === 200);
  ok('noindex sur le lien magique',
     (await api('GET', `/p/${code}/x`)).res.headers.get('x-robots-tag')?.includes('noindex'));

  console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
  server.close();
  await db.close();
  process.exit(failures ? 1 : 0);

})().catch(e => { console.error('CRASH', e); process.exit(1); });
