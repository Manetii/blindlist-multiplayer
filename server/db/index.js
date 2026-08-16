/**
 * ════════════════════════════════════════════════════════════════
 *  DB — Pool de connexions et helpers
 * ════════════════════════════════════════════════════════════════
 *
 *  Volontairement sans ORM. Le projet n'a ni build ni framework ;
 *  ajouter une couche d'abstraction ici créerait un décalage de style
 *  avec le reste, pour un gain nul sur une dizaine de tables.
 *
 *  Configuration par DATABASE_URL (format Render / Heroku) :
 *    postgres://user:pass@host:5432/base
 *
 *  Toutes les requêtes passent par query() ou tx(). Aucun appel direct
 *  au pool depuis les dépôts : c'est ce qui permet d'ajouter du log, du
 *  timing ou du retry en un seul endroit.
 * ════════════════════════════════════════════════════════════════
 */

const path = require('path');
const fs   = require('fs');

/**
 * Chargement du fichier .env AVANT toute lecture de process.env.
 *
 * Placé ici plutôt que dans server.js parce que tous les points
 * d'entrée — serveur, migrations, tests — passent par ce module, et
 * qu'aucun n'a alors à se souvenir de charger l'environnement dans le
 * bon ordre.
 *
 * Le diagnostic est volontairement bavard : un .env introuvable ou mal
 * nommé produit exactement les mêmes symptômes qu'une variable oubliée,
 * et les distinguer à l'aveugle coûte cher. Sous Windows, l'Explorateur
 * masque les extensions par défaut : un fichier enregistré depuis le
 * Bloc-notes s'appelle « .env.txt » et ne sera jamais lu.
 */
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

try {
  const found = fs.existsSync(ENV_PATH);
  const result = require('dotenv').config({ path: ENV_PATH, quiet: true });

  if (!found) {
    // Chercher les erreurs de nommage les plus fréquentes plutôt que de
    // se contenter de dire « absent ».
    const dir = path.dirname(ENV_PATH);
    const suspects = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /^\.?env(\.|$)/i.test(f) && f !== '.env.example')
      : [];
    console.warn(`[env] Aucun fichier .env à ${ENV_PATH}`);
    if (suspects.length) {
      console.warn(`[env] Fichiers proches trouvés : ${suspects.join(', ')}`);
      console.warn('[env] Le fichier doit s\'appeler exactement « .env », sans extension.');
      console.warn('[env] Windows : renomme depuis un terminal avec  ren .env.txt .env');
    }
  } else if (result.error) {
    console.warn(`[env] .env illisible : ${result.error.message}`);
  } else {
    const keys = Object.keys(result.parsed || {});
    console.log(`[env] ${ENV_PATH} chargé — ${keys.length} variable(s) : ${keys.join(', ') || '(aucune)'}`);
  }
} catch (err) {
  // dotenv absent : sans importance si les variables viennent du shell
  // ou de l'hébergeur. On ne fait échouer personne pour ça.
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
  console.warn('[env] dotenv non installé — lance « npm install ».');
}

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL;

if (!CONNECTION_STRING) {
  console.error(
    '[db] DATABASE_URL absent.\n' +
    '     Crée un fichier .env à la racine (copie de .env.example), ou\n' +
    '     définis la variable dans ton terminal :\n' +
    '       PowerShell : $env:DATABASE_URL = "postgres://postgres:motdepasse@127.0.0.1:5432/blindtest"\n' +
    '       bash/zsh   : export DATABASE_URL="postgres://postgres@127.0.0.1:5432/blindtest"'
  );
}

const pool = new Pool({
  connectionString: CONNECTION_STRING,

  // Render impose TLS mais présente un certificat que Node ne valide pas
  // dans la chaîne par défaut. On désactive la vérification uniquement
  // hors développement local, où il n'y a pas de TLS du tout.
  ssl: /\blocalhost\b|127\.0\.0\.1/.test(CONNECTION_STRING || '')
    ? false
    : { rejectUnauthorized: false },

  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Une erreur sur un client inactif ne doit pas tuer le process : le
  // pool en ouvrira un autre à la requête suivante.
  console.error('[db] Erreur sur un client inactif :', err.message);
});

const SLOW_QUERY_MS = 200;

// Codes PostgreSQL utilisés comme signal de contrôle normal, pas comme
// panne : les dépôts les rattrapent pour proposer une alternative
// (nom déjà pris, collision de code). Les journaliser en erreur
// noierait les vraies pannes sous du bruit.
const EXPECTED_ERROR_CODES = new Set([
  '23505',  // unique_violation
  '23514',  // check_violation
]);

/**
 * Requête simple. Toujours paramétrée — jamais de concaténation.
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const started = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - started;
    if (ms > SLOW_QUERY_MS) {
      console.warn(`[db] Requête lente (${ms} ms) : ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
    return res;
  } catch (err) {
    if (!EXPECTED_ERROR_CODES.has(err.code)) {
      console.error(`[db] Échec : ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    throw err;
  }
}

/** Première ligne, ou null. */
async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

/** Toutes les lignes. */
async function many(text, params) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Transaction. Le callback reçoit un objet exposant la même API
 * (query/one/many) mais lié au client de la transaction.
 *
 * Indispensable partout où plusieurs écritures doivent réussir ou
 * échouer ensemble : verrouillage d'une soirée (numérotation +
 * changement d'état), écriture d'une manche (votes + score_events).
 */
async function tx(fn) {
  const client = await pool.connect();
  const ctx = {
    query: (t, p) => client.query(t, p),
    one:   async (t, p) => (await client.query(t, p)).rows[0] || null,
    many:  async (t, p) => (await client.query(t, p)).rows,
  };
  try {
    await client.query('BEGIN');
    const result = await fn(ctx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Vérifie que la base répond. Appelé au démarrage et par /health. */
async function ping() {
  const row = await one('SELECT 1 AS ok');
  return row && row.ok === 1;
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, one, many, tx, ping, close };
