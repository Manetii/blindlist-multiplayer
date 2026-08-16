const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3711); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),5000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const cr=await J('POST','/api/host/parties',{body:{name:'Persist',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={'X-Host-Token':cr.data.hostToken};
const ids={}; for(const n of ['Alice','Bob'])
  ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
for(const[w,ns] of [['Alice',[1,2]],['Bob',[3]]]) for(const n of ns)
  await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},body:{source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A'+n,durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:tr.map(t=>({trackId:t.id,fileName:'f'+t.title+'.mp3',durationMs:t.duration_ms}))}});

// Partie en cours : deux morceaux joues, des points
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const sA=cli(B); await p(sA,E.PLAYER_JOIN,{token:tk.Alice});
for(const t of tr.slice(0,2)){
  await p(H,E.HOST_START_ROUND,{trackId:t.id});
  await p(H,E.HOST_REVEAL,{title:t.title,artist:t.artist,player:'Alice',playerId:ids.Alice});
  await p(H,E.HOST_APPLY_SCORES,{events:[{participantId:ids.Bob,points:2,reason:'finder'}]});
  await p(H,E.HOST_NEXT_ROUND,{});
}
ok('deux morceaux joues', true);

// L'hote « rafraichit sa page » : nouveau socket, meme salon
H.io.engine.close(); await new Promise(r=>setTimeout(r,300));
const H2=cli(B); const re=await p(H2,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
ok('salon retrouve', re.ok);
ok('MORCEAUX JOUES conserves', (re.state.room.playedTrackIds||[]).length===2,
   `${(re.state.room.playedTrackIds||[]).length} morceaux memorises`);
ok('SCORES conserves', re.state.players.find(x=>x.id===ids.Bob).score===4,
   `Bob = ${re.state.players.find(x=>x.id===ids.Bob).score}`);
ok('joueur toujours connecte', re.state.players.find(x=>x.id===ids.Alice).connected===true);
ok('noms de fichiers transmis', re.tracks.every(t=>t.file_name));
const restant=re.tracks.filter(t=>!re.state.room.playedTrackIds.includes(t.id));
ok('un seul morceau restant', restant.length===1);
const nxt=await p(H2,E.HOST_START_ROUND,{});
ok('tirage evite les morceaux joues', nxt.ok && nxt.track.id===restant[0].id);

const yj=await (await fetch(B+'/play/app.js')).text();
ok('la console restaure l etat', yj.includes('res.state.room.playedTrackIds'));
ok('ouverture immediate du salon', yj.includes('// Le salon s\'ouvre IMMÉDIATEMENT'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
