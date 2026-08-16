const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3855); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/admin',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};

// Page servie
const pg=await fetch(B+'/admin',{headers:{Cookie:ck}}); const h=await pg.text();
ok('page admin reelle', pg.status===200 && h.includes('Supervision') && !h.includes('placeholder'));
ok('admin protegee',(await fetch(B+'/admin',{redirect:'manual'})).status===302);
ok('app.js servi',(await fetch(B+'/admin/app.js')).status===200);

// Deux soirees
const a=await J('POST','/api/host/parties',{headers:C,body:{name:'A',minTracks:1,maxTracks:3}});
const b=await J('POST','/api/host/parties',{headers:C,body:{name:'B',minTracks:1,maxTracks:3}});
await J('POST',`/api/host/parties/${a.data.party.code}/participants`,{headers:{...C,'X-Host-Token':a.data.hostToken},body:{displayName:'Alice'}});

const ov=await J('GET','/api/admin/overview',{headers:C});
ok('vue d ensemble', ov.data.parties.length===2 && 'timers' in ov.data.live, `${ov.data.parties.length} soirées`);
const det=await J('GET',`/api/admin/parties/${a.data.party.code}`,{headers:C});
ok('detail', det.ok && det.data.roster.length===1);
ok('detail sans secret', !JSON.stringify(det.data).match(/token_hash|hostToken/i));

// Suppression
const del=await J('DELETE',`/api/admin/parties/${a.data.party.code}`,{headers:C});
ok('suppression definitive', del.ok, del.data.deleted);
ok('cascade sur participants',(await J('GET',`/api/join/${a.data.party.code}`)).status===404);
ok('l autre soiree intacte',(await J('GET','/api/admin/overview',{headers:C})).data.parties.length===1);

// Reset
ok('reset sans confirmation refuse',(await J('POST','/api/admin/maintenance/reset',{headers:C,body:{}})).status===400);
const rst=await J('POST','/api/admin/maintenance/reset',{headers:C,body:{confirm:'SUPPRIMER TOUT'}});
ok('reset avec confirmation', rst.ok && rst.data.deleted===1);
ok('base vide',(await J('GET','/api/admin/overview',{headers:C})).data.parties.length===0);
ok('admin fermee sans session',(await J('GET','/api/admin/overview')).status===401);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
