const R = require('path').join(__dirname, '..');
const db=require(R+'/db'); const {start,server}=require(R+'/server');
const B = 'http://127.0.0.1:' + (process.env.PORT || 3833); let f=0;
const ok=(l,c,x='')=>{if(!c)f++;console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`)};
(async()=>{
await start(); await new Promise(r=>setTimeout(r,300));
const lg=await fetch(B+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'password='+(process.env.ADMIN_PASSWORD||'adminsecret')+'&next=/h',redirect:'manual'});
const CK=(lg.headers.get('set-cookie')||'').split(';')[0];
const html=await (await fetch(B+'/player')).text();
const css =await (await fetch(B+'/player/styles.css')).text();
const js  =await (await fetch(B+'/player/game.js')).text();
const hdr =await (await fetch(B+'/player/header.js')).text();

// Balisage d'origine present
// 'player-header' a fondu dans la barre du haut partagee : l'identite
// et le score y sont, mais dans le composant commun a toutes les vues.
for(const id of ['player-topbar','header-dot','header-name','header-score',
                 'waiting-title','waiting-sub','vote-grid','vote-status','vote-validate-btn',
                 'reveal-title','reveal-artist','reveal-player','reveal-player-dot',
                 'reveal-verdict','reveal-art','reveal-art-placeholder'])
  ok('id v1 present : '+id, html.includes('id="'+id+'"'));
for(const cl of ['waiting-vinyl','waiting-pulse','vote-prompt-label','reveal-card','reveal-art-zone','reveal-divider'])
  ok('classe v1 : '+cl, html.includes(cl));
ok('ecrans v1 nommes comme avant', html.includes('data-screen="waiting"')&&html.includes('data-screen="vote"')&&html.includes('data-screen="reveal"'));

// Styles d'origine
for(const sel of ['.waiting-vinyl','.vote-tile-initial','.vote-tile.confirmed::after',
                  '.reveal-verdict.bluff','.verdict-icon','.header-score.bump','.connection-banner'])
  ok('style v1 : '+sel, css.includes(sel));
ok('animations v1 conservees', ['waitingSpin','tileIn','votePulse','cardIn','revealDot','scoreBump','pulseDot'].every(a=>css.includes(a)));

// Logique portee
ok('verdict combo v1', js.includes('Combo : trouvé + tu as bluffé'));
ok('verdict bluffeur v1', js.includes('Tu as bluffé un autre joueur'));
ok('verdict morceau perso v1', js.includes("était ton morceau"));
ok('selection puis validation v1', js.includes('Choisis un joueur')&&js.includes('Valider mon vote'));
ok('auto-validation au reveal', js.includes('flushPendingVote'));
ok('identite par participantId', js.includes('data-id="')&&!js.includes('data-pseudo'));
ok('header porte', hdr.includes('setPseudo')&&hdr.includes('bump'));
ok('nouveaute v2 : bouton pret', html.includes('id="ready-btn"'));

// ─── Console de jeu : visuel v1 ───
const ph  = await (await fetch(B+'/h/ABCD/play',{headers:{Cookie:CK}})).text();
const pc  = await (await fetch(B+'/play/styles.css')).text();
const pj  = await (await fetch(B+'/play/app.js')).text();
for(const id of ['vinyl','vinyl-art','vinyl-dot','np-status','np-title','np-artist',
                 'progress-bar','progress-fill','time-cur','time-tot','vol-slider','vol-val',
                 'btn-indices','btn-launch','btn-reveal','overlay','scoring-panel',
                 'rc-title','rc-artist','rc-player','rc-dot','reveal-art-zone'])
  ok('console id v1 : '+id, ph.includes('id="'+id+'"'));
for(const cl of ['vinyl-disc-grooves','vinyl-label','btn-game-action','btn-launch-round',
                 'btn-reveal-main','reveal-card-inner','reveal-col-left','reveal-col-right',
                 'player-center','controls-wrap','key-moment-row','btn-end-match'])
  ok('console classe v1 : '+cl, ph.includes(cl));
for(const sel of ['.vinyl-disc.spinning','@keyframes vinylSpin','body.indices-hidden .np-title',
                  '.btn-game-action.btn-reveal-main','.sc-vote-row.sc-correct','@keyframes rcDot',
                  'body.panels-all-closed .vinyl-disc'])
  ok('console style v1 : '+sel, pc.includes(sel));
ok('indices floutes par manche', pj.includes("classList.toggle('indices-hidden', S.settings.hideIndices"));
ok('bouton oeil actif', pj.includes("btn-indices"));
ok('vinyle tourne en lecture', pj.includes("classList.toggle('spinning'"));
ok('panneau de scoring v1', pj.includes('sc-vote-row')&&pj.includes('sc-player-row'));
// Le détail des votes ne vit plus QUE dans la modale de révélation :
// l'écran de jeu est visible de la salle.
ok('votes detailles seulement au reveal', !pj.includes("id=\"votes-panel\""));
ok('mode TV', pj.includes('panels-all-closed'));

console.log(f?`\n${f} echec(s)`:'\nTous les tests passent.');
server.close(); await db.close(); process.exit(f?1:0);
})().catch(e=>{console.error('CRASH',e);process.exit(1)});
