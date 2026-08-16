const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const {io:cli}=require('socket.io-client'); const E=require(R+'/../public/shared/events');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3755); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
const p=(s,e,d)=>new Promise(r=>{const t=setTimeout(()=>r({ok:false,timeout:true}),4000);s.emit(e,d,x=>{clearTimeout(t);r(x)})});
const once=(s,e,ms=3000)=>new Promise(r=>{const t=setTimeout(()=>r(null),ms);s.once(e,d=>{clearTimeout(t);r(d)})});
const login=async(pwd)=>{const r=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+pwd+'&next=/h',redirect:'manual'});return (r.headers.get('set-cookie')||'').split(';')[0];};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));

// ═══ Mot de passe admin distinct ═══
const admCk=await login('adminsecret');
ok('cookie admin obtenu', !!admCk);
ok('SANS session : admin fermee', (await J('GET','/api/admin/overview')).status===401);
ok('ADMIN peut administrer', (await J('GET','/api/admin/overview',{headers:{Cookie:admCk}})).status===200);
// Il n'y a plus de mot de passe hôte : créer une soirée est ouvert,
// et c'est son hostToken qui la protège ensuite.
ok('creation de soiree ouverte', (await J('POST','/api/host/parties',{body:{name:'Libre'}})).status===201);
ok('mauvais mot de passe refuse', !(await login('nope')).includes('host_session'));
const pg=await fetch(B+'/admin',{redirect:'manual'});
ok('page admin protegee', pg.status===302 && pg.headers.get('location').includes('/login'));
ok('page console ouverte', (await fetch(B+'/h',{redirect:'manual'})).status===200);

const C={Cookie:admCk};
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'Todo',minTracks:1,maxTracks:5}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:'Alice'}});
const lst=await J('GET',`/api/join/${code}`);
const tok=(await J('POST',`/api/join/${code}/claim/${lst.data.participants[0].id}`)).data.token;
const P={'X-Participant-Token':tok};

// ═══ BUG 1/2 — notification poussee ═══
const w=cli(B);
const sub=await p(w,E.PLAYER_WATCH,{token:tok});
ok('abonnement au canal soiree', sub.ok && sub.code===code);
ok('jeton invalide refuse', !(await p(cli(B),E.PLAYER_WATCH,{token:'x'})).ok);

await J('POST','/api/me/tracks',{headers:P,body:{source:'itunes',sourceId:'1',title:'T1',artist:'A1',durationMs:200000}});
const notif=once(w,E.STATE_PARTY_CHANGED,3000);
await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
const n1=await notif;
ok('VERROUILLAGE pousse au joueur', !!n1 && n1.state==='verrouillee', 'plus besoin de rafraichir');

const tr=(await J('GET',`/api/host/parties/${code}/tracks`,{headers:HT})).data.tracks;
const notif2=once(w,E.STATE_PARTY_CHANGED,3000);
await J('POST',`/api/host/parties/${code}/reconcile`,{headers:HT,
  body:{files:tr.map(t=>({trackId:t.id,fileName:'f.mp3',durationMs:t.duration_ms}))}});
ok('PASSAGE EN PRETE pousse', (await notif2)?.state==='prete');

const notif3=once(w,E.STATE_PARTY_CHANGED,3000);
const H=cli(B); await p(H,E.HOST_OPEN_ROOM,{code,hostToken:cr.data.hostToken});
ok('OUVERTURE DU SALON poussee', (await notif3)?.roomOpen===true, 'passage attente → jeu automatique');

// ═══ Creation de pseudo ═══
const c2=await J('POST','/api/host/parties',{headers:C,body:{name:'Ouvert'}});
const code2=c2.data.party.code, HT2={...C,'X-Host-Token':c2.data.hostToken};
ok('auto-inscription fermee par defaut',(await J('POST',`/api/join/${code2}/register`,{body:{displayName:'Zoe'}})).status===403);
await J('PATCH',`/api/host/parties/${code2}/settings`,{headers:HT2,body:{selfRegistration:true}});
const reg=await J('POST',`/api/join/${code2}/register`,{body:{displayName:'Zoé'}});
ok('creation de pseudo activable', reg.status===201 && !!reg.data.token, reg.data.magicLink);
const dup=await J('POST',`/api/join/${code2}/register`,{body:{displayName:'zoe'}});
ok('doublon → suggestions', dup.status===409 && dup.data.suggestions.length>0, dup.data.suggestions[0]);
ok('reglage visible cote joueur',(await J('GET',`/api/join/${code2}`)).data.party.selfRegistration===true);

// ═══ Coller un lien ═══
const P2={'X-Participant-Token':reg.data.token};
for(const[u,src] of [['https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT','spotify'],
                     ['https://youtu.be/dQw4w9WgXcQ','youtube'],
                     ['https://www.deezer.com/fr/track/3135556','deezer']]) {
  const r=await J('POST','/api/search/resolve-url',{headers:P2,body:{url:u}});
  ok('lien '+src+' reconnu', r.ok && r.data.track.source===src, r.data.track?.sourceId);
}
const pl=await J('POST','/api/search/resolve-url',{headers:P2,body:{url:'https://open.spotify.com/playlist/abc'}});
ok('playlist refusee avec explication', pl.status===422 && /playlist/i.test(pl.data.error));
ok('lien inconnu refuse',(await J('POST','/api/search/resolve-url',{headers:P2,body:{url:'https://exemple.fr/x'}})).status===422);
ok('resolution fermee sans jeton',(await J('POST','/api/search/resolve-url',{body:{url:'x'}})).status===401);

// ═══ Interface ═══
const pj=await (await fetch(B+'/player/app.js')).text();
const ph=await (await fetch(B+'/player')).text();
const hh=await (await fetch(B+'/h/'+code,{headers:C})).text();
ok('mode lecture seule applique a l attente', pj.includes("trackRow(t, 'readonly')"));
ok('defaut sur : aucun bouton', pj.includes("let button = '';"));
ok('veille WebSocket', pj.includes('startWatching')&&pj.includes('PLAYER_WATCH'));
ok('champ de creation de pseudo', ph.includes('id="claim-new-name"'));
ok('bloc coller un lien', ph.includes('id="paste-url"'));
ok('reglage auto-inscription cote hote', hh.includes('id="opt-self-reg"'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
