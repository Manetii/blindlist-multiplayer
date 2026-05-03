/**
 * ════════════════════════════════════════════════════════════════
 *  EDIT MODAL — Configuration d'un morceau
 * ════════════════════════════════════════════════════════════════
 *
 *  open(idx)  : ouvre la modale pré-remplie pour le morceau idx
 *  close()    : ferme la modale
 *  save()     : applique les modifs et ferme
 *
 *  Champs : joueur associé (select), moment clé en secondes (input).
 * ════════════════════════════════════════════════════════════════ */

Host.EditModal = (() => {

  function open(idx) {
    const S = Host.State;
    S.editIdx = idx;
    const t   = S.tracks[idx];
    const sel = document.getElementById("edit-player");
    sel.innerHTML =
      '<option value="">— Aucun joueur —</option>' +
      S.players
        .map(
          (p) =>
            `<option value="${SharedUtils.esc(p.name)}" ${t.player === p.name ? "selected" : ""}>${SharedUtils.esc(p.name)}</option>`,
        )
        .join("");
    document.getElementById("edit-km").value =
      t.keyMoment !== null ? t.keyMoment : "";
    document.getElementById("edit-modal").classList.add("open");
  }

  function close() {
    document.getElementById("edit-modal").classList.remove("open");
    Host.State.editIdx = null;
  }

  function save() {
    const S = Host.State;
    if (S.editIdx === null) return;
    const player = document.getElementById("edit-player").value;
    const km     = document.getElementById("edit-km").value;
    S.tracks[S.editIdx].player    = player;
    S.tracks[S.editIdx].keyMoment = km !== "" ? parseInt(km) : null;
    if (S.editIdx === S.currentIdx) Host.Controls.updateKeyMomentUI();

    // Persister cette config (par signatures ID3 + nom de fichier)
    if (Host.Storage) Host.Storage.saveTrackConfig(S.tracks[S.editIdx]);

    close();
    Host.Playlist.render();
  }

  return { open, close, save };
})();
