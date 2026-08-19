const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3733); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),4000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const once=(s,e,ms=3000)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};

// ═══ Mot de passe admin ═══
const alg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password=adminsecret&next=/admin',redirect:'manual'});
const adm={Cookie:(alg.headers.get('set-cookie')||'').split(';')[0]};
const ov=await J('GET','/api/admin/overview',{headers:adm});
ok('etat de securite expose', ov.data.security && ov.data.security.adminPasswordSet===true);
ok('page admin previent si non protegee',(await (await fetch(B+'/admin/app.js')).text()).includes('ADMIN_PASSWORD'));

const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'N',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};

// ═══ Option de point de depart ═══
ok('saut d intro a 25% par defaut', cr.data.party.key_moment_pct===25);
const ids={}; for(const n of ['Alice','Bob'])
  ids[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
// Un morceau complet, un ajoute par lien (sans duree ni pochette)
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Alice},
  body:{source:'itunes',sourceId:'i1',title:'Complet',artist:'A',durationMs:240000,artworkUrl:'https://api/cover.jpg',album:'Album API'}});
await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk.Bob},
  body:{source:'spotify',sourceId:'s1',title:'ParLien',artist:'B',url:'https://open.spotify.com/track/s1'}});
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
let tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
const parLien=tr.find(t=>t.title==='ParLien');
ok('morceau par lien sans duree ni pochette', !parLien.duration_ms && !parLien.artwork_url);

// ═══ Enrichissement par les metadonnees du fichier ═══
const DATA_URL='data:image/jpeg;base64,'+'A'.repeat(200);
const rec=await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,body:{files:tr.map(t=>({
  trackId:t.id, fileName:'f-'+t.title+'.mp3',
  durationMs: t.title==='ParLien' ? 215000 : t.duration_ms,
  artworkUrl: DATA_URL, album:'Album du fichier',
}))}});
ok('appariement enregistre', rec.data.ready===true);
tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
const pl2=tr.find(t=>t.title==='ParLien'), cp=tr.find(t=>t.title==='Complet');
ok('DUREE recuperee du fichier', pl2.duration_ms===215000);
ok('POCHETTE recuperee du fichier', pl2.artwork_url===DATA_URL);
ok('ALBUM recupere du fichier', pl2.album==='Album du fichier');
ok('metadonnees API NON ecrasees', cp.artwork_url==='https://api/cover.jpg' && cp.album==='Album API',
   'la source reste prioritaire sur les tags');
ok('signale a l hote', rec.data.verified.some(v=>v.enriched===true));

// ═══ Point de depart ═══
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const r1=await p(H,E.HOST_START_ROUND,{trackId:cp.id});
ok('demarre au moment cle', r1.startOffsetMs===50000, `${r1.startOffsetMs} ms`);
await p(H,E.HOST_NEXT_ROUND,{});
await J('PATCH',`/api/host/parties/${code}/settings`,{headers:HT,body:{keyMomentPct:0}});
const H2=cli(B); await p(H2,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
const r2=await p(H2,E.HOST_START_ROUND,{trackId:pl2.id});
ok('OPTION : demarre au debut', r2.startOffsetMs===0, `${r2.startOffsetMs} ms`);

// ═══ Decompte visible sur le reveal ═══
const ph=await (await fetch(B+'/player')).text();
const gj=await (await fetch(B+'/player/game.js')).text();
ok('decompte sur l ecran de reveal', ph.includes('id="reveal-countdown"'));
ok('les deux decomptes animes', gj.includes("countdown('#countdown'")&&gj.includes("countdown('#reveal-countdown'"));
const yj=await (await fetch(B+'/play/app.js')).text();
ok('hote voit le decompte', yj.includes('Lancement dans'));
const pyh=await (await fetch(B+'/h/'+code+'/play',{headers:C})).text();
const hcons0=await (await fetch(B+'/h/'+code,{headers:C})).text();
ok('mode par defaut : fichiers', cr.data.party.source_mode==='fichiers');
const sw=await fetch(B+'/api/host/parties/'+code+'/settings',{method:'PATCH',headers:{...C,'content-type':'application/json'},body:JSON.stringify({sourceMode:'youtube'})});
ok('bascule de mode possible sans morceau', sw.status===200);
const swBad=await fetch(B+'/api/host/parties/'+code+'/settings',{method:'PATCH',headers:{...C,'content-type':'application/json'},body:JSON.stringify({sourceMode:'nimporte'})});
ok('mode inconnu ignore', swBad.status===200);
ok('verification des liens dans la console', hcons0.includes('id="verify-links-btn"'));
ok('import en lot dans la collecte', hcons0.includes('id="imp-urls"')&&hcons0.includes('data-mode="youtube"'));
const pw=await fetch(B+'/play/player-window.html');
ok('fenetre de lecture servie', pw.status===200);
const pwh=await pw.text();
ok('consentement avant chargement', pwh.includes('id="consent"')&&pwh.includes('youtube.com/iframe_api'));
ok('embed sans cookie dans la fenetre', pwh.includes('youtube-nocookie.com'));
const yth=await (await fetch(B+'/play/youtube-engine.js')).text();
ok('moteur au meme contrat', ['play','skip','stop','duck','togglePause','setVolume','position','isPlaying','onEnded'].every(m=>yth.includes(m+',')||yth.includes(m+' ')));
const yt=require('../lib/youtube');
ok('id extrait des formes usuelles', ['https://www.youtube.com/watch?v=dQw4w9WgXcQ','https://youtu.be/dQw4w9WgXcQ?t=9','https://music.youtube.com/watch?list=X&v=dQw4w9WgXcQ'].every(u=>yt.parseId(u)==='dQw4w9WgXcQ'));
ok('lien non youtube rejete', yt.parseId('https://open.spotify.com/track/abc')===null);
ok('embed sans cookie', yt.embedUrl('dQw4w9WgXcQ').startsWith('https://www.youtube-nocookie.com/embed/'));
ok('embed pilotable', yt.embedUrl('dQw4w9WgXcQ').includes('enablejsapi=1'));
const hpick=await (await fetch(B+'/h',{headers:C})).text();
ok('choix du mode a la creation', hpick.includes('name="np-mode"')&&hpick.includes('value="youtube"'));
const hcons=await (await fetch(B+'/h/'+code,{headers:C})).text();
ok('curseur de point de depart dans la console', hcons.includes('id="opt-key-moment"')&&hcons.includes('type="range"'));
ok('regles de jeu dans la console', hcons.includes('id="opt-rule-bluffer"')&&hcons.includes('id="opt-rule-trapper"'));
ok('lecteur debarrasse des reglages', !pyh.includes('id="opt-rule-bluffer"'));
const mj=await (await fetch(B+'/shared/matching.js')).text();
ok('extraction de pochette APIC', mj.includes("id === 'APIC'")&&mj.includes('pictureToDataUrl'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
