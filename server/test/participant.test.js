const R = require('path').join(__dirname, '..');
// Simule iTunes : le conteneur n'a pas d'acces reseau sortant vers Apple.
const itunes=require(R+'/lib/search/itunes');
itunes.search=async q=>[
 {source:'itunes',sourceId:'1',title:'Around the World',artist:'Daft Punk',album:'Homework',durationMs:429000,artworkUrl:'x'},
 {source:'itunes',sourceId:'2',title:'Around The World (Remastered)',artist:'Daft Punk',album:'Homework',durationMs:429400,artworkUrl:'x'},
 {source:'itunes',sourceId:'3',title:'Ready or Not',artist:'Fugees',album:'The Score',durationMs:227000,artworkUrl:'x'}];
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3955); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const call=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{status:r.status,ok:r.ok,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
// Pages servies
for(const[p,l] of [['/p/ABCD/xyz','lien magique'],['/j/ABCD','choix du nom'],['/r/ABCD','QR']]){
  const r=await fetch(B+p); const h=await r.text();
  ok(`page ${l}`, r.status===200 && h.includes('data-screen="collect"'));
}
const css=await fetch(B+'/player/styles.css'), js=await fetch(B+'/player/app.js');
ok('CSS et JS servis',css.status===200&&js.status===200);

// Parcours
const log=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(log.headers.get('set-cookie')||'').split(';')[0];
const cr=await call('POST','/api/host/parties',{headers:{Cookie:ck},body:{name:'Soirée UI',minTracks:2,maxTracks:4}});
const code=cr.data.party.code, HT={Cookie:ck,'X-Host-Token':cr.data.hostToken};
await call('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Alice'}});
const bob=await call('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Bob'}});

const list=await call('GET',`/api/join/${code}`);
ok('liste des noms',list.data.participants.length===2&&list.data.participants.every(p=>!p.claimed));
const cl=await call('POST',`/api/join/${code}/claim/${list.data.participants[0].id}`);
ok('revendication → lien magique',cl.status===201,cl.data.magicLink);
const P={'X-Participant-Token':cl.data.token};
const after=await call('GET',`/api/join/${code}`);
ok('nom desormais grise',after.data.participants.filter(p=>p.claimed).length===1);

const me=await call('GET','/api/me',{headers:P});
ok('resolveur → panier',me.data.screen==='panier',`quota ${me.data.quota.min}-${me.data.quota.max}`);

const s=await call('GET','/api/search?q=daft',{headers:P});
ok('recherche',s.ok&&s.data.tracks.length>0,`${s.data.tracks.length} resultats`);
ok('dedup remaster',s.data.tracks.length===2,'les deux "Around the World" fusionnes');
ok('recherche fermee sans jeton',(await call('GET','/api/search?q=x')).status===401);

for(const t of s.data.tracks) await call('POST','/api/me/tracks',{headers:P,body:t});
const m2=await call('GET','/api/me',{headers:P});
ok('quota suit le panier',m2.data.quota.current===2&&m2.data.quota.meetsMinimum===true);

// Verrouillage pendant la collecte
await call('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const m3=await call('GET','/api/me',{headers:P});
ok('resolveur bascule en attente',m3.data.screen==='attente');
const blocked=await call('GET','/api/search?q=x',{headers:P});
ok('recherche fermee hors collecte',blocked.status===409,blocked.data.error);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
