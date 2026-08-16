/**
 * ════════════════════════════════════════════════════════════════
 *  REPO — Soirées
 * ════════════════════════════════════════════════════════════════
 *
 *  Toutes les transitions d'état passent par ici. Aucun UPDATE de
 *  parties.state ailleurs dans le code : c'est ce qui permet de
 *  garantir que les invariants (numérotation à la clôture, cohérence
 *  des horodatages) ne peuvent pas être contournés.
 *
 *  Cycle : collecte → verrouillee → prete → terminee → archivee
 * ════════════════════════════════════════════════════════════════
 */

const db = require('../db');
const id = require('../lib/identity');

const MAX_CODE_ATTEMPTS = 50;

const PUBLIC_COLUMNS = `
  id, code, name, state,
  min_tracks_per_person, max_tracks_per_person,
  auto_reveal_on_all_votes, auto_advance_on_all_ready,
  allow_self_registration,
  rule_bluffer_enabled, rule_trapper_enabled, hide_indices_default,
  start_at_key_moment,
  created_at, last_activity_at, locked_at, archived_at
`;

// ─── Création ───────────────────────────────────────────────────

/**
 * Crée une soirée et renvoie le hostToken EN CLAIR.
 * C'est la seule et unique fois où il est lisible : il n'est stocké
 * que haché. Le client doit le persister immédiatement.
 */
async function create({ name, minTracks = 3, maxTracks = 6, settings = {} }) {
  const hostToken = id.generateToken();
  const hash      = id.hashToken(hostToken);

  // Le code est aléatoire : plutôt que de vérifier son unicité puis
  // d'insérer (fenêtre de course), on insère et on retente sur
  // violation de contrainte. La base arbitre.
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = id.generateCode(attempt < 30 ? 4 : 5);
    try {
      const row = await db.one(
        `INSERT INTO parties
           (code, name, host_token_hash,
            min_tracks_per_person, max_tracks_per_person,
            auto_reveal_on_all_votes, auto_advance_on_all_ready,
            allow_self_registration, rule_bluffer_enabled,
            rule_trapper_enabled, hide_indices_default, start_at_key_moment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${PUBLIC_COLUMNS}`,
        [
          code,
          id.cleanDisplayName(name) || 'Soirée blind test',
          hash,
          minTracks,
          maxTracks,
          settings.autoReveal  !== false,
          settings.autoAdvance !== false,
          settings.selfRegistration === true,
          settings.blufferRule !== false,
          settings.trapperRule === true,
          settings.hideIndices !== false,
          settings.startAtKeyMoment !== false,
        ]
      );
      return { party: row, hostToken };
    } catch (err) {
      if (err.code === '23505' && /parties_code_key/.test(err.constraint || '')) {
        continue;   // collision de code, on retire
      }
      throw err;
    }
  }
  throw new Error('Impossible de générer un code de soirée libre.');
}

// ─── Lecture ────────────────────────────────────────────────────

async function findByCode(code) {
  const normalized = id.normalizeCode(code);
  if (!id.isValidCode(normalized)) return null;
  return db.one(
    `SELECT ${PUBLIC_COLUMNS} FROM parties WHERE code = $1`,
    [normalized]
  );
}

async function findById(partyId) {
  return db.one(`SELECT ${PUBLIC_COLUMNS} FROM parties WHERE id = $1`, [partyId]);
}

/**
 * Vérifie la propriété. Renvoie la soirée si le jeton correspond, sinon
 * null — sans jamais indiquer laquelle des deux conditions a échoué.
 */
async function authenticateHost(code, hostToken) {
  const normalized = id.normalizeCode(code);
  const row = await db.one(
    `SELECT ${PUBLIC_COLUMNS}, host_token_hash FROM parties WHERE code = $1`,
    [normalized]
  );
  if (!row) return null;
  if (!id.tokenMatches(hostToken, row.host_token_hash)) return null;
  delete row.host_token_hash;
  return row;
}

/** Tableau de complétion affiché pendant la collecte. */
async function progress(partyId) {
  return db.many(
    `SELECT * FROM v_party_progress WHERE party_id = $1 ORDER BY display_name`,
    [partyId]
  );
}

async function touch(partyId) {
  await db.query(
    'UPDATE parties SET last_activity_at = now() WHERE id = $1',
    [partyId]
  );
}

// ─── Transitions d'état ─────────────────────────────────────────

/**
 * Graphe des transitions.
 *
 * Volontairement PERMISSIF vers l'arrière : une soirée terminée n'est
 * pas un cul-de-sac. On veut pouvoir rejouer la même playlist, la
 * rouvrir pour ajouter un morceau, ou tout reprendre la semaine
 * suivante avec le même groupe. Seul l'archivage est à sens unique —
 * et encore, on autorise le désarchivage.
 */
const ALLOWED_TRANSITIONS = {
  collecte:    ['verrouillee'],
  verrouillee: ['prete', 'collecte'],
  prete:       ['terminee', 'verrouillee'],
  terminee:    ['archivee', 'prete', 'verrouillee'],
  archivee:    ['terminee'],
};

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * Verrouille la collecte ET attribue les numéros d'acquisition dans la
 * même transaction. Les deux sont indissociables : une soirée
 * verrouillée sans numérotation ne permettrait pas de générer le
 * manifeste, et une numérotation sans verrouillage pourrait être
 * invalidée par un ajout de morceau juste après.
 *
 * Les paniers sous le minimum ne bloquent PAS — ils sont signalés à
 * l'hôte, qui confirme. Empêcher le verrouillage pour trois morceaux
 * manquants empêcherait la soirée d'avoir lieu.
 *
 * @returns {{party, numbered:number, belowMinimum:Array}}
 */
async function lock(partyId) {
  return db.tx(async (t) => {
    const party = await t.one(
      `SELECT ${PUBLIC_COLUMNS} FROM parties WHERE id = $1 FOR UPDATE`,
      [partyId]
    );
    if (!party) throw new Error('Soirée introuvable.');
    if (!canTransition(party.state, 'verrouillee')) {
      throw new Error(`Transition ${party.state} → verrouillee interdite.`);
    }

    // Qui est sous le minimum ? Information, pas blocage.
    const belowMinimum = await t.many(
      `SELECT pa.id, pa.display_name, count(tr.id)::int AS n
         FROM participants pa
         LEFT JOIN tracks tr
           ON tr.participant_id = pa.id AND tr.state <> 'excluded'
        WHERE pa.party_id = $1
        GROUP BY pa.id
       HAVING count(tr.id) < $2
        ORDER BY pa.display_name`,
      [partyId, party.min_tracks_per_person]
    );

    // Numérotation ALÉATOIRE.
    //
    // Ordonner par participant regroupait les morceaux d'une même
    // personne sous des numéros consécutifs : la playlist de la console
    // trahissait alors l'appartenance sans même afficher les noms, et
    // l'ordre du manifeste la rendait devinable au téléchargement.
    //
    // Le mélange est figé une fois pour toutes au verrouillage : le
    // numéro sert de clé de jointure avec les fichiers, il ne doit plus
    // bouger ensuite.
    const numbered = await t.many(
      `WITH ordered AS (
         SELECT tr.id, row_number() OVER (ORDER BY random()) AS n
           FROM tracks tr
          WHERE tr.party_id = $1 AND tr.state = 'proposed'
       )
       UPDATE tracks tr
          SET acquisition_no = ordered.n, state = 'locked'
         FROM ordered
        WHERE tr.id = ordered.id
       RETURNING tr.id`,
      [partyId]
    );

    const updated = await t.one(
      `UPDATE parties
          SET state = 'verrouillee', locked_at = now(), last_activity_at = now()
        WHERE id = $1
       RETURNING ${PUBLIC_COLUMNS}`,
      [partyId]
    );

    return { party: updated, numbered: numbered.length, belowMinimum };
  });
}

/** Rouvre la collecte : annule la numérotation. */
/**
 * Rouvre la collecte depuis N'IMPORTE QUEL état non archivé.
 *
 * Le chemin canonique passe par « verrouillée », mais l'exiger de
 * l'appelant transformait une action simple — « je veux rajouter un
 * morceau » — en séquence de deux requêtes dont l'ordre importait.
 */
async function unlock(partyId) {
  return db.tx(async (t) => {
    const party = await t.one('SELECT state FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
    if (!party) throw new Error('Soirée introuvable.');
    if (party.state === 'archivee') {
      throw new Error('Soirée archivée : désarchive-la d\'abord.');
    }
    if (party.state === 'collecte') return findById(partyId);
    // Effacer AUSSI les données de fichier, pas seulement l'état. La
    // contrainte file_duration_when_downloaded interdit qu'un morceau
    // 'proposed' porte une durée mesurée — et elle a raison : ces
    // données décrivent un téléchargement que le retour en collecte
    // vient d'invalider.
    await t.query(
      `UPDATE tracks
          SET acquisition_no = NULL, state = 'proposed',
              file_name = NULL, file_duration_ms = NULL
        WHERE party_id = $1 AND state IN ('locked','downloaded','verified','missing')`,
      [partyId]
    );
    return t.one(
      `UPDATE parties SET state='collecte', locked_at=NULL, last_activity_at=now()
        WHERE id=$1 RETURNING ${PUBLIC_COLUMNS}`,
      [partyId]
    );
  });
}

async function setState(partyId, next) {
  return db.tx(async (t) => {
    const party = await t.one('SELECT state FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
    if (!party) throw new Error('Soirée introuvable.');
    if (party.state === next) return findById(partyId);   // rien à faire
    if (!canTransition(party.state, next)) {
      throw new Error(`Transition ${party.state} → ${next} interdite.`);
    }
    // Désarchiver doit effacer la date, sinon la contrainte
    // archived_state_consistent rejette la mise à jour.
    const archived = next === 'archivee' ? 'now()'
                   : party.state === 'archivee' ? 'NULL'
                   : 'archived_at';
    return t.one(
      `UPDATE parties
          SET state = $2, archived_at = ${archived}, last_activity_at = now()
        WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [partyId, next]
    );
  });
}

/**
 * Met à jour les options modifiables en cours de soirée.
 *
 * Liste blanche explicite : sans elle, une clé inattendue dans le corps
 * de la requête pourrait écrire n'importe quelle colonne.
 */
const MUTABLE_SETTINGS = {
  blufferRule: 'rule_bluffer_enabled',
  trapperRule: 'rule_trapper_enabled',
  hideIndices: 'hide_indices_default',
  startAtKeyMoment: 'start_at_key_moment',
  selfRegistration: 'allow_self_registration',
  autoReveal:  'auto_reveal_on_all_votes',
  autoAdvance: 'auto_advance_on_all_ready',
};

async function updateSettings(partyId, settings = {}) {
  const sets = [];
  const values = [partyId];
  for (const [key, column] of Object.entries(MUTABLE_SETTINGS)) {
    if (typeof settings[key] !== 'boolean') continue;
    values.push(settings[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return findById(partyId);
  return db.one(
    `UPDATE parties SET ${sets.join(', ')}, last_activity_at = now()
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    values
  );
}

// ─── Administration ─────────────────────────────────────────────

async function listAll({ limit = 100 } = {}) {
  return db.many(
    `SELECT p.id, p.code, p.name, p.state,
            p.min_tracks_per_person, p.max_tracks_per_person,
            p.created_at, p.last_activity_at, p.locked_at, p.archived_at,
            (SELECT count(*) FROM participants pa WHERE pa.party_id = p.id)::int AS participants,
            (SELECT count(*) FROM tracks tr WHERE tr.party_id = p.id)::int AS tracks
       FROM parties p
      ORDER BY p.last_activity_at DESC
      LIMIT $1`,
    [limit]
  );
}

/** Archive les soirées dormantes. À planifier (une fois par jour suffit). */
async function archiveStale({ days = 90 } = {}) {
  const rows = await db.many(
    `UPDATE parties
        SET state = 'archivee', archived_at = now()
      WHERE archived_at IS NULL
        AND last_activity_at < now() - ($1 || ' days')::interval
     RETURNING id, code, name`,
    [days]
  );
  if (rows.length) console.log(`[parties] ${rows.length} soirée(s) archivée(s)`);
  return rows;
}

module.exports = {
  create, findByCode, findById, authenticateHost, progress, touch,
  lock, unlock, setState, canTransition, updateSettings,
  listAll, archiveStale,
};
