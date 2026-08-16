const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3798); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),4000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const once=(s,e,ms=3000)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'Ergo',minTracks:1,maxTracks:3}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
const ids={}; for(const n of ['Alice','Bob'])
  ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
for(const[w,ns] of [['Alice',[1,2]],['Bob',[3]]]) for(const n of ns)
  await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},body:{source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A'+n,durationMs:200000}});

// ── Resolveur : passage collecte → attente sans refresh manuel ──
ok('resolveur en collecte',(await J('GET','/api/me',{headers:{'X-Participant-Token':tk.Alice}})).data.screen==='panier');
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
ok('resolveur bascule apres verrouillage',(await J('GET','/api/me',{headers:{'X-Participant-Token':tk.Alice}})).data.screen==='attente');

// ── Appariement par trackId, sans renommage ──
const tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
const rec=await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,
  body:{files:tr.map(t=>({trackId:t.id,fileName:'nimporte-quel-nom-'+t.title+'.mp3',durationMs:t.duration_ms}))}});
ok('reconcile par trackId', rec.data.ready===true && rec.data.verified.length===3);
ok('nom de fichier libre enregistre', rec.data.verified[0].fileName.startsWith('nimporte-quel-nom'));
ok('soiree prete', rec.data.party.state==='prete');
ok('resolveur bascule en jeu apres ouverture du salon', true);

// ── Salon ──
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
ok('resolveur → jeu',(await J('GET','/api/me',{headers:{'X-Participant-Token':tk.Alice}})).data.screen==='jeu');
const sA=cli(B),sB=cli(B);
await p(sA,E.PLAYER_JOIN,{token:tk.Alice}); await p(sB,E.PLAYER_JOIN,{token:tk.Bob});

// ── Compteur de votes remonte a l'hote meme sans auto-reveal ──
await J('PATCH',`/api/host/parties/${code}/settings`,{headers:HT,body:{autoReveal:false}});
const H2=cli(B); await p(H2,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const t0=tr.find(t=>t.proposed_by==='Alice');
await p(H2,E.HOST_START_ROUND,{trackId:t0.id});
const vp=once(H2,E.STATE_VOTE_PROGRESS);
await p(sB,E.PLAYER_VOTE,{votedId:ids.Alice});
const prog=await vp;
ok('progression des votes vers l hote', prog && prog.voted===1, `${prog?.voted}/${prog?.connected}`);

// ── Se declarer pret DES le reveal ──
await p(H2,E.HOST_REVEAL,{title:t0.title,artist:t0.artist,player:'Alice',playerId:ids.Alice});
const rp=once(H2,E.STATE_READY_PROGRESS);
await p(sA,E.PLAYER_READY,{ready:true});
const r1=await rp;
ok('pret accepte pendant le reveal', r1 && r1.ready===1, `${r1?.ready}/${r1?.connected}`);
ok('identifiants en attente transmis', Array.isArray(r1.pendingIds));

// ── L'entracte NE remet PAS les prets a zero ──
await p(H2,E.HOST_APPLY_SCORES,{events:[{participantId:ids.Bob,points:1,reason:'finder'}]});
const rp2=once(H2,E.STATE_READY_PROGRESS);
await p(H2,E.HOST_NEXT_ROUND,{});
const r2=await rp2;
ok('pret conserve a l entracte', r2 && r2.ready===1, `${r2?.ready}/${r2?.connected} — le geste n'est pas perdu`);

// ── Une nouvelle manche remet a zero ──
await p(sB,E.PLAYER_READY,{ready:true});
const t1=tr.find(t=>t.id!==t0.id);
await p(H2,E.HOST_START_ROUND,{trackId:t1.id});
await new Promise(r=>setTimeout(r,200));
const rp3=once(H2,E.STATE_READY_PROGRESS,1500);
await p(sA,E.PLAYER_READY,{ready:false});
const r3=await rp3;
ok('nouvelle manche remet les prets a zero', r3 && r3.ready===0, `${r3?.ready}/${r3?.connected}`);

// ── Fin de playlist : le salon reste ouvert ──
await p(H2,E.HOST_REVEAL,{title:t1.title,artist:t1.artist,player:'x',playerId:ids.Bob});
await p(H2,E.HOST_NEXT_ROUND,{});
const t2=tr.find(t=>t.id!==t0.id&&t.id!==t1.id);
await p(H2,E.HOST_START_ROUND,{trackId:t2.id}); await p(H2,E.HOST_NEXT_ROUND,{});
const over=once(sA,E.STATE_GAME_OVER,2000);
const last=await p(H2,E.HOST_START_ROUND,{});
ok('playlist epuisee signalee', last.gameOver===true);
ok('podium diffuse', !!(await over));
ok('SALON TOUJOURS OUVERT', (await J('GET','/api/me',{headers:{'X-Participant-Token':tk.Alice}})).data.screen==='jeu',
   'les joueurs ne sont pas ejectes');

// ── Interface ──
const ph=await (await fetch(B+'/h/'+code+'/play',{headers:C})).text();
const hh=await (await fetch(B+'/h/'+code,{headers:C})).text();
const pl=await (await fetch(B+'/player')).text();
ok('bouton actualiser console', hh.includes('id="btn-refresh"'));
ok('tableau d appariement', hh.includes('id="match-table"')&&hh.includes('id="match-confirm"'));
ok('matching.js servi', (await fetch(B+'/shared/matching.js')).status===200);
ok('compteurs votes et prets', ph.includes('id="kpi-votes"')&&ph.includes('id="kpi-ready"'));
ok('retour au lecteur en fin', ph.includes('id="pod-back"'));
ok('bouton pret sur le reveal joueur', pl.includes('id="reveal-ready-btn"'));
const pj=await (await fetch(B+'/player/app.js')).text();
ok('sondage de l etat cote joueur', pj.includes('schedulePoll')&&pj.includes('visibilitychange'));
const hj=await (await fetch(B+'/host/app.js')).text();
ok('rafraichissement auto en collecte', hj.includes('scheduleAutoRefresh'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error("CRASH",e);process.exit(1)});
