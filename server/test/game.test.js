const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client');
const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3844); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
// Tout accuse de reception est borne : un handler qui ne repond pas
// doit faire echouer le test, pas le figer.
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),3000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const once=(s,e,ms=2500)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});

// Le calcul des points vit cote client : on l'evalue ici comme le navigateur.
const vm=require('vm'); const fs=require('fs');
const sandbox={window:{}}; vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(R+'/../public/play/scoring.js','utf8'),sandbox);
const Scoring=sandbox.window.Scoring;

(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};

// Pages servies
ok('page console de jeu',(await fetch(B+'/h/ABCD/play',{headers:C})).status===200);
for(const a of ['/play/app.js','/play/audio.js','/play/scoring.js','/play/styles.css','/player/game.js'])
  ok('asset '+a,(await fetch(B+a)).status===200);

// Soiree prete
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'Partie',minTracks:1,maxTracks:3}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
const ids={};
for(const n of ['Alice','Bob','Cleo']) ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const list=await J('GET',`/api/join/${code}`);
const tok={};
for(const pa of list.data.participants) tok[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
const mk=(n,d)=>({source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'Ar'+n,durationMs:d});
for(const[who,ns]of[['Alice',[1,2]],['Bob',[3,4]]])
  for(const n of ns) await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tok[who]},body:mk(n,200000)});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const man=(await J('GET',`/api/host/parties/${code}/manifest`,{headers:HT})).data.manifest;
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:man.map(m=>({acquisitionNo:m.acquisition_no,fileName:m.expected_file_name,durationMs:m.duration_ms}))}});
const tracks=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
ok('playlist jouable',tracks.length===4);

// Salon
const H=cli(B); const open=await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
ok('salon ouvert',open.ok,`${open.tracks.length} morceaux`);
const sA=cli(B),sB=cli(B),sC=cli(B);
const jA=await p(sA,E.PLAYER_JOIN,{token:tok.Alice});
await p(sB,E.PLAYER_JOIN,{token:tok.Bob}); await p(sC,E.PLAYER_JOIN,{token:tok.Cleo});
ok('joueurs connectes par jeton',jA.ok&&jA.me.name==='Alice');

// Manche sur un morceau d'Alice
const t=tracks.find(x=>x.proposed_by==='Alice');
const grid=once(sB,E.STATE_ROUND_START);
const st=await p(H,E.HOST_START_ROUND,{trackId:t.id});
ok('manche lancee',st.ok,`offset ${st.startOffsetMs} ms`);
const g=await grid;
ok('grille de vote de Bob',g.options.length===1&&g.options[0].name==='Alice','Cleo sans morceau, Bob exclu de sa propre grille');

const cue=once(H,E.HOST_CUE,3000);
await p(sB,E.PLAYER_VOTE,{votedId:ids.Alice});   // Bob trouve
await p(sC,E.PLAYER_VOTE,{votedId:ids.Bob});     // Cleo se trompe
await p(sA,E.PLAYER_VOTE,{votedId:ids.Bob});     // Alice se trompe
ok('AUTO-REVEAL',(await cue)?.action==='reveal');

const rv=once(sB,E.STATE_REVEAL);
const rev=await p(H,E.HOST_REVEAL,{title:t.title,artist:t.artist,player:'Alice',playerId:ids.Alice});
ok('reveal diffuse',(await rv)?.votes.length===3);

// Scoring cote client
const sc=Scoring.compute(rev.votes,ids.Alice,{trapperRule:false});
const byId=sc.byPlayer;
ok('R1 trouveur',byId.get(ids.Bob)?.reasons.includes('finder'));
ok('R2 bluffeur',byId.get(ids.Bob)?.reasons.filter(r=>r==='bluffer').length===2,'Bob designe a tort 2 fois');
ok('total Bob = 3',byId.get(ids.Bob)?.total===3);
ok('Alice ne gagne rien',!byId.has(ids.Alice)||byId.get(ids.Alice).total===0);
ok('explication lisible',Scoring.explain(byId.get(ids.Bob).reasons)==='a trouvé, a bluffé ×2',Scoring.explain(byId.get(ids.Bob).reasons));

// Ajustement manuel
const adj=new Map([[ids.Cleo,1]]);
const evs=Scoring.withAdjustments(sc.events,adj);
await p(H,E.HOST_APPLY_SCORES,{events:evs});
await new Promise(r=>setTimeout(r,200));
const stand=(await J('GET',`/api/host/parties/${code}/sessions`,{headers:HT})).data.standings;
const get=n=>stand.find(s=>s.display_name===n).score;
ok('scores persistes',get('Bob')===3&&get('Cleo')===1,stand.map(s=>s.display_name+'='+s.score).join(' '));

// Entracte + auto-advance
const inter=once(sA,E.STATE_INTERMISSION);
await p(H,E.HOST_NEXT_ROUND,{});
ok('entracte ouvert',!!(await inter));
const cue2=once(H,E.HOST_CUE,6000);   // le decompte dure 3 s : laisser de la marge
for(const s of [sA,sB,sC]) await p(s,E.PLAYER_READY,{ready:true});
ok('AUTO-ADVANCE',(await cue2)?.action==='advance');

// Fin de playlist
const replay=await p(H,E.HOST_START_ROUND,{trackId:t.id});
ok('morceau deja joue refuse proprement',replay.ok===false&&replay.alreadyPlayed===true,replay.error);
for(const tr of tracks.filter(x=>x.id!==t.id)){ await p(H,E.HOST_START_ROUND,{trackId:tr.id}); await p(H,E.HOST_NEXT_ROUND,{}); }
const over=once(sA,E.STATE_GAME_OVER,2000);
const last=await p(H,E.HOST_START_ROUND,{});
ok('playlist epuisee',last.gameOver===true);
ok('podium diffuse aux joueurs',!!(await over));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
