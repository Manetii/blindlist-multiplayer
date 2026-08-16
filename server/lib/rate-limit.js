/**
 * ════════════════════════════════════════════════════════════════
 *  RATE LIMIT — fenêtre glissante par adresse IP
 * ════════════════════════════════════════════════════════════════
 *
 *  Devenu nécessaire quand le mot de passe hôte a disparu : créer une
 *  soirée et importer une sauvegarde sont désormais des routes
 *  publiques. Sans plafond, un script remplit la base en quelques
 *  secondes — et l'import accepte jusqu'à 500 morceaux par appel.
 *
 *  Volontairement en mémoire : le serveur est mono-processus, une
 *  dépendance Redis serait disproportionnée. Contrepartie assumée :
 *  les compteurs repartent à zéro au redémarrage, et deux instances ne
 *  partagent rien. C'est un garde-fou contre l'abus opportuniste, pas
 *  une défense contre un attaquant déterminé.
 *
 *  Les codes de salon à 4 caractères se devinent : les routes de
 *  jonction sont limitées elles aussi, sinon on énumère l'alphabet en
 *  une poignée de minutes.
 * ════════════════════════════════════════════════════════════════
 */

/** Map<clé, number[]> — horodatages des requêtes retenues. */
const hits = new Map();

let lastSweep = Date.now();
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Derrière le proxy de Render, req.ip vaut l'IP réelle grâce à
 * « trust proxy ». En local il vaut ::1 — tout le monde partage alors
 * le même compteur, ce qui est sans conséquence pour un usage à une
 * seule personne.
 */
function keyOf(req, name) {
  return `${name}:${req.ip || 'inconnu'}`;
}

/** Purge les entrées mortes. Appelée au fil de l'eau, sans minuteur. */
function sweep(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, list] of hits) {
    if (!list.length || now - list[list.length - 1] > SWEEP_INTERVAL_MS) hits.delete(k);
  }
}

/**
 * @param {string} name    identifiant du compteur
 * @param {number} max     requêtes autorisées dans la fenêtre
 * @param {number} windowMs durée de la fenêtre
 * @param {string} message  texte renvoyé au client
 */
function limit(name, max, windowMs, message) {
  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = keyOf(req, name);
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);

    if (list.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - list[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: message || 'Trop de requêtes. Réessaie dans un instant.',
        retryAfter,
      });
    }

    list.push(now);
    hits.set(key, list);
    next();
  };
}

function stats() {
  return { keys: hits.size };
}

module.exports = { limit, stats };
