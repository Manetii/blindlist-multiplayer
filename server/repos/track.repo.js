/**
 * ════════════════════════════════════════════════════════════════
 *  REPO — Morceaux
 * ════════════════════════════════════════════════════════════════
 *
 *  Remplace le CSV et le matching flou de /prepare. L'association
 *  morceau ↔ joueur n'est plus déduite après coup : elle est native,
 *  puisque c'est le participant lui-même qui saisit.
 *
 *  Le rapprochement avec les fichiers se fait sur acquisition_no
 *  (préfixe du nom de fichier) et sur la durée mesurée — pas sur les
 *  tags ID3, qui dépendent de l'outil de téléchargement.
 * ════════════════════════════════════════════════════════════════
 */

const db = require('../db');

const DURATION_TOLERANCE_MS = 3000;   // écart admis entre API et fichier

const COLUMNS = `
  id, party_id, participant_id, position, acquisition_no,
  source, source_id, title, artist, album, duration_ms, artwork_url, url,
  state, file_name, file_duration_ms, created_at
`;

// ─── Panier ─────────────────────────────────────────────────────

async function listByParticipant(participantId) {
  return db.many(
    `SELECT ${COLUMNS} FROM tracks
      WHERE participant_id = $1 AND state <> 'excluded'
      ORDER BY position`,
    [participantId]
  );
}

/**
 * Ajoute un morceau au panier.
 *
 * Le quota est vérifié DANS la transaction, avec verrou sur les lignes
 * existantes : sans ça, deux ajouts simultanés depuis deux onglets
 * pourraient dépasser le maximum tous les deux.
 */
async function add(participantId, track) {
  return db.tx(async (t) => {
    const ctx = await t.one(
      `SELECT pa.party_id, p.state, p.max_tracks_per_person
         FROM participants pa JOIN parties p ON p.id = pa.party_id
        WHERE pa.id = $1`,
      [participantId]
    );
    if (!ctx) return { ok: false, error: 'Participant inconnu.' };
    if (ctx.state !== 'collecte') {
      return { ok: false, error: 'Les envois sont clos pour cette soirée.', closed: true };
    }

    const existing = await t.many(
      `SELECT id, position, source, source_id FROM tracks
        WHERE participant_id = $1 AND state <> 'excluded'
        ORDER BY position FOR UPDATE`,
      [participantId]
    );

    if (existing.length >= ctx.max_tracks_per_person) {
      return {
        ok: false,
        error: `Maximum atteint (${ctx.max_tracks_per_person}). Retires-en un pour ajouter.`,
        quotaReached: true,
      };
    }

    // Doublon dans SON PROPRE panier : refusé, c'est une erreur de clic.
    if (existing.some(e => e.source === track.source && e.source_id === track.sourceId)) {
      return { ok: false, error: 'Ce morceau est déjà dans ta sélection.' };
    }

    const nextPosition = existing.length
      ? Math.max(...existing.map(e => e.position)) + 1
      : 1;

    const row = await t.one(
      `INSERT INTO tracks
         (party_id, participant_id, position, source, source_id,
          title, artist, album, duration_ms, artwork_url, url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${COLUMNS}`,
      [
        ctx.party_id, participantId, nextPosition,
        track.source, track.sourceId,
        track.title, track.artist, track.album || null,
        track.durationMs || null, track.artworkUrl || null, track.url || null,
      ]
    );

    // Modifier son panier après l'avoir validé annule la validation :
    // sinon l'hôte croirait la sélection figée alors qu'elle bouge.
    await t.query('UPDATE participants SET submitted_at = NULL WHERE id = $1', [participantId]);
    await t.query('UPDATE parties SET last_activity_at = now() WHERE id = $1', [ctx.party_id]);
    return { ok: true, track: row, count: existing.length + 1 };
  });
}

/** Retire un morceau. Les positions restantes sont recompactées. */
async function remove(participantId, trackId) {
  return db.tx(async (t) => {
    const ctx = await t.one(
      `SELECT p.state FROM participants pa JOIN parties p ON p.id = pa.party_id
        WHERE pa.id = $1`,
      [participantId]
    );
    if (!ctx) return { ok: false, error: 'Participant inconnu.' };
    if (ctx.state !== 'collecte') {
      return { ok: false, error: 'Les envois sont clos.', closed: true };
    }

    const deleted = await t.one(
      'DELETE FROM tracks WHERE id = $1 AND participant_id = $2 RETURNING id',
      [trackId, participantId]
    );
    if (!deleted) return { ok: false, error: 'Morceau introuvable.' };

    // Recompactage : sans lui, les positions deviennent 1,3,4 et le
    // prochain ajout entrerait en collision avec la contrainte
    // UNIQUE (participant_id, position).
    await t.query(
      `WITH renumbered AS (
         SELECT id, row_number() OVER (ORDER BY position) AS n
           FROM tracks WHERE participant_id = $1 AND state <> 'excluded'
       )
       UPDATE tracks SET position = renumbered.n
         FROM renumbered WHERE tracks.id = renumbered.id`,
      [participantId]
    );
    await t.query('UPDATE participants SET submitted_at = NULL WHERE id = $1', [participantId]);
    return { ok: true };
  });
}

/**
 * Corrige un morceau déjà déposé.
 *
 * Sans cette route, la seule façon de rattraper une faute de frappe
 * était de supprimer puis de ré-ajouter — ce qui recompacte les
 * positions et fait perdre son rang au morceau. En mode YouTube, où
 * titre et artiste sont saisis à la main, l'erreur est fréquente et la
 * correction doit être anodine.
 *
 * L'URL est modifiable aussi : c'est le cas « je me suis trompé de
 * version ». Le contrôle d'intégrabilité est fait par l'appelant, qui
 * seul sait dans quel mode se trouve la soirée.
 */
async function update(participantId, trackId, patch) {
  return db.tx(async (t) => {
    const ctx = await t.one(
      `SELECT p.state FROM participants pa JOIN parties p ON p.id = pa.party_id
        WHERE pa.id = $1`,
      [participantId]
    );
    if (!ctx) return { ok: false, error: 'Participant inconnu.' };
    if (ctx.state !== 'collecte') {
      return { ok: false, error: 'Les envois sont clos.', closed: true };
    }

    const sets = [];
    const values = [trackId, participantId];
    for (const [key, column] of Object.entries({
      title: 'title', artist: 'artist', url: 'url', sourceId: 'source_id',
    })) {
      if (patch[key] === undefined) continue;
      values.push(String(patch[key]).slice(0, 500));
      sets.push(`${column} = $${values.length}`);
    }
    if (!sets.length) return { ok: false, error: 'Rien à modifier.' };

    const row = await t.one(
      `UPDATE tracks SET ${sets.join(', ')}
        WHERE id = $1 AND participant_id = $2
        RETURNING id`,
      values
    );
    if (!row) return { ok: false, error: 'Morceau introuvable.' };
    return { ok: true };
  });
}

// ─── Arbitrage (écran hôte) ─────────────────────────────────────

/**
 * Morceaux proposés par plusieurs personnes.
 *
 * Le jeu ne peut pas avoir deux bonnes réponses pour une même manche :
 * l'hôte doit trancher avant de verrouiller. Cas que l'implémentation
 * actuelle ne gère pas du tout — il casse la partie silencieusement.
 */
async function findDuplicates(partyId) {
  return db.many(
    `SELECT t.source, t.source_id,
            min(t.title)  AS title,
            min(t.artist) AS artist,
            json_agg(json_build_object(
              'trackId', t.id,
              'participantId', pa.id,
              'displayName', pa.display_name
            ) ORDER BY pa.display_name) AS claimants
       FROM tracks t
       JOIN participants pa ON pa.id = t.participant_id
      WHERE t.party_id = $1 AND t.state = 'proposed'
      GROUP BY t.source, t.source_id
     HAVING count(*) > 1`,
    [partyId]
  );
}

async function exclude(trackId) {
  // Même raison que dans party.repo.unlock() : un morceau 'excluded' ne
  // peut pas conserver de durée mesurée (contrainte
  // file_duration_when_downloaded).
  return db.one(
    `UPDATE tracks
        SET state = 'excluded', acquisition_no = NULL,
            file_name = NULL, file_duration_ms = NULL
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [trackId]
  );
}

/**
 * Remet un morceau écarté dans la playlist.
 *
 * Si la collecte est déjà verrouillée, on lui attribue tout de suite un
 * numéro d'acquisition à la suite des autres : sans cela il resterait
 * invisible du manifeste, et il faudrait déverrouiller puis reverrouiller
 * toute la soirée pour récupérer un seul morceau.
 */
async function restore(trackId) {
  return db.tx(async (t) => {
    const ctx = await t.one(
      `SELECT tr.party_id, p.state
         FROM tracks tr JOIN parties p ON p.id = tr.party_id
        WHERE tr.id = $1 AND tr.state = 'excluded'`,
      [trackId]
    );
    if (!ctx) return null;

    if (ctx.state === 'collecte') {
      return t.one(
        `UPDATE tracks SET state = 'proposed' WHERE id = $1 RETURNING ${COLUMNS}`,
        [trackId]
      );
    }
    const next = await t.one(
      `SELECT coalesce(max(acquisition_no), 0) + 1 AS n FROM tracks WHERE party_id = $1`,
      [ctx.party_id]
    );
    return t.one(
      `UPDATE tracks SET state = 'locked', acquisition_no = $2
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [trackId, next.n]
    );
  });
}

// ─── Manifeste et vérification ──────────────────────────────────

/** Liste numérotée à exporter pour le téléchargement. */
async function manifest(partyId) {
  return db.many(
    'SELECT * FROM v_acquisition_manifest WHERE party_id = $1',
    [partyId]
  );
}

/**
 * Enregistre l'appariement fichiers ↔ morceaux validé par l'hôte.
 *
 * Deux formes d'entrée acceptées :
 *   { trackId, fileName, durationMs }        appariement par métadonnées
 *   { acquisitionNo, fileName, durationMs }  appariement par numéro
 *
 * La première est désormais la voie normale : exiger un renommage
 * numérique de chaque fichier était fastidieux. L'appariement se fait
 * côté client sur les tags ID3 et la durée, avec validation manuelle
 * des cas douteux ; le serveur n'enregistre que le résultat.
 *
 * La durée reste vérifiée ici : c'est le dernier garde-fou contre un
 * live ou un remix récupéré à la place de l'original.
 *
 * @param {Array<{trackId?:string, acquisitionNo?:number, fileName:string, durationMs:number}>} files
 */
async function reconcile(partyId, files) {
  return db.tx(async (t) => {
    const expected = await t.many(
      `SELECT id, acquisition_no, title, artist, duration_ms, artwork_url, album
         FROM tracks
        WHERE party_id = $1 AND acquisition_no IS NOT NULL
        ORDER BY acquisition_no`,
      [partyId]
    );

    const byNo = new Map();
    const byId = new Map();
    for (const f of files) {
      if (f.trackId) byId.set(String(f.trackId), f);
      else if (f.acquisitionNo != null) byNo.set(Number(f.acquisitionNo), f);
    }
    const report = { verified: [], mismatched: [], missing: [] };

    for (const track of expected) {
      // L'appariement explicite par trackId prime : c'est celui que
      // l'hôte a validé à l'écran.
      const file = byId.get(String(track.id)) || byNo.get(track.acquisition_no);

      if (!file) {
        await t.query(`UPDATE tracks SET state='missing' WHERE id=$1`, [track.id]);
        report.missing.push({ ...track, reason: 'fichier absent' });
        continue;
      }

      const gap = (track.duration_ms && file.durationMs)
        ? Math.abs(file.durationMs - track.duration_ms)
        : 0;

      if (gap > DURATION_TOLERANCE_MS) {
        await t.query(
          `UPDATE tracks SET state='missing', file_name=$2, file_duration_ms=$3 WHERE id=$1`,
          [track.id, file.fileName, file.durationMs]
        );
        report.mismatched.push({
          ...track,
          fileName: file.fileName,
          fileDurationMs: file.durationMs,
          gapMs: gap,
          reason: `durée incohérente (${Math.round(gap / 1000)} s d'écart)`,
        });
        continue;
      }

      // Complément par les métadonnées du fichier.
      //
      // Un morceau ajouté par lien collé n'a ni durée ni pochette : le
      // participant n'a saisi que le titre et l'artiste. Le fichier
      // téléchargé, lui, les porte. On ne remplace JAMAIS une valeur
      // existante — les métadonnées de l'API restent prioritaires,
      // elles sont plus fiables que des tags de fichier.
      await t.query(
        `UPDATE tracks
            SET state = 'verified',
                file_name = $2,
                file_duration_ms = $3,
                duration_ms = coalesce(duration_ms, $3),
                artwork_url = coalesce(artwork_url, $4),
                album       = coalesce(album, $5)
          WHERE id = $1`,
        [track.id, file.fileName, file.durationMs || null,
         file.artworkUrl || null, file.album || null]
      );
      report.verified.push({
        ...track,
        fileName: file.fileName,
        enriched: !!(file.artworkUrl && !track.artwork_url),
      });
    }

    report.total = expected.length;
    report.ready = report.missing.length === 0 && report.mismatched.length === 0;
    return report;
  });
}

/** Morceaux jouables, poussés dans le salon à son ouverture. */
async function playable(partyId) {
  return db.many(
    `SELECT t.id, t.party_id, t.participant_id, t.position, t.acquisition_no,
            t.source, t.source_id, t.title, t.artist, t.album,
            t.duration_ms, t.artwork_url, t.url, t.state, t.file_name,
            t.file_duration_ms, t.created_at,
            pa.display_name AS proposed_by, pa.id AS proposed_by_id, pa.color
       FROM tracks t
       JOIN participants pa ON pa.id = t.participant_id
      WHERE t.party_id = $1 AND t.state IN ('locked','downloaded','verified')
      ORDER BY t.acquisition_no`,
    [partyId]
  );
}

/**
 * Tous les morceaux d'une soirée, quel que soit leur état.
 *
 * Distinct de playable() : une sauvegarde doit fonctionner à n'importe
 * quel stade, y compris pendant la collecte où aucun morceau n'est
 * encore verrouillé. Les écartés sont exclus — les réimporter
 * ressusciterait des choix déjà tranchés.
 */
async function exportList(partyId) {
  return db.many(
    `SELECT t.id, t.position, t.acquisition_no, t.source, t.source_id,
            t.title, t.artist, t.album, t.duration_ms, t.artwork_url, t.url,
            t.state, t.file_name,
            pa.display_name AS proposed_by
       FROM tracks t
       JOIN participants pa ON pa.id = t.participant_id
      WHERE t.party_id = $1 AND t.state <> 'excluded'
      ORDER BY pa.display_name, t.position`,
    [partyId]
  );
}

/**
 * Morceaux écartés. Nécessaire pour que l'exclusion reste réversible :
 * un morceau écarté disparaît du manifeste, donc de tous les écrans —
 * sans cette liste, il serait perdu de vue.
 */
async function excludedList(partyId) {
  return db.many(
    `SELECT t.id, t.title, t.artist, t.duration_ms,
            pa.display_name AS proposed_by, pa.color
       FROM tracks t
       JOIN participants pa ON pa.id = t.participant_id
      WHERE t.party_id = $1 AND t.state = 'excluded'
      ORDER BY pa.display_name, t.position`,
    [partyId]
  );
}

module.exports = {
  listByParticipant, add, remove, update, excludedList, exportList,
  findDuplicates, exclude, restore,
  manifest, reconcile, playable,
  DURATION_TOLERANCE_MS,
};
