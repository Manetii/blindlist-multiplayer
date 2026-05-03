/**
 * ════════════════════════════════════════════════════════════════
 *  APP — Point d'entrée Host
 * ════════════════════════════════════════════════════════════════
 *
 *  Initialise tous les modules dans l'ordre :
 *    1. Récupère l'élément <audio> et l'attache au state
 *    2. Initialise le volume par défaut (80%)
 *    3. Branche les events <audio>
 *    4. Initialise les modules Players + Keyboard
 *    5. Premier rendu (vide)
 *
 *  À l'étape 4.B on ajoutera ici la connexion WebSocket.
 * ════════════════════════════════════════════════════════════════ */

(function bootstrap() {
  // 1) Élément <audio>
  Host.State.audio = document.getElementById("audio");
  Host.State.audio.volume = 0.8;

  // 2) Branche les événements <audio> (timeupdate, ended, play, pause)
  Host.Controls.bindAudioEvents();

  // 3) Initialise les modules qui ont besoin d'écouter le DOM
  Host.Players.init();
  Host.Keyboard.init();

  // 4) Restaurer la sauvegarde locale (joueurs avec scores)
  const savedPlayers = Host.Storage.loadPlayers();
  if (savedPlayers && savedPlayers.length) {
    Host.State.players = savedPlayers.map(p => ({
      ...p,
      connected: false,   // sera remis à jour par le serveur
    }));
    console.log(`[storage] ${savedPlayers.length} joueur(s) restauré(s)`);
  }

  // Restaurer la liste des morceaux qui étaient configurés (sans les fichiers)
  // → placeholders dans la playlist en attendant qu'on recharge les MP3
  const savedTracks = Host.Storage.loadTrackList();
  if (savedTracks && savedTracks.length) {
    const playedSigs = new Set();
    try {
      const raw = localStorage.getItem('blindtest:playedTracks');
      if (raw) JSON.parse(raw).forEach(s => playedSigs.add(s));
    } catch (e) {}

    Host.State.tracks = savedTracks.map(t => {
      const placeholder = {
        url: null, file: null, isPlaceholder: true,
        title:  t.title || t.filename || 'Morceau',
        artist: t.artist || '',
        player: '', keyMoment: null, art: null, played: false,
        savedFilename: t.filename || '',
      };
      // Restaurer la config (joueur, moment clé) par signatures
      Host.Storage.applyConfigToTrack(placeholder);
      // Marquer comme joué si sa signature est dans la liste sauvée
      const sigs = Host.Storage.trackSignatures(placeholder);
      if (sigs.some(s => playedSigs.has(s))) placeholder.played = true;
      return placeholder;
    });
    console.log(`[storage] ${savedTracks.length} morceau(x) en placeholder, en attente de rechargement`);
  }

  // 5) Premier rendu
  Host.Players.render();
  Host.Playlist.render();
  Host.Controls.updateKeyMomentUI();
  Host.Socket.renderVotesPanel();
  Host.Game.updateGameButtons();
  Host.Match.init();
  Host.Panels.init();

  // 6) Connexion WebSocket au serveur
  Host.Socket.connect();

  console.log('🎵 Host prêt.');
})();
