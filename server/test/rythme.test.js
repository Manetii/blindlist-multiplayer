const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3722); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),5000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const once=(s,e,ms=3000)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});
// Le serveur émet aussi {seconds:null} pour effacer un décompte en
// cours : on n'attend que les décomptes réels.
const onceCd=(s,ms=3000)=>new Promise(r=>{
  const t=setTimeout(()=>{s.off(E.STATE_COUNTDOWN,h);r(null)},ms);
  const h=d=>{ if(d && d.seconds){ clearTimeout(t); s.off(E.STATE_COUNTDOWN,h); r(d);} };
  s.on(E.STATE_COUNTDOWN,h);
});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'R',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
const ids={}; for(const n of ['Alice','Bob'])
  ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
for(const[w,ns] of [['Alice',[1,2]],['Bob',[3]]]) for(const n of ns)
  await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},body:{source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A'+n,durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
let tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:tr.map(t=>({trackId:t.id,fileName:'f'+t.title+'.mp3',durationMs:t.duration_ms}))}});

// ═══ Souplesse : rouvrir la collecte depuis « prête » ═══
ok('soiree prete',(await J('GET',`/api/host/parties/${code}`,{headers:HT})).data.party.state==='prete');
await J('PATCH',`/api/host/parties/${code}/state`,{headers:HT,body:{state:'verrouillee'}});
const un=await J('POST',`/api/host/parties/${code}/unlock`,{headers:HT});
ok('REOUVERTURE depuis prete', un.data.party.state==='collecte');
const late=await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Retardataire'}});
ok('ajout de joueur apres coup', late.status===201);
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Alice},body:{source:'itunes',sourceId:'i9',title:'T9',artist:'A9',durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
ok('nouveau morceau integre', tr.length===4);
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:tr.map(t=>({trackId:t.id,fileName:'f'+t.title+'.mp3',durationMs:t.duration_ms}))}});

// ═══ Décompte : seulement avant le premier morceau ═══
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const sA=cli(B),sB=cli(B);
await p(sA,E.PLAYER_JOIN,{token:tk.Alice}); await p(sB,E.PLAYER_JOIN,{token:tk.Bob});
await p(H,E.HOST_NEXT_ROUND,{});
const cd1=onceCd(sA,2500);
await p(sA,E.PLAYER_READY,{ready:true}); await p(sB,E.PLAYER_READY,{ready:true});
const c1=await cd1;
ok('DECOMPTE avant le premier morceau', c1 && c1.seconds===3, `${c1?.seconds} s`);
await once(H,E.HOST_CUE,6000);

await p(H,E.HOST_START_ROUND,{trackId:tr[0].id});
await p(H,E.HOST_REVEAL,{title:'x',artist:'y',player:'Alice',playerId:ids.Alice});
await p(H,E.HOST_NEXT_ROUND,{});
const cd2=onceCd(sA,1200);
const cue2=once(H,E.HOST_CUE,2500);
await p(sA,E.PLAYER_READY,{ready:true}); await p(sB,E.PLAYER_READY,{ready:true});
ok('PAS de decompte ensuite', (await cd2)===null, 'on enchaine sans temps mort');
ok('lancement immediat', !!(await cue2));

// ═══ Fin de playlist puis nouvelle partie ═══
for(const t of tr.slice(1)){ await p(H,E.HOST_START_ROUND,{trackId:t.id}); await p(H,E.HOST_NEXT_ROUND,{}); }
await p(H,E.HOST_APPLY_SCORES,{events:[{participantId:ids.Alice,points:5,reason:'finder'}]});
const over=await p(H,E.HOST_START_ROUND,{});
ok('playlist epuisee', over.gameOver===true);

const again=await p(H,E.HOST_NEW_SESSION,{});
ok('NOUVELLE PARTIE possible', again.ok && again.tracksTotal===4);
ok('classement precedent conserve', Array.isArray(again.previousStandings) && again.previousStandings.length>0,
   again.previousStandings.map(s=>s.display_name+'='+s.score).join(' '));
const relance=await p(H,E.HOST_START_ROUND,{trackId:tr[0].id});
ok('morceaux rejouables', relance.ok, 'le meme morceau repart');
const st=(await J('GET',`/api/host/parties/${code}/sessions`,{headers:HT})).data;
ok('deux sessions en base', st.sessions.length===2);
ok('scores repartis de zero', st.standings.every(s=>s.score===0));

// ═══ Interface ═══
const yj=await (await fetch(B+'/play/app.js')).text();
const aj=await (await fetch(B+'/play/audio.js')).text();
const yh=await (await fetch(B+'/h/'+code+'/play',{headers:C})).text();
ok('musique NON coupee au reveal', !yj.includes('AudioEngine.stop()') || yj.includes('À PLEIN VOLUME'),
   'plus d attenuation non plus');
ok('jukebox (ecoute libre)', yj.includes('function preview')&&yj.includes('Écoute libre'));
ok('jukebox seulement hors partie', yj.includes('function jukeboxOpen'));
ok('pas de bouton lancer par morceau', !yj.includes('data-play'));
ok('nouvelle partie depuis la playlist', yh.includes('Nouvelle partie'));
ok('vocabulaire lecteur/console', yh.includes('Retour à la console'));
ok('pas de bouton couper', !yh.includes('id="btn-stop"'));
ok('page unique : plus d ecran dossier', !yh.includes('data-view="folder"'));
ok('chargement du dossier dans la playlist', yh.includes('id="g-folder-btn"')&&yh.includes('playlist-footer'));
ok('podium au lieu d une erreur', yj.includes('res.gameOver) { renderPodiumFromServer()'));
const dbj=await require('fs').promises.readFile(R+'/db/index.js','utf8');
ok('diagnostic .env', dbj.includes('.env.txt')&&dbj.includes('Fichiers proches'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
