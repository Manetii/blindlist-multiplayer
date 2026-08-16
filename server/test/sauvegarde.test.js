const R = require('path').join(__dirname, '..');
// Sources simulees : le conteneur n'a pas d'acces reseau sortant.
for (const [m,src] of [['itunes','iTunes'],['deezer','Deezer'],['musicbrainz','MusicBrainz']]) {
  const p=require(R+'/lib/search/'+m);
  p.search=async q=>[{source:m,sourceId:m+'-1',title:'Around the World',artist:'Daft Punk',
    album:m==='musicbrainz'?null:'Homework',durationMs:429000,
    artworkUrl:m==='deezer'?null:'http://x/'+m,url:'http://'+m+'/1'}];
}
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3744); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const ck=(lg.headers.get('set-cookie')||'').split(';')[0]; const C={Cookie:ck};
const cr=await J('POST','/api/host/parties',{headers:C,body:{name:'Save',minTracks:1,maxTracks:4}});
const code=cr.data.party.code, HT={...C,'X-Host-Token':cr.data.hostToken};
for(const n of ['Alice','Bob']) await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}});
const lst=await J('GET',`/api/join/${code}`); const tk={};
for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
const P={'X-Participant-Token':tk.Alice};

// ═══ Recherche multi-source ═══
const s1=await J('GET','/api/search?q=daft',{headers:P});
ok('sources par defaut', s1.data.sources.join(',')==='itunes,deezer', s1.data.sources.join(','));
ok('MusicBrainz hors defaut', !s1.data.sources.includes('musicbrainz'), 'sa limite d 1 req/s ralentirait chaque recherche');
ok('toutes les sources annoncees', s1.data.available.length===3);
ok('deduplication inter-sources', s1.data.tracks.length===1, '3 sources, 1 morceau');
ok('la fiche la plus complete gagne', s1.data.tracks[0].artworkUrl!==null && s1.data.tracks[0].album!==null,
   `source retenue : ${s1.data.tracks[0].source}`);
const s2=await J('GET','/api/search?q=daft&sources=musicbrainz',{headers:P});
ok('filtrage par source', s2.data.sources.join(',')==='musicbrainz' && s2.data.tracks[0].source==='musicbrainz');

// ═══ Export / import ═══
for(const[w,n] of [['Alice',1],['Alice',2],['Bob',3]])
  await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},
    body:{source:'itunes',sourceId:'i'+n,title:'T'+n,artist:'A'+n,durationMs:200000,url:'https://ex/'+n}});
const exp=await fetch(B+`/api/host/parties/${code}/export`,{headers:{Cookie:ck,'X-Host-Token':cr.data.hostToken}});
const backup=await exp.json();
ok('export JSON', backup.format==='blindtest-party' && backup.version===1);
ok('participants exportes', backup.participants.length===2);
ok('morceaux exportes avec proprietaire', backup.tracks.length===3 && backup.tracks[0].proposedBy);
ok('AUCUN SECRET dans la sauvegarde', !JSON.stringify(backup).match(/token|hash/i));
ok('reglages exportes', backup.party.settings.blufferRule===true);

const imp=await J('POST','/api/host/import',{headers:C,body:backup});
ok('import cree une nouvelle soiree', imp.status===201 && imp.data.party.code!==code,
   `${code} → ${imp.data.party.code}`);
ok('morceaux importes', imp.data.imported===3 && imp.data.participants===2);
ok('nouveau hostToken', imp.data.hostToken && imp.data.hostToken!==cr.data.hostToken);
const check=await J('GET',`/api/join/${imp.data.party.code}`);
ok('identites a revendiquer a nouveau', check.data.participants.every(p=>!p.claimed),
   'la sauvegarde ne transmet pas de session');
ok('fichier non conforme refuse',(await J('POST','/api/host/import',{headers:C,body:{format:'autre'}})).status===400);

// ═══ Interface ═══
const hh=await (await fetch(B+'/h/'+code,{headers:C})).text();
const ph=await (await fetch(B+'/player')).text();
ok('bouton sauvegarder', hh.includes('id="export-party"'));
ok('bouton importer', hh.includes('id="import-btn"'));
ok('filtres de source', ph.includes('id="source-filters"'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
