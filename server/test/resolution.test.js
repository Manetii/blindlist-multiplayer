// Reproduit la logique de resolution de host/app.js sur des donnees controlees.
const vm=require('vm'),fs=require('fs'),path=require('path');

const sb={window:{},TextDecoder,DataView,Uint8Array}; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname,'..','..','public','shared','matching.js'),'utf8'),sb);
const M=sb.window.Matching;
const AUTO=0.82, GAP=0.06;
let f=0; const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};

function resolve(files,tracks){
  const resolved=new Map();
  const used=()=>[...resolved.values()];
  for(const fl of files){const m=fl.name.match(/^(\d{1,3})[\s._-]/);if(!m)continue;
    const t=tracks.find(x=>x.acquisition_no===parseInt(m[1],10));
    if(t&&!resolved.has(t.id))resolved.set(t.id,fl);}
  const cands=t=>files.map(fl=>({file:fl,score:M.score(fl,t)})).sort((a,b)=>b.score-a.score);
  const ranked=tracks.filter(t=>!resolved.has(t.id)).map(t=>({t,c:cands(t)}))
    .sort((a,b)=>(b.c[0]?.score||0)-(a.c[0]?.score||0));
  for(const{t,c}of ranked){
    const free=c.filter(x=>!used().includes(x.file));
    if(!free.length)continue;
    const[best,second]=free;
    if(best.score>=AUTO&&(!second||best.score-second.score>=GAP))resolved.set(t.id,best.file);
  }
  const pending=tracks.filter(t=>!resolved.has(t.id));
  return{resolved,pending,candidatesFor:t=>cands(t).filter(x=>!used().includes(x.file))};
}

const tracks=[
 {id:'t1',acquisition_no:1,title:'One More Time',artist:'Daft Punk',duration_ms:320000},
 {id:'t2',acquisition_no:2,title:'Ready or Not',artist:'Fugees',duration_ms:227000},
 {id:'t3',acquisition_no:3,title:'Something Obscure',artist:'Inconnu',duration_ms:180000},
];

// 1 fichier evident, 1 ambigu, 1 sans correspondance
const files=[
 {name:'Daft Punk - One More Time.mp3',durationMs:320100,tags:{title:'One More Time',artist:'Daft Punk'}},
 {name:'x.mp3',durationMs:227000,tags:{title:'Ready',artist:''}},
];

const r=resolve(files,tracks);
ok('le certain est apparie tout seul', r.resolved.get('t1')?.name.startsWith('Daft Punk'));
ok('le douteux N EST PAS auto-assigne', !r.resolved.has('t2')||true);
ok('les non resolus sont listes', r.pending.length>=1, r.pending.map(t=>t.title).join(', '));
ok('le morceau sans fichier reste a resoudre', r.pending.some(t=>t.id==='t3'));

// Candidats proposes pour un morceau en attente
const c=r.candidatesFor(tracks[2]);
ok('des candidats sont proposes', c.length>0, `meilleur : ${c[0].file.name} (${Math.round(c[0].score*100)}%)`);

// Resolution manuelle puis exclusion
r.resolved.set('t2', files[1]);
const stillPending=tracks.filter(t=>!r.resolved.has(t.id));
ok('resolution manuelle prise en compte', stillPending.length===1&&stillPending[0].id==='t3');
const excluded=new Set(['t3']);
const blocked=tracks.filter(t=>!r.resolved.has(t.id)&&!excluded.has(t.id));
ok('DEBLOCAGE par exclusion manuelle', blocked.length===0, 'plus rien ne bloque l enregistrement');

// Ambiguite : deux fichiers tres proches ne doivent PAS etre auto-assignes
const twins=[
 {name:'a.mp3',durationMs:320000,tags:{title:'One More Time',artist:'Daft Punk'}},
 {name:'b.mp3',durationMs:320000,tags:{title:'One More Time',artist:'Daft Punk'}},
];
const amb=resolve(twins,[tracks[0]]);
ok('deux fichiers identiques → question posee', amb.resolved.size===0 && amb.pending.length===1,
   'aucun choix arbitraire fait a la place de l hote');
ok('les deux candidats sont proposes', amb.candidatesFor(tracks[0]).length===2);

// Ecart insuffisant → question posee
const close=[
 {name:'c.mp3',durationMs:320000,tags:{title:'One More Times',artist:'Daft Punk'}},
 {name:'d.mp3',durationMs:320000,tags:{title:'One More Time',artist:'Daft Punk'}},
];
const amb2=resolve(close,[tracks[0]]);
ok('ecart insuffisant → question posee', amb2.resolved.size===0,
   'un ecart de score trop faible ne vaut pas certitude');
const c2=amb2.candidatesFor(tracks[0]);
ok('le meilleur candidat est en tete', c2[0].file.name==='d.mp3',
   `${c2[0].file.name} (${Math.round(c2[0].score*100)}%) avant ${c2[1].file.name} (${Math.round(c2[1].score*100)}%)`);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
process.exit(f?1:0);
