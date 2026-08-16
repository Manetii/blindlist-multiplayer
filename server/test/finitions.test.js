const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3681); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
const J=async(m,u,o={})=>{const r=await fetch(B+u,{method:m,headers:{'Content-Type':'application/json',...(o.headers||{})},body:o.body?JSON.stringify(o.body):undefined});let j=null;try{j=await r.json()}catch{};return{ok:r.ok,status:r.status,data:j||{}}};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));

// ═══ 4. Numerotation melangee ═══
// Alice propose 5 morceaux, Bob 5 : si l'ordre suivait les joueurs,
// les numeros 1-5 seraient tous a l'un d'eux.
let groupes=0;
for(let essai=0;essai<6;essai++){
  const cr=await J('POST','/api/host/parties',{body:{name:'Shuffle'+essai,minTracks:1,maxTracks:6}});
  const code=cr.data.party.code, HT={'X-Host-Token':cr.data.hostToken};
  const who={};
  for(const n of ['Alice','Bob']) who[n]=(await J('POST',`/api/host/parties/${code}/participants`,{headers:HT,body:{displayName:n}})).data.participant.id;
  const lst=await J('GET',`/api/join/${code}`); const tk={};
  for(const pa of lst.data.participants) tk[pa.displayName]=(await J('POST',`/api/join/${code}/claim/${pa.id}`)).data.token;
  for(const w of ['Alice','Bob']) for(let n=1;n<=5;n++)
    await J('POST','/api/me/tracks',{headers:{'X-Participant-Token':tk[w]},body:{source:'itunes',sourceId:w+n,title:w+n,artist:'A',durationMs:200000}});
  await J('POST',`/api/host/parties/${code}/lock`,{headers:HT});
  const man=(await J('GET',`/api/host/parties/${code}/manifest`,{headers:HT})).data.manifest;
  const cinq=man.slice(0,5).map(m=>m.proposed_by);
  if(new Set(cinq).size===1) groupes++;
  if(essai===0) console.log('       ordre obtenu :', man.map(m=>m.proposed_by[0]).join(''));
}
ok('NUMEROTATION melangee', groupes<=1, `${groupes}/6 essais groupes par joueur (hasard pur : ~0,4/6 attendu)`);

// ═══ Interface ═══
const cr=await J('POST','/api/host/parties',{body:{name:'UI'}});
const code=cr.data.party.code;
const hh=await (await fetch(B+'/h/'+code)).text();
const hj=await (await fetch(B+'/host/app.js')).text();
const yh=await (await fetch(B+'/h/'+code+'/play')).text();
const yj=await (await fetch(B+'/play/app.js')).text();
const pc=await (await fetch(B+'/player/styles.css')).text();
const lo=await (await fetch(B+'/login')).text();

ok('navigation libre entre etapes', hj.includes('natural !== lastNatural'));
ok('plus de deconnexion sur la console', !hh.includes('action="/logout"'));
ok('vocabulaire : aller au lecteur', hh.includes('Aller au lecteur'));
ok('vocabulaire : retour a la console', yh.includes('Retour à la console'));
ok('login = administration', lo.includes('Accès administration') && !lo.includes('Accès organisateur'));
ok('plus de panneau de votes detaille', !yh.includes('id="votes-panel"'));
ok('attente fusionnee', yj.includes('function renderWaitingFor')&&yj.includes("ont voté"));
ok('cibles des votes jamais affichees', !yj.includes('vote-arrow'));
ok('anonymisation forcee en jeu', yj.includes('function anonymized')&&yj.includes('anonBox.disabled = inGame()'));
ok('fin de partie remet a zero', yj.includes('await AudioEngine.stop();')&&yj.includes('renderWaitingFor(null)'));
ok('police des tuiles de vote', pc.includes("font-family: 'Outfit', system-ui, sans-serif;\n  position: relative; aspect-ratio: 1;"));
ok('cesure propre des prenoms longs', pc.includes('overflow-wrap: break-word; hyphens: none;'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
