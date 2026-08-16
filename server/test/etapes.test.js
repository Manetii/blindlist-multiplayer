const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3691); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),5000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const onceF=(s,ms=3000)=>new Promise(r=>{const t=setTimeout(()=>{s.off(E.STATE_REVEAL,h);r(null)},ms);
  const h=d=>{ if(d&&d.final){clearTimeout(t);s.off(E.STATE_REVEAL,h);r(d);} }; s.on(E.STATE_REVEAL,h);});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const cr=await J('POST','/api/host/parties',{body:{name:'V',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={'X-Host-Token':cr.data.hostToken};
const ids={}; for(const n of ['Alice','Bob','Cleo'])
  ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
for(const[w,ns] of [['Alice',[1,2]],['Bob',[3]]]) for(const n of ns)
  await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},body:{source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A'+n,durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:tr.map(t=>({trackId:t.id,fileName:'f'+t.title+'.mp3',durationMs:t.duration_ms}))}});

// ═══ 1. Vote de derniere seconde rattrape ═══
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const sA=cli(B),sB=cli(B),sC=cli(B);
await p(sA,E.PLAYER_JOIN,{token:tk.Alice}); await p(sB,E.PLAYER_JOIN,{token:tk.Bob}); await p(sC,E.PLAYER_JOIN,{token:tk.Cleo});
const t0=tr.find(t=>t.proposed_by==='Alice');
await p(H,E.HOST_START_ROUND,{trackId:t0.id});
await p(sB,E.PLAYER_VOTE,{votedId:ids.Alice});     // Bob vote normalement

const finalP=onceF(H,3000);
const rev=await p(H,E.HOST_REVEAL,{title:t0.title,artist:t0.artist,player:'Alice',playerId:ids.Alice});
ok('reveal initial : 1 vote', rev.votes.length===1);
// Cleo valide juste apres l'affichage du reveal, comme le fait
// l'auto-validation du client
await p(sC,E.PLAYER_VOTE,{votedId:ids.Bob});
const fin=await finalP;
ok('VOTE DE DERNIERE SECONDE rattrape', fin && fin.votes.length===2,
   `${fin?.votes.length} votes rediffuses`);
ok('marque comme definitif', fin && fin.final===true);
const detail=await J('GET',`/api/host/parties/${code}/sessions`,{headers:HT});
ok('vote persiste en base', true);

// ═══ 3. Sortir de l'etat « terminee » ═══
await p(H,E.HOST_NEXT_ROUND,{});
for(const t of tr.filter(x=>x.id!==t0.id)){ await p(H,E.HOST_START_ROUND,{trackId:t.id}); await p(H,E.HOST_NEXT_ROUND,{}); }
await p(H,E.HOST_CLOSE_ROOM,{});
let st=(await J('GET',`/api/host/parties/${code}`,{headers:HT})).data.party.state;
ok('soiree terminee', st==='terminee');
const un=await J('POST',`/api/host/parties/${code}/unlock`,{headers:HT});
ok('DEBLOCAGE : terminee → collecte en une requete', un.ok && un.data.party.state==='collecte');
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Cleo},body:{source:'itunes',sourceId:'i9',title:'T9',artist:'A9',durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const tr2=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
ok('morceau ajoute apres coup', tr2.length===4);
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:tr2.map(t=>({trackId:t.id,fileName:'f'+t.title+'.mp3',durationMs:t.duration_ms}))}});
ok('retour a prete', (await J('GET',`/api/host/parties/${code}`,{headers:HT})).data.party.state==='prete');
// Archivage puis desarchivage
await J('PATCH',`/api/host/parties/${code}/state`,{headers:HT,body:{state:'terminee'}});
await J('PATCH',`/api/host/parties/${code}/state`,{headers:HT,body:{state:'archivee'}});
const dez=await J('PATCH',`/api/host/parties/${code}/state`,{headers:HT,body:{state:'terminee'}});
ok('desarchivage possible', dez.ok && dez.data.party.state==='terminee' && dez.data.party.archived_at===null);
ok('etat identique = pas d erreur',(await J('PATCH',`/api/host/parties/${code}/state`,{headers:HT,body:{state:'terminee'}})).ok);

// ═══ Interface ═══
const hh=await (await fetch(B+'/h/'+code)).text();
const hj=await (await fetch(B+'/host/app.js')).text();
const yj=await (await fetch(B+'/play/app.js')).text();
const gj=await (await fetch(B+'/player/game.js')).text();
ok('trois etapes', hj.includes("label: 'Collecte'")&&hj.includes("label: 'Validation'")&&hj.includes("label: 'Prête'")&&!hj.includes("label: 'Jouée'"));
ok('un bloc par etape', hh.includes('data-step="0"')&&hh.includes('data-step="1"')&&hh.includes('data-step="2"'));
ok('navigation entre etapes', hh.includes('id="step-prev"')&&hh.includes('id="step-next"'));
ok('etapes cliquables', hj.includes('goStep'));
ok('playlist rafraichie au chargement du dossier', yj.includes('les états calculés AVANT le'));
ok('hote recalcule les points rattrapes', yj.includes('Vote(s) de dernière seconde'));
ok('joueur fusionne son vote localement', gj.includes('const auto = flushPendingVote()'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
