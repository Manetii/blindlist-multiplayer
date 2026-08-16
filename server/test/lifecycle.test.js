const R = require('path').join(__dirname, '..');
const db = require(R+'/db');
const P  = require(R+'/repos/party.repo');
const PA = require(R+'/repos/participant.repo');
const T  = require(R+'/repos/track.repo');

const ok = (l,c,x='') => console.log(`${c?'  ok  ':'ECHEC '} ${l}${x?' — '+x:''}`);

(async () => {
// ─── Soirée ───
const { party, hostToken } = await P.create({ name:'Soirée chez Marc', minTracks:2, maxTracks:3 });
ok('création soirée', !!party.id, `code ${party.code}, état ${party.state}`);
ok('hostToken en clair une seule fois', hostToken.length > 20 && !('host_token_hash' in party));
ok('auth bon jeton',  !!(await P.authenticateHost(party.code, hostToken)));
ok('auth faux jeton', (await P.authenticateHost(party.code, 'x'.repeat(32))) === null);
ok('code insensible casse/espaces', (await P.findByCode(' '+party.code.toLowerCase()+' '))?.code === party.code);

// ─── Participants ───
const marc   = (await PA.create(party.id, 'Marc')).participant;
const chloe  = (await PA.create(party.id, 'Chloé')).participant;
const papy   = (await PA.create(party.id, 'Papy', {isManaged:true})).participant;
const dup    = await PA.create(party.id, 'chloe');
ok('doublon accent+casse refusé', !dup.ok && dup.conflict, 'suggestions: '+dup.suggestions.join(', '));

// ─── Revendication ───
const c1 = await PA.claim(chloe.id);
ok('revendication', c1.ok && !!c1.token);
const c2 = await PA.claim(chloe.id);
ok('seconde revendication refusée', !c2.ok && c2.conflict);
const auth = await PA.authenticate(c1.token);
ok('auth par lien magique', auth?.id === chloe.id, `${auth.display_name} / soirée ${auth.party_code}`);
ok('auth mauvais jeton', (await PA.authenticate('nope')) === null);

// ─── Renommage : l'identité survit ───
await T.add(chloe.id, {source:'spotify', sourceId:'sp:1', title:'Around the World', artist:'Daft Punk', durationMs:429000});
const ren = await PA.rename(chloe.id, 'Chloé M.');
ok('renommage', ren.ok);
ok('morceaux conservés après renommage', (await T.listByParticipant(chloe.id)).length === 1);
ok('jeton toujours valide', (await PA.authenticate(c1.token))?.display_name === 'Chloé M.');

// ─── Panier & quota ───
await T.add(chloe.id, {source:'spotify', sourceId:'sp:2', title:'Ready or Not', artist:'Fugees', durationMs:227000});
await T.add(chloe.id, {source:'spotify', sourceId:'sp:3', title:'Voyager', artist:'Daft Punk', durationMs:227000});
const over = await T.add(chloe.id, {source:'spotify', sourceId:'sp:4', title:'X', artist:'Y'});
ok('quota max respecté', !over.ok && over.quotaReached, over.error);
const same = await T.add(marc.id, {source:'spotify', sourceId:'sp:1', title:'Around the World', artist:'Daft Punk', durationMs:429000});
ok('même morceau chez un AUTRE joueur accepté', same.ok);
await T.add(marc.id, {source:'spotify', sourceId:'sp:9', title:'Alive', artist:'Daft Punk', durationMs:300000});

// ─── Recompactage des positions ───
const list = await T.listByParticipant(chloe.id);
await T.remove(chloe.id, list[1].id);
ok('positions recompactées', (await T.listByParticipant(chloe.id)).map(t=>t.position).join(',') === '1,2');

// ─── Doublons inter-joueurs ───
const dups = await T.findDuplicates(party.id);
ok('doublon inter-joueurs détecté', dups.length === 1, dups[0].title+' → '+dups[0].claimants.map(c=>c.displayName).join(' vs '));
await T.exclude(dups[0].claimants[1].trackId);
ok('arbitrage', (await T.findDuplicates(party.id)).length === 0);

// ─── Verrouillage ───
const lock = await P.lock(party.id);
ok('verrouillage', lock.party.state === 'verrouillee', `${lock.numbered} morceaux numérotés`);
ok('sous-minimum signalé sans bloquer', lock.belowMinimum.length === 2, lock.belowMinimum.map(b=>`${b.display_name} (${b.n})`).join(', '));
const man = await T.manifest(party.id);
ok('manifeste numéroté', man.length === lock.numbered, man[0].expected_file_name);
const blocked = await T.add(chloe.id, {source:'x', sourceId:'z', title:'T', artist:'A'});
ok('ajout refusé après verrouillage', !blocked.ok && blocked.closed);

// ─── Vérification des fichiers ───
// Les numéros d'acquisition sont mélangés au verrouillage : on désigne
// les morceaux par leur PROPRIÉTAIRE, jamais par leur rang.
const dChloe = man.find(m => m.proposed_by.startsWith('Chloé'));
const dMarc  = man.find(m => m.proposed_by === 'Marc');
const rec = await T.reconcile(party.id, [
  { acquisitionNo: dChloe.acquisition_no, fileName:'a.mp3', durationMs: dChloe.duration_ms },
  { acquisitionNo: dMarc.acquisition_no,  fileName:'b.mp3', durationMs: dMarc.duration_ms + 60000 },
]);
ok('fichier conforme', rec.verified.length === 1);
ok('durée incohérente détectée', rec.mismatched.length === 1, rec.mismatched[0].reason);
ok('fichier manquant détecté', rec.missing.length === man.length - 2);

// ─── Roster de salon ───
const roster = await PA.roster(party.id);
const papyRow = roster.find(r => r.display_name === 'Papy');
ok('retardataire sans morceau exclu du vote', papyRow.can_be_answer === false);
ok('éligibilité suit les morceaux JOUABLES', roster.find(r=>r.display_name==='Marc').can_be_answer === false,
   'son unique morceau est en écart de durée');
ok('joueur aux fichiers verifies eligible', roster.find(r=>r.display_name.startsWith('Chloé')).can_be_answer === true);

// ─── Transitions ───
ok('transition interdite rejetée', await P.setState(party.id,'archivee').then(()=>false).catch(()=>true));
const un = await P.unlock(party.id);
ok('retour arrière collecte', un.state === 'collecte');
ok('numérotation annulée', (await T.manifest(party.id)).length === 0);

await db.close();
})().catch(e => { console.error('CRASH', e); process.exit(1); });
