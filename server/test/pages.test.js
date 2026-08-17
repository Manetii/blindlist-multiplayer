const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3944); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));

// Login accessible sans session, et redirige les pages protegees
const lg=await fetch(B+'/login'); const lgh=await lg.text();
ok('page login reelle', lg.status===200 && lgh.includes('Accès administration') && !lgh.includes('placeholder'));
const h=await fetch(B+'/h',{redirect:'manual'});
// La console est ouverte : elle ne montre rien sans le hostToken que
// le navigateur détient, et l'API le vérifie à chaque requête.
ok('console accessible sans mot de passe', h.status===200);
const adm=await fetch(B+'/admin',{redirect:'manual'});
ok('seule l administration est protegee', adm.status===302);

// Accueil public
const home=await fetch(B+'/'); const hh=await home.text();
ok('accueil reel', home.status===200 && hh.includes('Rejoindre une soirée') && !hh.includes('placeholder'));
ok('accueil propose les 3 chemins', hh.includes('Créer une soirée') && hh.includes('Reprendre'));

// Assets
for (const [p,t] of [['/shared/base.css','text/css'],['/host/styles.css','text/css'],['/host/app.js','javascript'],['/player/styles.css','text/css']]) {
  const r=await fetch(B+p);
  ok('asset '+p, r.status===200 && r.headers.get('content-type').includes(t));
}

// Console apres login
const log=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(log.headers.get('set-cookie')||'').split(';')[0];
const hc=await fetch(B+'/h',{headers:{Cookie:ck}}); const hct=await hc.text();
ok('console servie apres login', hc.status===200 && hct.includes('Nouvelle soirée'));
ok('console porte les trois sections', ['s-people','s-dupes','s-collect','s-files','s-options','s-play'].every(id=>hct.includes(id)));
const hcode=await fetch(B+'/h/ABCD',{headers:{Cookie:ck}});
ok('console par code servie', hcode.status===200);

// Parcours complet via API
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const cr=await J('POST','/api/host/parties',{headers:{Cookie:ck},body:{name:'Soirée console',minTracks:1,maxTracks:3}});
const code=cr.data.party.code, HT={Cookie:ck,'X-Host-Token':cr.data.hostToken};
ok('creation depuis la console', cr.status===201, 'code '+code);
await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Alice'}});
const dup=await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'alice'}});
ok('conflit renvoie des suggestions', dup.status===409 && dup.data.suggestions.length>0, dup.data.suggestions[0]);
const c=await J('GET',`/api/host/parties/${code}`,{headers:HT});
ok('console lit progression', Array.isArray(c.data.progress) && c.data.progress.length===1);
ok('progression expose le minimum', 'meets_minimum' in c.data.progress[0] && 'min_tracks_per_person' in c.data.progress[0]);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
