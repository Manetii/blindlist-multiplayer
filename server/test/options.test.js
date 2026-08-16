const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const vm=require('vm'),fs=require('fs');
const sb={window:{}}; vm.createContext(sb);
vm.runInContext(fs.readFileSync(R+'/../public/play/scoring.js','utf8'),sb);
const Sc=sb.window.Scoring;
const B = 'http://127.0.0.1:' + (process.env.PORT || 3811); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),3000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};

// ── Regles activables ──
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'Opt',minTracks:1,maxTracks:3}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
ok('bluffeur actif par defaut', cr.data.party.rule_bluffer_enabled===true);
ok('piegeur inactif par defaut', cr.data.party.rule_trapper_enabled===false);
ok('indices masques par defaut', cr.data.party.hide_indices_default===true);

const up=await J('PATCH',`/api/host/parties/${code}/settings`,{headers:HT,body:{blufferRule:false,trapperRule:true}});
ok('reglages modifiables', up.data.party.rule_bluffer_enabled===false && up.data.party.rule_trapper_enabled===true);
const bad=await J('PATCH',`/api/host/parties/${code}/settings`,{headers:HT,body:{state:'archivee',code:'HACK'}});
ok('cle inconnue ignoree', bad.ok && bad.data.party.code===code && bad.data.party.state==='collecte');

// ── Effet des regles sur le calcul ──
const votes=[{voterId:'b',votedId:'a'},{voterId:'c',votedId:'b'},{voterId:'a',votedId:'b'}];
const both=Sc.compute(votes,'a',{blufferRule:true,trapperRule:false}).byPlayer;
ok('R2 active : bluffeur marque', both.get('b').total===3);
const noBluff=Sc.compute(votes,'a',{blufferRule:false,trapperRule:false}).byPlayer;
ok('R2 desactivee : plus de points bluffeur', noBluff.get('b').total===1,'garde son point de trouveur');
const none=[{voterId:'b',votedId:'c'},{voterId:'c',votedId:'b'}];
const trap=Sc.compute(none,'a',{blufferRule:false,trapperRule:true}).byPlayer;
ok('R3 active : piegeur marque', trap.get('a').total===1);
ok('R3 desactivee', !Sc.compute(none,'a',{blufferRule:false,trapperRule:false}).byPlayer.has('a'));

// ── Reglages transmis au salon ──
for(const n of ['Alice','Bob']) await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}});
const lst=await J('GET',`/api/join/${code}`);
const tk={}; for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Alice},body:{source:'itunes',sourceId:'1',title:'T',artist:'A',durationMs:200000}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const man=(await J('GET',`/api/host/parties/${code}/manifest`,{headers:HT})).data.manifest;
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:man.map(m=>({acquisitionNo:m.acquisition_no,fileName:m.expected_file_name,durationMs:m.duration_ms}))}});
const H=cli(B); const open=await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
ok('salon transmet les reglages', open.state.room.settings.blufferRule===false && open.state.room.settings.trapperRule===true,
   JSON.stringify(open.state.room.settings));

// ── Balisage v1 des panneaux ──
const ph=await (await fetch(B+'/h/'+code+'/play',{headers:C})).text();
const pc=await (await fetch(B+'/play/styles.css')).text();
const pj=await (await fetch(B+'/play/app.js')).text();
for(const id of ['tab-players','tab-playlist','btn-mode-tv','btn-help','close-players','close-playlist',
                 'tr-sort','tr-anon','btn-reset-played','opt-hide-indices','opt-rule-bluffer','opt-rule-trapper','help-overlay'])
  ok('id : '+id, ph.includes('id="'+id+'"'));
for(const sel of ['body.panel-players-open .col-players','body.panel-playlist-open .col-playlist',
                  '.tab-btn.active','#btn-mode-tv.active','.track-player-badge.anon',
                  '.playlist-tools-banner','.anonymize-switch','.options-section',
                  'body.panels-all-closed.round-active .vinyl-disc','@media (max-width: 899px)'])
  ok('style : '+sel, pc.includes(sel));
ok('panneaux persistes', pj.includes("'blindtest:panels'"));
ok('tri playlist', pj.includes('sortedTracks')&&pj.includes("player: (a, b)"));
ok('raccourcis T/J/P', pj.includes("case 'KeyT'")&&pj.includes("case 'KeyJ'")&&pj.includes("case 'KeyP'"));
ok('action principale sur Entree', pj.includes("case 'Enter'"));
ok('fermeture reveal par le fond', pj.includes('e.target === e.currentTarget'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
