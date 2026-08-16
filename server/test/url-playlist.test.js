const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3777); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'U',minTracks:1,maxTracks:5}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Alice'}});
const lst=await J('GET',`/api/join/${code}`);
const tok=(await J('POST',`/api/join/${code}/claim/${lst.data.participants[0].id}`)).data.token;
const P={'X-Participant-Token':tok};

// ── URL transmise et conservee ──
await J('POST','/api/me/tracks',{headers:P,body:{source:'itunes',sourceId:'1',title:'One More Time',
  artist:'Daft Punk',durationMs:320000,url:'https://music.apple.com/fr/album/one-more-time/1'}});
await J('POST','/api/me/tracks',{headers:P,body:{source:'itunes',sourceId:'2',title:'Ready or Not',
  artist:'Fugees',durationMs:227000}});
await J('POST','/api/me/tracks',{headers:P,body:{source:'itunes',sourceId:'3',title:'Introuvable',
  artist:'Personne',durationMs:180000,url:'https://music.apple.com/x/3'}});
const mine=(await J('GET','/api/me/tracks',{headers:P})).data.tracks;
ok('URL enregistree', mine[0].url==='https://music.apple.com/fr/album/one-more-time/1');
ok('URL facultative', mine[1].url===null);

await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const man=await J('GET',`/api/host/parties/${code}/manifest`,{headers:HT});
// Les numéros étant mélangés au verrouillage, on cherche l'entrée
// concernée au lieu de supposer sa position.
const avecUrl = man.data.manifest.filter(m => m.url);
ok('manifeste porte l URL', avecUrl.length === 2 && avecUrl.every(m => m.url.startsWith('https://')),
   `${avecUrl.length}/3 morceaux avec URL`);

const csvRes=await fetch(B+`/api/host/parties/${code}/manifest?format=csv`,{headers:{Cookie:ck,'X-Host-Token':cr.data.hostToken}});
const csv=await csvRes.text();
const head=csv.split('\n')[0].replace('\uFEFF','');
ok('colonne url dans le CSV', head.split(',').includes('url'), head);
ok('duree lisible dans le CSV', csv.includes('5:20'), 'format m:ss');
ok('fichier suggere, plus impose', head.includes('fichier_suggere'));

// ── Playlist plus courte que prevu ne bloque pas ──
const tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
ok('3 morceaux attendus', tr.length===3);
// On n'apparie que 2 morceaux et on ecarte le 3e, comme le ferait l'hote
const orphan=tr.find(t=>t.title==='Introuvable');
await J('POST',`/api/host/parties/${code}/tracks/${orphan.id}/exclude`,{headers:HT});
const rest=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
const rec=await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,
  body:{files:rest.map(t=>({trackId:t.id,fileName:'libre - '+t.title+'.mp3',durationMs:t.duration_ms}))}});
ok('PLAYLIST COURTE : soiree prete quand meme', rec.data.ready===true && rec.data.party.state==='prete',
   `${rec.data.verified.length} morceaux jouables sur 3 attendus`);

// ── Interface : liste deroulante complete ──
const hj=await (await fetch(B+'/host/app.js')).text();
ok('tous les fichiers dans chaque liste', hj.includes('mState.files\n      .map(f => ({ f, score')||hj.includes('.map(f => ({ f, score: Matching.score(f, track) }))'));
ok('fichier deja pris signale, pas masque', hj.includes('takenElsewhere')&&hj.includes('déjà utilisé'));
ok('preselection du meilleur candidat', hj.includes("chosen.name === f.name ? 'selected'"));
ok('classement par pertinence', hj.includes('.sort((a, b) => b.score - a.score)'));
ok('bouton JAMAIS desactive', hj.includes("$('#match-confirm').disabled = false"));
ok('confirmation avant ecart automatique', hj.includes('Ils seront écartés de la playlist'));
ok('tableau conserve si ecarts de duree', hj.includes('durée(s) incohérente(s)'));
const hc=await (await fetch(B+'/host/styles.css')).text();
ok('styles du tableau presents', hc.includes('.match-file select')&&hc.includes('.match-row.excluded'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
