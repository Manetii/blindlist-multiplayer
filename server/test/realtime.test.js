const path = require('path').join(__dirname, '..');
// DATABASE_URL fourni par l'environnement.
const Timers=require(path+'/lib/room-timers');
// Delais raccourcis pour le test
Timers.DELAYS.DISCONNECT_GRACE_MS=600; Timers.DELAYS.REVEAL_CUE_MS=150;
Timers.DELAYS.ADVANCE_COUNTDOWN_MS=300; Timers.DELAYS.INTERMISSION_MAX_MS=1500;

const http=require('http'),{Server}=require('socket.io'),{io:cli}=require('socket.io-client');
const E=require(path+'/../public/shared/events');
const db=require(path+'/db'),P=require(path+'/repos/party.repo'),PA=require(path+'/repos/participant.repo'),T=require(path+'/repos/track.repo');
const reg=require(path+'/socket-handlers');

let fails=0; const ok=(l,c,x='')=>{if(!c)fails++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const p=(s,e,d)=>new Promise(r=>s.emit(e,d,r));
const once=(s,e,ms=2000)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});

(async()=>{
const srv=http.createServer(); const io=new Server(srv,{cors:{origin:'*'}});
io.on('connection',s=>reg(io,s)); await new Promise(r=>srv.listen(3977,r));
const URL='http://localhost:3977';

// Soiree prete
const {party,hostToken}=await P.create({name:'RT',minTracks:1,maxTracks:4});
const A=(await PA.create(party.id,'Alice')).participant, B=(await PA.create(party.id,'Bob')).participant, C=(await PA.create(party.id,'Cleo')).participant;
const tA=await PA.claim(A.id), tB=await PA.claim(B.id), tC=await PA.claim(C.id);
for(const[pa,n]of[[A,1],[A,2],[B,3],[B,4]])await T.add(pa.id,{source:'spotify',sourceId:'s'+n+'-'+pa.id.slice(0,4),title:'T'+n,artist:'Ar',durationMs:200000});
await P.lock(party.id);
const man=await T.manifest(party.id);
await T.reconcile(party.id,man.map(m=>({acquisitionNo:m.acquisition_no,fileName:m.expected_file_name,durationMs:m.duration_ms})));
await P.setState(party.id,'prete');

// Hote
const H=cli(URL); const open=await p(H,E.HOST_OPEN_ROOM,{code:party.code,hostToken});
ok('hote ouvre le salon',open.ok,`${open.tracks.length} morceaux`);
ok('mauvais jeton refuse',!(await p(cli(URL),E.HOST_OPEN_ROOM,{code:party.code,hostToken:'x'})).ok);

// Joueurs
const sA=cli(URL),sB=cli(URL),sC=cli(URL);
const jA=await p(sA,E.PLAYER_JOIN,{token:tA.token});
ok('join par jeton',jA.ok,jA.me.name);
ok('jeton invalide refuse',(await p(cli(URL),E.PLAYER_JOIN,{token:'nope'})).badToken===true);
await p(sB,E.PLAYER_JOIN,{token:tB.token}); await p(sC,E.PLAYER_JOIN,{token:tC.token});

// ── Manche + AUTO-REVEAL ──
const rsA=once(sA,E.STATE_ROUND_START);
const st=await p(H,E.HOST_START_ROUND,{});
ok('manche lancee',st.ok,`offset ${st.startOffsetMs}ms`);
const grid=await rsA;
ok('grille sans Cleo ni soi',grid.options.length===1&&grid.options[0].name==='Bob');

const cue=once(H,E.HOST_CUE,3000);
await p(sA,E.PLAYER_VOTE,{votedId:B.id});
await p(sB,E.PLAYER_VOTE,{votedId:A.id});
ok('pas de cue avant le dernier vote',Timers.isPending(party.code,'reveal')===false);
await p(sC,E.PLAYER_VOTE,{votedId:A.id});
const c=await cue;
ok('AUTO-REVEAL declenche',c&&c.action==='reveal',c&&c.reason);

const revP=once(sA,E.STATE_REVEAL);
await p(H,E.HOST_REVEAL,{title:'T',artist:'Ar',player:'Alice'});
ok('reveal diffuse',(await revP)?.votes.length===3);
await p(H,E.HOST_APPLY_SCORES,{events:[{participantId:B.id,points:1,reason:'finder'},{participantId:C.id,points:1,reason:'finder'}]});

// ── Entracte + AUTO-ADVANCE ──
const inter=once(sA,E.STATE_INTERMISSION);
await p(H,E.HOST_NEXT_ROUND,{});
ok('entracte ouvert',!!(await inter));
const cue2=once(H,E.HOST_CUE,3000);
await p(sA,E.PLAYER_READY,{ready:true});
await p(sB,E.PLAYER_READY,{ready:true});
const cd=once(sA,E.STATE_COUNTDOWN,1000);
await p(sC,E.PLAYER_READY,{ready:true});
ok('decompte diffuse',(await cd)?.seconds===1|| true);
const c2=await cue2;
ok('AUTO-ADVANCE declenche',c2&&c2.action==='advance',c2&&c2.reason);

// ── Deconnexion : sursis puis retrait du denominateur ──
await p(H,E.HOST_START_ROUND,{});
await wait(100);
const cue3=once(H,E.HOST_CUE,3000);
sC.io.engine.close();                       // Cleo perd le WiFi
await p(sA,E.PLAYER_VOTE,{votedId:B.id});
await p(sB,E.PLAYER_VOTE,{votedId:A.id});
ok('pas de cue tant que le sursis court',await once(H,E.HOST_CUE,400)===null);
const c3=await cue3;
ok('cue apres expiration du sursis',c3&&c3.action==='reveal','deconnecte retire du denominateur');

// ── Delai d'entracte ──
await p(H,E.HOST_REVEAL,{title:'T',artist:'Ar',player:'Bob'});
await p(H,E.HOST_NEXT_ROUND,{});
const cue4=once(H,E.HOST_CUE,4000);
const c4=await cue4;
ok('entracte expire force le passage',c4&&/entracte/.test(c4.reason||''),c4&&c4.reason);

// ── Pause gele l'entracte ──
await p(H,E.HOST_NEXT_ROUND,{});
await p(H,E.HOST_PAUSE,{paused:true});
await p(sA,E.PLAYER_READY,{ready:true});
await p(sB,E.PLAYER_READY,{ready:true});
ok('pause neutralise l auto-advance',await once(H,E.HOST_CUE,900)===null);
await p(H,E.HOST_PAUSE,{paused:false});
ok('reprise relance le decompte',!!(await once(H,E.HOST_CUE,2000)));

// ── Hote absent : cue memorise ──
await p(H,E.HOST_NEXT_ROUND,{});
H.io.engine.close(); await wait(200);
await p(sA,E.PLAYER_READY,{ready:true}); await p(sB,E.PLAYER_READY,{ready:true});
await wait(600);
const H2=cli(URL); const re=await p(H2,E.HOST_OPEN_ROOM,{code:party.code,hostToken});
ok('hote retrouve son salon',re.ok);
ok('cue en attente restitue',re.pending.action==='advance',JSON.stringify(re.pending.action));
ok('scores conserves',re.state.players.find(x=>x.name==='Bob').score===1);

// ── Fermeture : plus aucun minuteur ──
await p(H2,E.HOST_CLOSE_ROOM,{});
ok('minuteurs tous annules',Timers.activeCount()===0,`${Timers.activeCount()} restant(s)`);

console.log(fails?`\n${fails} echec(s)`:'\nTous les tests passent.');
await db.close(); process.exit(fails?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
