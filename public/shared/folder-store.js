/**
 * ════════════════════════════════════════════════════════════════
 *  FOLDER STORE — se souvenir du dossier de musique
 * ════════════════════════════════════════════════════════════════
 *
 *  Le dossier était demandé DEUX FOIS : une fois pour vérifier les
 *  fichiers dans la console de préparation, une seconde pour lancer la
 *  soirée. Deux fois le même geste, à quelques minutes d'intervalle.
 *
 *  Les objets File ne sont pas persistables, mais les HANDLES de la
 *  File System Access API le sont : IndexedDB sait les sérialiser, et
 *  ils survivent au rechargement comme au changement de page. On
 *  redemande simplement la permission au retour — le navigateur
 *  affiche une confirmation d'un clic au lieu d'un sélecteur complet.
 *
 *  Repli : Brave et Firefox n'ont pas cette API. Le dossier y reste
 *  demandé à chaque page, ce qui est le comportement actuel — on ne
 *  perd rien, on gagne seulement là où c'est possible.
 * ════════════════════════════════════════════════════════════════
 */

window.FolderStore = (() => {
  'use strict';

  const DB_NAME = 'blindtest';
  const STORE   = 'handles';
  const supported = () => typeof window.showDirectoryPicker === 'function'
                       && typeof indexedDB !== 'undefined';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  /** Mémorise le dossier choisi pour une soirée donnée. */
  async function remember(code, dirHandle) {
    if (!supported() || !dirHandle) return false;
    try {
      await tx('readwrite', st => st.put(dirHandle, `folder:${code}`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Récupère le dossier mémorisé, si la permission est encore accordée.
   *
   * @param {boolean} ask  true pour redemander la permission à
   *   l'utilisateur (un clic), false pour ne récupérer que si elle est
   *   déjà acquise — utile pour tenter en silence au chargement.
   * @returns {FileSystemDirectoryHandle|null}
   */
  async function recall(code, { ask = false } = {}) {
    if (!supported()) return null;
    let handle;
    try {
      handle = await tx('readonly', st => st.get(`folder:${code}`));
    } catch {
      return null;
    }
    if (!handle) return null;

    try {
      const opts = { mode: 'read' };
      if ((await handle.queryPermission(opts)) === 'granted') return handle;
      if (!ask) return null;
      if ((await handle.requestPermission(opts)) === 'granted') return handle;
    } catch {
      // Handle devenu invalide : dossier déplacé, disque débranché.
      forget(code);
    }
    return null;
  }

  async function forget(code) {
    if (!supported()) return;
    try { await tx('readwrite', st => st.delete(`folder:${code}`)); } catch { /* ignore */ }
  }

  /** Liste les fichiers d'un handle de dossier. */
  async function listFiles(dirHandle) {
    const files = [];
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') files.push(await entry.getFile());
    }
    return files;
  }

  return { supported, remember, recall, forget, listFiles };
})();
