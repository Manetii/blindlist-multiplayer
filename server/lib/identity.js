/**
 * ════════════════════════════════════════════════════════════════
 *  IDENTITY — codes, jetons, normalisation
 * ════════════════════════════════════════════════════════════════
 *
 *  Trois secrets distincts circulent dans l'application. Les confondre
 *  serait la faille la plus facile à introduire :
 *
 *    hostToken      propriété d'une SOIRÉE. Détenu par le navigateur
 *                   (PC) qui l'a créée. Donne accès à la console.
 *
 *    participantToken  identité d'un PARTICIPANT. Détenu par son
 *                   téléphone. Donne accès à son panier et lui permet
 *                   de rejoindre le salon sous son nom.
 *
 *    code           PUBLIC. Ne prouve rien, sert seulement à désigner
 *                   une soirée. Se dicte à voix haute sans risque.
 *
 *  Les deux jetons sont stockés HACHÉS. Une fuite de la base ne doit
 *  donner ni la console ni les paniers.
 * ════════════════════════════════════════════════════════════════
 */

const crypto = require('crypto');

// Sans I, O, 0 ni 1 : le code est dicté à voix haute et recopié depuis
// un écran. Identique à l'alphabet de server/rooms.js.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH   = 4;

const TOKEN_BYTES = 24;   // 192 bits — inforçable en pratique

// ─── Codes de soirée ────────────────────────────────────────────

function generateCode(length = CODE_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Nettoie une saisie utilisateur (espaces, tirets, minuscules). */
function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isValidCode(input) {
  return /^[A-HJ-NP-Z2-9]{4,6}$/.test(normalizeCode(input));
}

// ─── Jetons ─────────────────────────────────────────────────────

/** Jeton en clair, à transmettre UNE FOIS au client. Jamais restocké. */
function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Empreinte à stocker en base (colonne bytea). */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest();
}

/**
 * Comparaison à temps constant. Le hachage étant déterministe, une
 * comparaison naïve fuirait de l'information par le temps d'exécution.
 */
function tokenMatches(token, storedHash) {
  if (!token || !storedHash) return false;
  const a = hashToken(token);
  const b = Buffer.isBuffer(storedHash) ? storedHash : Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Pseudos ────────────────────────────────────────────────────

/**
 * Forme normalisée servant à l'unicité (participants.name_key).
 *
 * Le pseudo est à la fois la clé d'entrée et LA RÉPONSE DU JEU. Deux
 * variantes typographiques du même prénom créeraient deux participants
 * distincts, dont l'un détiendrait des morceaux orphelins — et une
 * grille de vote avec deux entrées visuellement identiques.
 *
 * NFD + suppression des diacritiques : « Chloé » et « Chloe » sont la
 * même personne.
 */
function normalizeName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nettoyage du nom AFFICHÉ (on garde accents et casse). */
function cleanDisplayName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function isValidDisplayName(name) {
  const c = cleanDisplayName(name);
  return c.length >= 1 && c.length <= 24 && normalizeName(c).length > 0;
}

/**
 * Propose une variante libre quand le nom est déjà pris.
 * « Camille » → « Camille B. » puis « Camille 2 », « Camille 3 »…
 *
 * Une suggestion pré-remplie et modifiable vaut mieux qu'un refus sec :
 * le participant est bloqué trois secondes au lieu d'être renvoyé à un
 * champ vide sans savoir quoi mettre.
 */
function suggestAlternatives(name, takenNormalized, limit = 3) {
  const taken = new Set(takenNormalized);
  const base  = cleanDisplayName(name);
  const out   = [];

  for (const letter of 'BCDLMPRST') {
    if (out.length >= limit) break;
    const candidate = `${base} ${letter}.`;
    if (!taken.has(normalizeName(candidate))) out.push(candidate);
  }
  for (let n = 2; out.length < limit && n < 20; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(normalizeName(candidate))) out.push(candidate);
  }
  return out.slice(0, limit);
}

// ─── Couleurs ───────────────────────────────────────────────────

const PLAYER_COLORS = [
  '#00e5ff', '#ff6b6b', '#ffd166', '#06d6a0', '#f72585',
  '#4cc9f0', '#fb923c', '#a3e635', '#c084fc', '#38bdf8',
];

/** Couleur la moins utilisée dans la soirée, pour maximiser le contraste. */
function pickColor(usedColors = []) {
  const counts = new Map(PLAYER_COLORS.map(c => [c, 0]));
  usedColors.forEach(c => counts.has(c) && counts.set(c, counts.get(c) + 1));
  let best = PLAYER_COLORS[0];
  let min  = Infinity;
  for (const [color, n] of counts) {
    if (n < min) { min = n; best = color; }
  }
  return best;
}

module.exports = {
  generateCode, normalizeCode, isValidCode, CODE_ALPHABET, CODE_LENGTH,
  generateToken, hashToken, tokenMatches,
  normalizeName, cleanDisplayName, isValidDisplayName, suggestAlternatives,
  pickColor, PLAYER_COLORS,
};
