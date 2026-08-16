const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3766); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),4000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const once=(s,e,ms=3000)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};

// ═══ 3 — Export des URL ═══
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'Fix',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
const ids={}; for(const n of ['Alice','Bob'])
  ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Alice},body:{source:'itunes',sourceId:'1',title:'T1',artist:'A1',durationMs:200000,url:'https://ex.com/1'}});
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Alice},body:{source:'itunes',sourceId:'2',title:'T2',artist:'A2',durationMs:200000,url:'https://ex.com/2'}});
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Bob},body:{source:'itunes',sourceId:'3',title:'T3',artist:'A3',durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const txtRes=await fetch(B+`/api/host/parties/${code}/manifest?format=urls`,{headers:{Cookie:ck,'X-Host-Token':cr.data.hostToken}});
const txt=await txtRes.text();
ok('export .txt en text/plain', txtRes.headers.get('content-type').includes('text/plain'));
ok('une URL par ligne, sans rien d autre', txt.trim().split('\n').every(l=>/^https?:\/\//.test(l)), JSON.stringify(txt));
ok('seules les URL presentes sont exportees', txt.trim().split('\n').length===2, '3 morceaux, 2 avec URL');
ok('nom de fichier propose', (txtRes.headers.get('content-disposition')||'').includes('urls-'+code));

// ═══ 4 — Le decompte des prets repart a zero a chaque manche ═══
const tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,
  body:{files:tr.map(t=>({trackId:t.id,fileName:'f-'+t.title+'.mp3',durationMs:t.duration_ms}))}});
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const sA=cli(B),sB=cli(B);
await p(sA,E.PLAYER_JOIN,{token:tk.Alice}); await p(sB,E.PLAYER_JOIN,{token:tk.Bob});

const t0=tr[0];
await p(H,E.HOST_START_ROUND,{trackId:t0.id});
await p(H,E.HOST_REVEAL,{title:t0.title,artist:t0.artist,player:'Alice',playerId:ids.Alice});
await p(sA,E.PLAYER_READY,{ready:true});
await p(sB,E.PLAYER_READY,{ready:true});
await p(H,E.HOST_APPLY_SCORES,{events:[{participantId:ids.Alice,points:1,reason:'finder'}]});
await p(H,E.HOST_NEXT_ROUND,{});
await new Promise(r=>setTimeout(r,600));

// Nouvelle manche : le decompte doit repartir a 0/2
const rp=once(sA,E.STATE_READY_PROGRESS,3000);
await p(H,E.HOST_START_ROUND,{trackId:tr[1].id});
const r=await rp;
ok('nouvelle manche → prets remis a zero', r && r.ready===0, `${r?.ready}/${r?.connected}`);
ok('identifiants en attente transmis', r && r.pendingIds.length===2,
   'chaque client sait si LUI est pret');

// ═══ 6 — Une soiree supprimee n'existe plus publiquement ═══
const other=await J('POST','/api/host/parties',{headers:C,body:{name:'Zombie'}});
const zc=other.data.party.code;
ok('soiree visible avant suppression', (await J('GET',`/api/join/${zc}`)).status===200);
// La suppression relève de l'administration, pas de l'animation.
const alg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
  body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/admin',redirect:'manual'});
const adm={Cookie:(alg.headers.get('set-cookie')||'').split(';')[0]};
await J('DELETE',`/api/admin/parties/${zc}`,{headers:adm});
ok('404 apres suppression → purge possible cote client', (await J('GET',`/api/join/${zc}`)).status===404);

// ═══ Interface ═══
const pl=await (await fetch(B+'/player')).text();
const pj=await (await fetch(B+'/player/app.js')).text();
const gj=await (await fetch(B+'/player/game.js')).text();
const hj=await (await fetch(B+'/host/app.js')).text();
const yj=await (await fetch(B+'/play/app.js')).text();
const hh=await (await fetch(B+'/h/'+code,{headers:C})).text();
ok('pseudo sur l ecran d attente', pl.includes('id="wait-me"')&&pj.includes('Tu joues en tant que'));
ok('mode lecture seule sans bouton +', pj.includes("trackRow(t, 'readonly')")&&pj.includes("let button = '';"));
ok('bouton export URL', hh.includes('id="man-urls"'));
ok('pas de bascule vers un ecran doublon', gj.includes("current() === 'reveal'"));
ok('dossier memorise (IndexedDB)', (await fetch(B+'/shared/folder-store.js')).status===200);
ok('console memorise le dossier', hj.includes('FolderStore.remember'));
ok('jeu reutilise le dossier', yj.includes('tryRecallFolder')&&yj.includes('Dossier retrouvé'));
ok('purge des soirees disparues', hj.includes('pruneDeleted'));
const home=await (await fetch(B+'/')).text();
ok('accueil purge aussi', home.includes("res.status === 404 ? null : e"));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
