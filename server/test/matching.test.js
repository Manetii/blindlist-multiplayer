const R = require('path').join(__dirname, '..');
const vm=require('vm'),fs=require('fs');
const sb={window:{},TextDecoder,DataView,Uint8Array}; vm.createContext(sb);
vm.runInContext(fs.readFileSync(R+'/../public/shared/matching.js','utf8'),sb);
const M=sb.window.Matching;
let f=0; const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};

// ── Similarite ──
ok('titres identiques', M.dice('Around the World','Around the World')===1);
ok('remaster ignore', M.dice('One More Time','One More Time (Remastered 2021)')>0.9,
   M.dice('One More Time','One More Time (Remastered 2021)').toFixed(2));
ok('feat ignore', M.dice('Get Lucky','Get Lucky (feat. Pharrell Williams)')>0.9);
ok('accents ignores', M.dice('Ca plane pour moi','Ça plane pour moi')===1);
ok('titres differents', M.dice('Around the World','Ready or Not')<0.3);

// ── Nom de fichier ──
const p1=M.parseFileName('Daft Punk - One More Time.mp3');
ok('nom "Artiste - Titre"', p1.artist==='Daft Punk'&&p1.title==='One More Time');
const p2=M.parseFileName('07 - Fugees - Ready or Not.mp3');
ok('numero de piste retire', p2.artist==='Fugees'&&p2.title==='Ready or Not');
const p3=M.parseFileName('001__Daft_Punk__Around_the_World.mp3');
ok('ancien format v2 reconnu', p3.artist==='Daft_Punk', JSON.stringify(p3));

// ── Appariement ──
const tracks=[
 {id:'t1',acquisition_no:1,title:'One More Time',artist:'Daft Punk',duration_ms:320000},
 {id:'t2',acquisition_no:2,title:'Ready or Not',artist:'Fugees',duration_ms:227000},
 {id:'t3',acquisition_no:3,title:'Around the World',artist:'Daft Punk',duration_ms:429000},
];
const files=[
 {name:'a.mp3',durationMs:320500,tags:{title:'One More Time',artist:'Daft Punk'}},
 {name:'b.mp3',durationMs:227100,tags:{title:'Ready Or Not (Remastered)',artist:'The Fugees'}},
 {name:'c.mp3',durationMs:429200,tags:{title:'',artist:''}},   // sans tags
];
const r=M.match(files,tracks);
const of_=id=>r.matches.find(m=>m.track.id===id);
ok('appariement exact sans renommage', of_('t1').file.name==='a.mp3', of_('t1').confidence.label);
ok('tolerance remaster + article', of_('t2').file.name==='b.mp3', of_('t2').confidence.label);
ok('fichier sans tags apparie par duree', of_('t3').file?.name==='c.mp3',
   of_('t3').file?'via duree seule':'non apparie');
ok('statistiques', r.stats.matched===3&&r.stats.missing===0, JSON.stringify(r.stats));

// ── Prefixe numerique = certitude ──
const num=M.match([{name:'003__x.mp3',durationMs:1,tags:{title:'zzz',artist:'zzz'}}],tracks);
const m3=num.matches.find(m=>m.track.id==='t3');
ok('prefixe numerique prioritaire', m3.file.name==='003__x.mp3'&&m3.byNumber===true,'malgre des tags faux');

// ── Un fichier ne sert qu'une fois ──
const dup=M.match([files[0],{...files[0],name:'copie.mp3'}],tracks);
const used=dup.matches.filter(m=>m.file).map(m=>m.file.name);
ok('pas de fichier attribue deux fois', new Set(used).size===used.length, used.join(','));

// ── Sous le seuil : on n'invente pas ──
const junk=M.match([{name:'z.mp3',durationMs:5000,tags:{title:'qqq',artist:'www'}}],tracks);
ok('appariement improbable refuse', junk.stats.matched===0);

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
process.exit(f?1:0);
