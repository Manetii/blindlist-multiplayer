const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3788); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),4000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'X',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
for(const n of ['Alice','Bob']) await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}});
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
for(const[w,ns] of [['Alice',[1,2]],['Bob',[3,4]]]) for(const n of ns)
  await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},body:{source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A'+n,durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
let tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
ok('4 morceaux verrouilles', tr.length===4);

// ── Appariement PARTIEL : 3 sur 4 ──
const part=await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,
  body:{files:tr.slice(0,3).map(t=>({trackId:t.id,fileName:'Artiste - '+t.title+'.mp3',durationMs:t.duration_ms}))}});
ok('appariement partiel non pret', part.data.ready===false && part.data.missing.length===1);
ok('soiree reste verrouillee', (await J('GET',`/api/host/parties/${code}`,{headers:HT})).data.party.state==='verrouillee');

// ── Écarter le morceau introuvable débloque ──
const orphan=tr[3];
await J('POST',`/api/host/parties/${code}/tracks/${orphan.id}/exclude`,{headers:HT});
const after=await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT});
ok('morceau ecarte sort de la playlist', after.data.tracks.length===3);
ok('morceau ecarte reste visible', after.data.excluded.length===1 && after.data.excluded[0].id===orphan.id);

const done=await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,
  body:{files:after.data.tracks.map(t=>({trackId:t.id,fileName:t.file_name||('X-'+t.title+'.mp3'),durationMs:t.duration_ms}))}});
ok('DEBLOCAGE : soiree prete apres exclusion', done.data.ready===true && done.data.party.state==='prete');

// ── Réintégration renumérote sans deverrouiller ──
const res=await J('POST',`/api/host/parties/${code}/tracks/${orphan.id}/restore`,{headers:HT});
ok('reintegration', res.ok && res.data.track.acquisition_no!==null,
   'numero '+res.data.track.acquisition_no+' attribue sans deverrouiller');
const back=await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT});
ok('de retour dans la playlist', back.data.tracks.length===4 && back.data.excluded.length===0);

// ── Le salon joue des fichiers aux noms libres ──
const H=cli(B); const open=await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
ok('salon ouvert', open.ok);
const withFile=open.tracks.filter(t=>t.file_name);
ok('noms de fichiers transmis au salon', withFile.length>=3, withFile[0].file_name);
ok('aucun nom numerote impose', !/^\d{3}__/.test(withFile[0].file_name), withFile[0].file_name);

// ── Interface ──
const hh=await (await fetch(B+'/h/'+code,{headers:C})).text();
const hj=await (await fetch(B+'/host/app.js')).text();
const aj=await (await fetch(B+'/play/audio.js')).text();
ok('option ecarter proposee', hj.includes("écarter ce morceau"));
ok('seuls les cas surs sont auto-apparies', hj.includes('AUTO_THRESHOLD')&&hj.includes('AMBIGUITY_GAP'));
ok('liste deroulante par morceau', hj.includes('<select data-track='));
ok('non resolus remontes en tete', hj.includes('return ra ? 1 : -1'));
ok('fichiers non utilises listes', hj.includes('Fichiers non utilisés'));
ok('section morceaux ecartes', hh.includes('id="excluded-zone"'));
ok('bouton reintegrer', hj.includes('restoreTrack'));
ok('fichiers non utilises listes', hj.includes('Fichiers non utilisés'));
ok('moteur audio indexe par nom', aj.includes('files.set(f.name, f)'));
ok('plus d index par prefixe', !aj.includes('parseInt(m[1], 10)'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
