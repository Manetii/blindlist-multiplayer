const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3877); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0];
const cr=await J('POST','/api/host/parties',{headers:{Cookie:ck},body:{name:'S',minTracks:2,maxTracks:4}});
const code=cr.data.party.code, HT={Cookie:ck,'X-Host-Token':cr.data.hostToken};
const al=await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Alice'}});
const lst=await J('GET',`/api/join/${code}`);
const cl=await J('POST',`/api/join/${code}/claim/${lst.data.participants[0].id}`);
const P={'X-Participant-Token':cl.data.token};

const mk=n=>({source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A',durationMs:200000});
await J('POST','/api/me/tracks',{headers:P,body:mk(1)});
const early=await J('POST','/api/me/submit',{headers:P});
ok('validation refusee sous le minimum',early.status===409&&early.data.belowMinimum,early.data.error);

await J('POST','/api/me/tracks',{headers:P,body:mk(2)});
const sub=await J('POST','/api/me/submit',{headers:P});
ok('validation acceptee au minimum',sub.ok);
ok('/api/me reflete la validation',(await J('GET','/api/me',{headers:P})).data.submitted===true);
ok('console voit la validation',(await J('GET',`/api/host/parties/${code}`,{headers:HT})).data.progress[0].submitted===true);

await J('POST','/api/me/tracks',{headers:P,body:mk(3)});
ok('ajout revoque la validation',(await J('GET','/api/me',{headers:P})).data.submitted===false);

await J('POST','/api/me/submit',{headers:P});
const tr=(await J('GET','/api/me/tracks',{headers:P})).data.tracks;
await J('DELETE','/api/me/tracks/'+tr[0].id,{headers:P});
ok('suppression revoque la validation',(await J('GET','/api/me',{headers:P})).data.submitted===false);

await J('POST','/api/me/submit',{headers:P});
ok('devalidation manuelle',(await J('DELETE','/api/me/submit',{headers:P})).ok);
ok('etat revenu a non valide',(await J('GET','/api/me',{headers:P})).data.submitted===false);

const net=await J('GET','/api/host/network',{headers:{Cookie:ck}});
ok('adresses reseau exposees',net.ok&&Array.isArray(net.data.addresses),
   net.data.addresses.map(a=>a.address).join(', ')+' port '+net.data.port);

await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
ok('validation impossible apres verrouillage',(await J('POST','/api/me/submit',{headers:P})).status===409);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
