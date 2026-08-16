const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3671); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));

// ═══ Plafond sur la creation de soirees ═══
let created=0, blocked=0;
for(let i=0;i<13;i++){
  const r=await J('POST','/api/host/parties',{body:{name:'Spam'+i}});
  if(r.status===201) created++; else if(r.status===429) blocked++;
}
ok('creation plafonnee', created===10 && blocked===3, `${created} creees, ${blocked} refusees (429)`);
const last=await J('POST','/api/host/parties',{body:{name:'X'}});
ok('en-tete Retry-After', last.status===429 && last.data.retryAfter>0, `${last.data.retryAfter} s`);

// ═══ Plafond sur l'import ═══
let imp=0, impBlocked=0;
for(let i=0;i<7;i++){
  const r=await J('POST','/api/host/import',{body:{format:'blindtest-party',version:1,party:{name:'I'+i},participants:[],tracks:[]}});
  if(r.status===201) imp++; else if(r.status===429) impBlocked++;
}
ok('import plafonne', imp===5 && impBlocked===2, `${imp} imports, ${impBlocked} refuses`);

// ═══ /network ne fuit rien derriere un proxy ═══
const local=await J('GET','/api/host/network');
ok('adresses locales exposees hors proxy', Array.isArray(local.data.addresses) && local.data.hosted===false,
   local.data.addresses.map(a=>a.address).join(', ')||'(aucune)');
const proxied=await J('GET','/api/host/network',{headers:{'X-Forwarded-For':'203.0.113.9','X-Forwarded-Host':'app.onrender.com'}});
ok('AUCUNE adresse derriere un proxy', proxied.data.addresses.length===0 && proxied.data.hosted===true,
   'en ligne, cette route ne divulgue rien');

// ═══ Enumeration de codes freinee ═══
let probes=0, refused=0;
for(let i=0;i<65;i++){
  const r=await J('GET','/api/join/ZZ'+String(i).padStart(2,'0'));
  if(r.status===404) probes++; else if(r.status===429) refused++;
}
ok('enumeration de codes freinee', refused>0, `${probes} sondages avant blocage, ${refused} refuses`);

// ═══ Configuration de deploiement ═══
const sv=require('fs').readFileSync(R+'/server.js','utf8');
const au=require('fs').readFileSync(R+'/lib/auth.js','utf8');
const dbf=require('fs').readFileSync(R+'/db/index.js','utf8');
ok('trust proxy', sv.includes("app.set('trust proxy', 1)"));
ok('port depuis l environnement', sv.includes('process.env.PORT'));
ok('CORS restreint en production', sv.includes("NODE_ENV === 'production'")&&sv.includes('PUBLIC_ORIGIN'));
ok('cookie secure en production', sv.includes("secure: process.env.NODE_ENV === 'production'"));
ok('SSL active hors local', dbf.includes('rejectUnauthorized: false'));
ok('secret de session surchargeable', au.includes('process.env.SESSION_SECRET'));
ok('arret propre sur SIGTERM', sv.includes("process.on('SIGTERM'"));
ok('health renvoie 503 si base HS', sv.includes('dbOk ? 200 : 503'));
ok('migrations verifiees au demarrage', sv.includes('migration(s) en attente'));
const h=await J('GET','/health');
ok('/health operationnel', h.status===200 && h.data.db===true);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
