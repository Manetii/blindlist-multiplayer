/**
 * ════════════════════════════════════════════════════════════════
 *  AUTH — trois régimes distincts
 * ════════════════════════════════════════════════════════════════
 *
 *  1. PROPRIÉTÉ D'UNE SOIRÉE (hostToken, en-tête X-Host-Token)
 *     « Ce navigateur est celui qui a créé cette soirée. »
 *     Détenue par le PC de gestion. C'est la SEULE protection des
 *     routes de console : il n'y a plus de mot de passe partagé.
 *
 *  2. IDENTITÉ D'UN PARTICIPANT (token, en-tête X-Participant-Token)
 *     « Je suis ce joueur. » Détenue par le téléphone.
 *
 *  3. ADMINISTRATION (ADMIN_PASSWORD, cookie signé)
 *     Seule porte globale restante, parce que /admin voit et supprime
 *     TOUTES les soirées.
 *
 *  Les régimes 1 et 2 sont indépendants et cumulables : l'hôte utilise
 *  les deux, sur deux appareils, sans cas particulier.
 *
 *  Les jetons circulent en EN-TÊTE, jamais en query string : une URL
 *  se retrouve dans les logs serveur, l'historique du navigateur et
 *  l'en-tête Referer envoyé aux tiers.
 * ════════════════════════════════════════════════════════════════
 */

// Charge .env si ce module est atteint avant server/db (ordre variable
// selon le point d'entree). L'appel est idempotent.
require('../db');

const crypto          = require('crypto');
const partyRepo       = require('../repos/party.repo');
const participantRepo = require('../repos/participant.repo');

/**
 * UN SEUL MOT DE PASSE, pour l'administration.
 *
 * Il n'y a plus de mot de passe « hôte » : un secret unique partagé
 * entre tous ceux qui animent une soirée ne protège rien. Chaque
 * soirée est protégée par son propre hostToken, généré à sa création
 * et connu du seul navigateur qui l'a créée. C'est ce jeton qui donne
 * accès à SA console, et à aucune autre.
 *
 * ADMIN_PASSWORD reste nécessaire parce que /admin voit et supprime
 * TOUTES les soirées — un pouvoir qui ne peut pas dépendre d'un jeton
 * détenu par un seul navigateur.
 */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
/**
 * Secret de signature des sessions d'administration.
 *
 * Aléatoire par défaut : chaque redémarrage invalide les sessions en
 * cours, ce qui est sans conséquence pour un usage local. En
 * production, un déploiement déconnecterait l'administrateur à chaque
 * fois — d'où SESSION_SECRET, facultatif mais recommandé.
 */
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

// ─── 1. Porte globale ───────────────────────────────────────────

function makeSessionToken(scope = 'host') {
  const payload = `${scope}:${Date.now() + SESSION_DURATION_MS}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

function verifySessionToken(token, scope = 'host') {
  if (!token) return false;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf8');
    const cut = raw.lastIndexOf(':');
    const payload = raw.slice(0, cut);
    const sig     = raw.slice(cut + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

    const [tokenScope, expires] = payload.split(':');
    // Une session « host » ne doit pas ouvrir l'administration : sans
    // cette vérification, le cookie d'un animateur suffirait à tout
    // supprimer.
    if (scope === 'admin' && tokenScope !== 'admin') return false;
    return Date.now() < parseInt(expires, 10);
  } catch {
    return false;
  }
}

// ─── 2. Propriété d'une soirée ──────────────────────────────────

/**
 * Résout :code + X-Host-Token, et pose req.party.
 *
 * Le 404 est volontairement identique en cas de soirée inexistante et
 * de jeton invalide : sans ça, l'API confirmerait l'existence d'un code
 * à quiconque le devine.
 */
function requirePartyOwner(req, res, next) {
  const token = req.get('X-Host-Token') || (req.body && req.body.hostToken);
  partyRepo.authenticateHost(req.params.code, token)
    .then(party => {
      if (!party) {
        return res.status(404).json({ error: 'Soirée introuvable ou jeton invalide.' });
      }
      req.party = party;
      next();
    })
    .catch(next);
}

// ─── 3. Identité d'un participant ───────────────────────────────

/** Résout X-Participant-Token et pose req.me (+ req.party). */
function requireParticipant(req, res, next) {
  const token = req.get('X-Participant-Token');
  participantRepo.authenticate(token)
    .then(async me => {
      if (!me) {
        return res.status(401).json({ error: 'Lien invalide ou expiré.', badToken: true });
      }
      req.me = me;
      req.party = await partyRepo.findById(me.party_id);
      next();
    })
    .catch(next);
}

/**
 * Restreint une route à certains états de soirée.
 * Exemple : ajouter un morceau n'a de sens qu'en 'collecte'.
 */
function requirePartyState(...states) {
  return (req, res, next) => {
    if (!req.party) return res.status(500).json({ error: 'Soirée non résolue.' });
    if (!states.includes(req.party.state)) {
      return res.status(409).json({
        error: `Action indisponible : la soirée est en état « ${req.party.state} ».`,
        state: req.party.state,
      });
    }
    next();
  };
}

/** Pour les PAGES d'administration. */
function requireAdminPage(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  if (verifySessionToken(req.cookies.host_session, 'admin')) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

/** Pour les API d'administration. */
function requireAdminApi(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  if (verifySessionToken(req.cookies.host_session, 'admin')) return next();
  res.status(401).json({ error: 'Accès administration requis.' });
}

module.exports = {
  ADMIN_PASSWORD, SESSION_DURATION_MS,
  requireAdminPage, requireAdminApi,
  makeSessionToken, verifySessionToken,
  requirePartyOwner, requireParticipant, requirePartyState,
};
