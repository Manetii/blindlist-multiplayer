/**
 * ════════════════════════════════════════════════════════════════
 *  REPO — Participants
 * ════════════════════════════════════════════════════════════════
 *
 *  LE MODÈLE EN DEUX TEMPS
 *  -----------------------
 *  L'hôte crée les participants sans jeton : il ignore qui ouvrira
 *  quel lien. Il diffuse UN lien partagé, /j/<code>, et chacun choisit
 *  son nom dans la liste. Ce choix REVENDIQUE l'identité : un jeton
 *  personnel est alors émis, et le nom devient inaccessible aux autres.
 *
 *  Conséquence : une identité revendiquée est verrouillée. C'est une
 *  amélioration nette sur le modèle actuel, où le pseudo est libre à
 *  chaque connexion et où deux appareils peuvent se le disputer.
 *
 *  Contrepartie assumée : quiconque a le lien partagé peut revendiquer
 *  n'importe quel nom encore libre. Acceptable dans un cercle d'amis ;
 *  l'hôte peut libérer une revendication en cas d'erreur.
 * ════════════════════════════════════════════════════════════════
 */

const db = require('../db');
const id = require('../lib/identity');

const PUBLIC_COLUMNS = `
  id, party_id, display_name, name_key, color,
  is_managed, created_at, last_seen_at, submitted_at,
  (claimed_at IS NOT NULL) AS claimed,
  (submitted_at IS NOT NULL) AS submitted
`;

// ─── Création (par l'hôte) ──────────────────────────────────────

/**
 * Ajoute un participant à la liste. Sans jeton : il sera émis à la
 * revendication.
 *
 * @param {boolean} isManaged  true pour quelqu'un qui n'utilisera pas
 *   l'app (« Papy ») — l'hôte gérera ses morceaux à sa place.
 */
async function create(partyId, displayName, { isManaged = false } = {}) {
  const clean = id.cleanDisplayName(displayName);
  if (!id.isValidDisplayName(clean)) {
    return { ok: false, error: 'Nom invalide.' };
  }
  const nameKey = id.normalizeName(clean);

  const used = (await db.many(
    'SELECT color FROM participants WHERE party_id = $1', [partyId]
  )).map(r => r.color);

  try {
    const row = await db.one(
      `INSERT INTO participants (party_id, display_name, name_key, color, is_managed)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${PUBLIC_COLUMNS}`,
      [partyId, clean, nameKey, id.pickColor(used), isManaged]
    );
    return { ok: true, participant: row };
  } catch (err) {
    if (err.code === '23505') {
      // Nom déjà pris : on propose des variantes plutôt qu'un refus sec.
      const taken = (await db.many(
        'SELECT name_key FROM participants WHERE party_id = $1', [partyId]
      )).map(r => r.name_key);
      return {
        ok: false,
        error: `« ${clean} » est déjà dans la liste.`,
        conflict: true,
        suggestions: id.suggestAlternatives(clean, taken),
      };
    }
    throw err;
  }
}

// ─── Revendication ──────────────────────────────────────────────

/**
 * Un participant prend possession de son identité depuis son téléphone.
 * Renvoie le jeton EN CLAIR — seule occasion de le lire.
 *
 * L'UPDATE conditionnel (claimed_at IS NULL) rend l'opération atomique :
 * si deux personnes tapent le même nom au même instant, la seconde
 * n'affecte aucune ligne et reçoit le conflit. Pas de verrou explicite.
 */
async function claim(participantId) {
  const token = id.generateToken();
  const row = await db.one(
    `UPDATE participants
        SET token_hash = $2, claimed_at = now(), last_seen_at = now()
      WHERE id = $1 AND claimed_at IS NULL
     RETURNING ${PUBLIC_COLUMNS}`,
    [participantId, id.hashToken(token)]
  );

  if (!row) {
    return { ok: false, error: 'Ce nom vient d\'être pris par quelqu\'un d\'autre.', conflict: true };
  }
  return { ok: true, participant: row, token };
}

/** L'hôte libère une revendication (quelqu'un a cliqué sur le mauvais nom). */
async function release(participantId) {
  return db.one(
    `UPDATE participants
        SET token_hash = NULL, claimed_at = NULL
      WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [participantId]
  );
}

// ─── Authentification ───────────────────────────────────────────

/**
 * Résout un jeton de lien magique. C'est le point d'entrée de tout ce
 * que fait un participant : consulter son panier, rejoindre le salon.
 *
 * Le jeton étant haché de façon déterministe, on cherche par empreinte
 * directement — pas de balayage de table.
 *
 * Les colonnes sont listées explicitement plutôt que dérivées de
 * PUBLIC_COLUMNS : préfixer par découpage de chaîne produisait du SQL
 * invalide dès qu'une colonne calculée entre dans la liste.
 */
async function authenticate(token) {
  if (!token) return null;
  const row = await db.one(
    `SELECT p.id, p.party_id, p.display_name, p.name_key, p.color,
            p.is_managed, p.created_at, p.last_seen_at, p.submitted_at,
            (p.claimed_at   IS NOT NULL) AS claimed,
            (p.submitted_at IS NOT NULL) AS submitted,
            pt.code AS party_code, pt.state AS party_state
       FROM participants p
       JOIN parties pt ON pt.id = p.party_id
      WHERE p.token_hash = $1`,
    [id.hashToken(token)]
  );
  if (!row) return null;
  await db.query('UPDATE participants SET last_seen_at = now() WHERE id = $1', [row.id]);
  return row;
}

// ─── Lecture ────────────────────────────────────────────────────

async function listByParty(partyId) {
  return db.many(
    `SELECT ${PUBLIC_COLUMNS} FROM participants
      WHERE party_id = $1 ORDER BY display_name`,
    [partyId]
  );
}

/** Noms encore libres, pour l'écran de revendication. */
async function listUnclaimed(partyId) {
  return db.many(
    `SELECT ${PUBLIC_COLUMNS} FROM participants
      WHERE party_id = $1 AND claimed_at IS NULL ORDER BY display_name`,
    [partyId]
  );
}

/**
 * Effectif poussé dans le salon à son ouverture.
 *
 * can_be_answer distingue ceux qui peuvent être la bonne réponse de
 * ceux qui jouent en pure devinette. Un retardataire sans morceau doit
 * être RETIRÉ de la grille de vote : tout vote pour lui serait faux par
 * construction, et il encaisserait des points de bluffeur sans rien
 * faire.
 *
 * Calculé une fois à l'ouverture et figé : un joueur dont tous les
 * morceaux ont déjà été joués reste dans la grille. Compter les
 * attributions est un avantage légitime pour les joueurs attentifs.
 */
async function roster(partyId) {
  return db.many(
    `SELECT participant_id AS id, display_name, color, claimed, can_be_answer
       FROM v_salon_roster WHERE party_id = $1 ORDER BY display_name`,
    [partyId]
  );
}

// ─── Validation de la sélection ─────────────────────────────────

/**
 * Le participant déclare sa sélection terminée.
 *
 * Réversible tant que la collecte est ouverte : c'est un engagement,
 * pas un verrou. Le vrai verrou appartient à l'hôte.
 *
 * On refuse en dessous du minimum — mais l'hôte, lui, peut verrouiller
 * malgré des paniers incomplets. La contrainte porte sur ce que le
 * participant s'engage à faire, pas sur ce qui est jouable.
 */
async function submit(participantId) {
  const ctx = await db.one(
    `SELECT p.state, p.min_tracks_per_person,
            (SELECT count(*) FROM tracks t
              WHERE t.participant_id = pa.id AND t.state <> 'excluded')::int AS n
       FROM participants pa JOIN parties p ON p.id = pa.party_id
      WHERE pa.id = $1`,
    [participantId]
  );
  if (!ctx) return { ok: false, error: 'Participant inconnu.' };
  if (ctx.state !== 'collecte') {
    return { ok: false, error: 'La collecte est close.', closed: true };
  }
  if (ctx.n < ctx.min_tracks_per_person) {
    return {
      ok: false,
      error: `Il te faut au moins ${ctx.min_tracks_per_person} morceaux (tu en as ${ctx.n}).`,
      belowMinimum: true,
    };
  }
  const row = await db.one(
    `UPDATE participants SET submitted_at = now()
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [participantId]
  );
  return { ok: true, participant: row };
}

/** Annule la validation pour reprendre sa sélection. */
async function unsubmit(participantId) {
  const ctx = await db.one(
    `SELECT p.state FROM participants pa JOIN parties p ON p.id = pa.party_id
      WHERE pa.id = $1`,
    [participantId]
  );
  if (!ctx) return { ok: false, error: 'Participant inconnu.' };
  if (ctx.state !== 'collecte') {
    return { ok: false, error: 'La collecte est close — trop tard pour modifier.', closed: true };
  }
  const row = await db.one(
    `UPDATE participants SET submitted_at = NULL
      WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
    [participantId]
  );
  return { ok: true, participant: row };
}

// ─── Modification ───────────────────────────────────────────────

async function rename(participantId, displayName) {
  const clean = id.cleanDisplayName(displayName);
  if (!id.isValidDisplayName(clean)) {
    return { ok: false, error: 'Nom invalide.' };
  }
  try {
    const row = await db.one(
      `UPDATE participants SET display_name = $2, name_key = $3
        WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [participantId, clean, id.normalizeName(clean)]
    );
    // Renommer est gratuit : l'identité est portée par l'uuid, pas par
    // le nom. Morceaux, votes et scores suivent sans rien perdre.
    return { ok: true, participant: row };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, error: 'Ce nom est déjà pris.', conflict: true };
    }
    throw err;
  }
}

/** Suppression. Les morceaux partent avec (ON DELETE CASCADE). */
async function remove(participantId) {
  const row = await db.one(
    'DELETE FROM participants WHERE id = $1 RETURNING id, display_name',
    [participantId]
  );
  return row;
}

module.exports = {
  create, claim, release, authenticate, submit, unsubmit,
  listByParty, listUnclaimed, roster,
  rename, remove,
};
