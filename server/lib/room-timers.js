/**
 * ════════════════════════════════════════════════════════════════
 *  ROOM TIMERS — temporisations par salon
 * ════════════════════════════════════════════════════════════════
 *
 *  Les automatismes de la phase 2 reposent entièrement sur des délais.
 *  Dispersés dans les handlers, ils produisent la pire catégorie de
 *  bugs : un minuteur oublié qui lance une manche dix minutes après la
 *  fin de la partie, ou deux minuteurs concurrents qui la lancent deux
 *  fois. D'où ce registre unique, où tout minuteur est nommé, et où
 *  poser un minuteur existant annule le précédent.
 *
 *  RÈGLE ABSOLUE : clearAll() à la fermeture d'un salon. Un minuteur
 *  survivant garde une référence sur le salon et empêche sa collecte.
 *
 *  Les valeurs sont justifiées dans TOUR-RESILIENCE.md.
 * ════════════════════════════════════════════════════════════════
 */

const DELAYS = {
  /**
   * Délai de grâce avant de retirer un joueur déconnecté des
   * dénominateurs. Une coupure WiFi de trois secondes ne doit pas faire
   * partir la manche au nez de quelqu'un qui n'a rien perdu.
   * Asymétrique : le retour, lui, est pris en compte immédiatement.
   */
  DISCONNECT_GRACE_MS: 10_000,

  /**
   * Entre le dernier vote et le signal de reveal. Laisse au dernier
   * votant le temps de voir sa validation s'afficher.
   */
  REVEAL_CUE_MS: 800,

  /**
   * Entre le dernier « prêt » et le lancement. Sans ce délai, la
   * musique part au milieu de la phrase de celui qui vient d'appuyer.
   * Un décompte visible accompagne l'attente.
   */
  ADVANCE_COUNTDOWN_MS: 3_000,

  /**
   * Durée maximale d'un entracte. Rend l'interblocage impossible par
   * construction : téléphone en veille, batterie morte, joueur parti
   * sans prévenir — au bout de 5 min on avance. Gelé par la pause.
   */
  INTERMISSION_MAX_MS: 5 * 60_000,
};

/** Map<roomCode, Map<name, {handle, firesAt}>> */
const registry = new Map();

/**
 * Pose un minuteur nommé. Un minuteur du même nom sur le même salon est
 * annulé au passage — c'est ce qui rend les appels répétés inoffensifs
 * (chaque vote reçu peut réarmer le signal de reveal sans le dupliquer).
 */
function set(code, name, ms, fn) {
  clear(code, name);
  if (!registry.has(code)) registry.set(code, new Map());

  const handle = setTimeout(() => {
    const room = registry.get(code);
    if (room) room.delete(name);
    try {
      fn();
    } catch (err) {
      console.error(`[timer ${code}/${name}] échec :`, err.message);
    }
  }, ms);

  registry.get(code).set(name, { handle, firesAt: Date.now() + ms });
  return handle;
}

function clear(code, name) {
  const room = registry.get(code);
  if (!room) return false;
  const entry = room.get(name);
  if (!entry) return false;
  clearTimeout(entry.handle);
  room.delete(name);
  return true;
}

function clearAll(code) {
  const room = registry.get(code);
  if (!room) return 0;
  for (const { handle } of room.values()) clearTimeout(handle);
  const n = room.size;
  registry.delete(code);
  return n;
}

function isPending(code, name) {
  const room = registry.get(code);
  return !!(room && room.has(name));
}

/** Millisecondes restantes, ou null. Sert à afficher un décompte. */
function remaining(code, name) {
  const room = registry.get(code);
  const entry = room && room.get(name);
  if (!entry) return null;
  return Math.max(0, entry.firesAt - Date.now());
}

function activeCount() {
  let n = 0;
  for (const room of registry.values()) n += room.size;
  return n;
}

module.exports = { DELAYS, set, clear, clearAll, isPending, remaining, activeCount };
