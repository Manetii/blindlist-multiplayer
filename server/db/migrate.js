/**
 * ════════════════════════════════════════════════════════════════
 *  MIGRATIONS — runner minimal
 * ════════════════════════════════════════════════════════════════
 *
 *  Applique dans l'ordre les fichiers db/NNN_*.sql pas encore joués,
 *  chacun dans sa propre transaction, et journalise le résultat dans
 *  schema_migrations.
 *
 *  Usage :
 *    node server/db/migrate.js          applique les migrations en attente
 *    node server/db/migrate.js --status affiche l'état sans rien écrire
 *
 *  Pourquoi pas node-pg-migrate ou knex : il faudrait une dépendance,
 *  un format de fichier propre à l'outil et une CLI de plus, pour
 *  remplacer les soixante lignes ci-dessous. Le jour où les migrations
 *  deviennent réversibles ou conditionnelles, l'outil se justifiera.
 *
 *  UNE MIGRATION APPLIQUÉE NE SE MODIFIE JAMAIS. On en ajoute une
 *  nouvelle. Le checksum est là pour le rappeler bruyamment.
 * ════════════════════════════════════════════════════════════════
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const db     = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db');

async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function listFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();   // le préfixe numérique donne l'ordre
}

/**
 * Empreinte du contenu, insensible aux fins de ligne.
 *
 * Sans normalisation, un fichier passé par un éditeur Windows ou un
 * git configuré en autocrlf voit ses \n devenir \r\n : l'empreinte
 * change alors que pas une instruction SQL n'a bougé, et la migration
 * est signalée comme modifiée après coup. Faux positif garanti dès
 * qu'on travaille à deux ou sur deux systèmes.
 */
function checksum(sql) {
  const normalized = sql.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

async function status() {
  await ensureTable();
  const applied = new Map(
    (await db.many('SELECT name, checksum FROM schema_migrations'))
      .map(r => [r.name, r.checksum])
  );

  return listFiles().map(name => {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const sum = checksum(sql);
    const was = applied.get(name);
    return {
      name,
      state: !was ? 'en attente'
           : was === sum ? 'appliquée'
           : 'MODIFIÉE APRÈS COUP',
    };
  });
}

async function migrate() {
  await ensureTable();

  const applied = new Map(
    (await db.many('SELECT name, checksum FROM schema_migrations'))
      .map(r => [r.name, r.checksum])
  );

  const files = listFiles();
  let ran = 0;

  for (const name of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    const sum = checksum(sql);
    const was = applied.get(name);

    if (was === sum) continue;

    if (was && was !== sum) {
      // Le fichier a changé après application. Rejouer serait au mieux
      // un no-op, au pire une corruption silencieuse — on refuse.
      throw new Error(
        `Migration ${name} modifiée après application.\n` +
        `       Empreinte enregistrée : ${was}\n` +
        `       Empreinte du fichier  : ${sum}\n\n` +
        `       Si le SQL est réellement différent, crée une nouvelle\n` +
        `       migration au lieu d'éditer celle-ci.\n\n` +
        `       Si la base est déjà conforme (fins de ligne converties,\n` +
        `       commentaire retouché…), resynchronise les empreintes :\n` +
        `         npm run migrate:repair`
      );
    }

    process.stdout.write(`[migrate] ${name} … `);
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [name, sum]
      );
    });
    console.log('ok');
    ran++;
  }

  console.log(ran ? `[migrate] ${ran} migration(s) appliquée(s).`
                  : '[migrate] Base à jour, rien à faire.');
  return ran;
}

/**
 * Resynchronise les empreintes des migrations déjà appliquées.
 *
 * N'EXÉCUTE AUCUN SQL. Se contente de dire « le fichier a changé mais
 * la base est correcte ». À n'utiliser que lorsque la différence est
 * cosmétique — fins de ligne, commentaire retouché. Si le SQL a
 * réellement changé, la bonne réponse reste une nouvelle migration.
 */
async function repair() {
  await ensureTable();
  const applied = new Map(
    (await db.many('SELECT name, checksum FROM schema_migrations'))
      .map(r => [r.name, r.checksum])
  );

  let fixed = 0;
  for (const name of listFiles()) {
    const was = applied.get(name);
    if (!was) continue;                       // pas encore appliquée
    const sum = checksum(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
    if (was === sum) continue;

    await db.query('UPDATE schema_migrations SET checksum = $2 WHERE name = $1', [name, sum]);
    console.log(`[repair] ${name} : ${was} → ${sum}`);
    fixed++;
  }
  console.log(fixed ? `[repair] ${fixed} empreinte(s) resynchronisée(s).`
                    : '[repair] Rien à réparer.');
  return fixed;
}

if (require.main === module) {
  const arg = process.argv[2];
  const run = arg === '--status'
    ? status().then(rows => rows.forEach(r => console.log(`  ${r.state.padEnd(22)} ${r.name}`)))
    : arg === '--repair'
      ? repair()
      : migrate();

  run
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[migrate] ÉCHEC :', err.message);
      db.close().finally(() => process.exit(1));
    });
}

module.exports = { migrate, status, repair };
