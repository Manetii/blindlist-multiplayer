/**
 * ════════════════════════════════════════════════════════════════
 *  PREPARE APP — Outil de préparation de playlist
 * ════════════════════════════════════════════════════════════════
 *
 *  4 étapes :
 *    1. Sélection du dossier PLAYLIST_JEU (File System Access API)
 *    2. Chargement du tableur CSV
 *    3. Matching auto + résolution manuelle des ambiguïtés
 *    4. Génération du playlist.json dans le dossier
 * ════════════════════════════════════════════════════════════════ */

const PLAYLIST_JSON_NAME = 'playlist.json';

const state = {
  step: 1,
  dirHandle: null,        // FileSystemDirectoryHandle
  mp3Files:  [],          // [{ name, file, title, artist }]
  csvRows:   [],          // [{ line, player, title, artist, keyMoment }]
  csvWarnings: [],
  matches:   [],          // [{ mp3Idx, rowIdx, score, method }]
  pendings:  [],          // MP3 non encore matchés
  ignored:   new Set(),   // mp3Idx ignorés volontairement
};

// ─── UI helpers ─────────────────────────────────────────────

function showStep(n) {
  state.step = n;
  document.querySelectorAll('.step-pane').forEach(el => {
    el.style.display = (parseInt(el.dataset.step, 10) === n) ? 'block' : 'none';
  });
  document.querySelectorAll('.step-nav .step').forEach(el => {
    const sn = parseInt(el.dataset.step, 10);
    el.classList.toggle('active', sn === n);
    el.classList.toggle('done',   sn < n);
  });
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── ÉTAPE 1 — Sélection du dossier ─────────────────────────

async function pickFolder() {
  console.log('[prepare] pickFolder() appelé');
  console.log('[prepare] showDirectoryPicker disponible :', typeof window.showDirectoryPicker);

  if (typeof window.showDirectoryPicker !== 'function') {
    console.warn('[prepare] showDirectoryPicker non disponible — fallback');
    document.getElementById('warn-no-fsapi').style.display = 'block';
    // Active le fallback : input file avec webkitdirectory
    showFallbackInput();
    return;
  }
  try {
    console.log('[prepare] Ouverture du picker…');
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    console.log('[prepare] Dossier choisi :', handle.name);
    state.dirHandle = handle;
    await scanFolder();
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[prepare] Picker annulé par l\'utilisateur');
      return;
    }
    console.error('[prepare] Erreur picker :', err);
    alert('Erreur lors de la sélection du dossier :\n' + err.name + ' — ' + err.message
        + '\n\nVérifie que tu utilises Chrome ou Edge sur HTTPS ou localhost.');
  }
}

/** Fallback pour Firefox/Safari : input file avec webkitdirectory.
 *  Lit le dossier mais ne pourra pas écrire playlist.json automatiquement
 *  (l'utilisateur devra le télécharger et le placer manuellement). */
function showFallbackInput() {
  const result = document.getElementById('result-folder');
  result.style.display = 'block';
  result.innerHTML = `
    <strong style="color:var(--accent3)">Mode de compatibilité</strong><br>
    <small>Ton navigateur ne permet pas la sélection directe d'un dossier
    en lecture/écriture. Sélectionne quand même les fichiers du dossier ;
    à la fin, tu téléchargeras <code>playlist.json</code> à placer manuellement
    dans ton dossier <code>PLAYLIST_JEU</code>.</small>
    <br><br>
    <input type="file" id="fallback-input" webkitdirectory directory multiple
           accept="audio/mp3,audio/mpeg" />
  `;
  document.getElementById('fallback-input').addEventListener('change', (e) => {
    handleFallbackFiles(Array.from(e.target.files));
  });
}

/** Charge les MP3 d'un input fallback. */
async function handleFallbackFiles(files) {
  const mp3s = files.filter(f => /\.mp3$/i.test(f.name));
  if (mp3s.length === 0) {
    alert('Aucun MP3 trouvé dans le dossier sélectionné.');
    return;
  }

  // En mode fallback, on n'a pas de dirHandle, on garde le nom du dossier
  // depuis le webkitRelativePath du premier fichier
  const folderName = mp3s[0].webkitRelativePath.split('/')[0] || 'PLAYLIST_JEU';
  state.dirHandle = {
    name: folderName,
    isFallback: true,
  };

  // Tri par nom
  mp3s.sort((a, b) => a.name.localeCompare(b.name));

  const items = [];
  for (const file of mp3s) {
    const id3 = await ID3.readFile(file);
    items.push({
      name: file.name,
      file,
      title: id3.title.trim(),
      artist: id3.artist.trim(),
    });
  }
  state.mp3Files = items;
  renderFolderResult(folderName, items);
}

/** Render commun pour scanFolder et fallback. */
function renderFolderResult(folderName, items) {
  const result = document.getElementById('result-folder');
  const withId3 = items.filter(m => m.title || m.artist).length;
  const noId3 = items.length - withId3;
  result.innerHTML = `
    <strong>${esc(folderName)}</strong> — ${items.length} MP3 détecté${items.length > 1 ? 's' : ''}<br>
    <small>${withId3} avec métadonnées ID3${noId3 ? `, ${noId3} sans` : ''}.</small>
    <ul>
      ${items.slice(0, 5).map(m =>
        `<li>${esc(m.name)} ${m.title ? '— "' + esc(m.title) + '"' : '— <em>pas d\'ID3</em>'}${m.artist ? ' / ' + esc(m.artist) : ''}</li>`
      ).join('')}
      ${items.length > 5 ? `<li><em>... et ${items.length - 5} autres</em></li>` : ''}
    </ul>
    <button class="btn-primary" onclick="goToStep2()">Étape suivante : charger le tableur →</button>
  `;
}

async function scanFolder() {
  const handle = state.dirHandle;
  state.mp3Files = [];

  const result = document.getElementById('result-folder');
  result.style.display = 'block';
  result.innerHTML = `<em>Lecture du dossier <strong>${esc(handle.name)}</strong>…</em>`;

  // Liste les fichiers du dossier (pas les sous-dossiers)
  const mp3Names = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== 'file') continue;
    if (!/\.mp3$/i.test(name)) continue;
    mp3Names.push({ name, entry });
  }

  if (mp3Names.length === 0) {
    result.innerHTML = `
      <strong>${esc(handle.name)}</strong> — aucun MP3 trouvé.<br>
      <small>Vérifie que le dossier contient bien des fichiers .mp3 à sa racine.</small>
    `;
    return;
  }

  // Tri par nom pour avoir un ordre stable
  mp3Names.sort((a, b) => a.name.localeCompare(b.name));

  // Pour chaque MP3, lire l'ID3
  const items = [];
  for (const { name, entry } of mp3Names) {
    const file = await entry.getFile();
    const id3  = await ID3.readFile(file);
    items.push({
      name,
      file,
      title: id3.title.trim(),
      artist: id3.artist.trim(),
    });
  }
  state.mp3Files = items;
  renderFolderResult(handle.name, items);
}

window.goToStep2 = () => showStep(2);

// ─── ÉTAPE 2 — Chargement CSV ──────────────────────────────

function pickCSV() {
  // Reset la valeur pour que le change se déclenche même si on re-sélectionne
  // le même fichier (cas typique : on a corrigé le tableur et on le réimporte)
  const inp = document.getElementById('file-csv');
  inp.value = '';
  inp.click();
}
window.pickCSV = pickCSV;

function loadCSV(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    // Reset l'input pour permettre de re-sélectionner le même fichier
    input.value = '';

    const { rows, errors, warnings } = CSVParser.parse(e.target.result);

    const result = document.getElementById('result-csv');
    result.style.display = 'block';

    if (errors.length) {
      result.innerHTML = `
        <strong style="color:var(--accent2)">Erreur :</strong><br>
        <ul>${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
        <button class="btn-secondary" onclick="pickCSV()" style="margin-top:0.5rem">↻ Re-essayer avec un autre fichier</button>
      `;
      return;
    }

    state.csvRows = rows;
    state.csvWarnings = warnings;

    const players = new Map();
    rows.forEach(r => players.set(r.player, (players.get(r.player) || 0) + 1));

    result.innerHTML = `
      <strong>${rows.length} ligne${rows.length > 1 ? 's' : ''} chargée${rows.length > 1 ? 's' : ''}</strong>
      &nbsp;·&nbsp; ${players.size} joueur${players.size > 1 ? 's' : ''}
      <ul>
        ${[...players.entries()].map(([name, n]) =>
          `<li><strong>${esc(name)}</strong> · ${n} morceau${n > 1 ? 'x' : ''}</li>`
        ).join('')}
      </ul>
      ${warnings.length ? `
        <details style="margin-top:0.5rem">
          <summary style="color:var(--accent3);cursor:pointer">${warnings.length} avertissement${warnings.length > 1 ? 's' : ''}</summary>
          <ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
        </details>
      ` : ''}
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem;flex-wrap:wrap">
        <button class="btn-primary" onclick="goToStep3()">Étape suivante : matching →</button>
        <button class="btn-secondary" onclick="pickCSV()">↻ Recharger un autre CSV</button>
      </div>
    `;
  };
  reader.readAsText(file, 'utf-8');
}

window.goToStep3 = () => {
  runMatching();
  showStep(3);
};

// ─── ÉTAPE 3 — Matching ─────────────────────────────────────

function runMatching() {
  const { matches, pendings } = Matcher.match(state.mp3Files, state.csvRows);
  state.matches  = matches;
  state.pendings = pendings;
  state.ignored  = new Set();
  renderMatching();
}

function renderMatching() {
  const totalMp3 = state.mp3Files.length;
  const matchedCount = state.matches.length;
  const pendingCount = state.pendings.length - state.ignored.size;

  document.getElementById('match-summary').innerHTML = `
    <strong>${matchedCount} / ${totalMp3} appariés automatiquement</strong>
    ${pendingCount > 0 ? `· <strong style="color:var(--accent3)">${pendingCount} à résoudre</strong>` : ''}
    ${state.ignored.size > 0 ? `· ${state.ignored.size} ignoré${state.ignored.size > 1 ? 's' : ''}` : ''}
  `;

  // Liste des pendings non ignorés
  const pendingEl = document.getElementById('match-pending');
  const visiblePendings = state.pendings.filter(p => !state.ignored.has(p.mp3Idx));

  if (visiblePendings.length === 0) {
    pendingEl.innerHTML = '<p style="color:var(--success)">✓ Tous les morceaux sont résolus.</p>';
  } else {
    pendingEl.innerHTML = visiblePendings.map(p => renderPendingItem(p)).join('');
  }

  // Liste des matchs résolus (auto + manuels)
  const doneList = state.matches.map(m => renderDoneRow(m));
  document.getElementById('match-done-count').textContent = state.matches.length;
  document.getElementById('match-done-list').innerHTML =
    doneList.length ? doneList.join('') : '<em style="color:var(--muted)">Aucun match pour l\'instant.</em>';

  // Bouton suivant : actif si tout est résolu (matchés + ignorés == total)
  const allResolved = matchedCount + state.ignored.size === totalMp3;
  document.getElementById('btn-go-step-4').disabled = !allResolved;
}

function renderPendingItem(pending) {
  const mp3 = pending.mp3;
  const id3Display = mp3.title || mp3.artist
    ? `${esc(mp3.title || '?')}${mp3.artist ? ' / ' + esc(mp3.artist) : ''}`
    : 'pas d\'ID3 lisible';

  // Top 4 des candidats, si on en a (pas de spoil joueur).
  // Les candidats sont déjà triés par score décroissant, donc le premier
  // est le meilleur — on le marque visuellement en surbrillance pour
  // guider l'œil et accélérer la résolution.
  const candidates = pending.candidates.slice(0, 4);
  const opts = candidates.map((c, i) => {
    const row = state.csvRows[c.rowIdx];
    const pct = Math.round(c.score * 100);
    const isBest = (i === 0);
    return `
      <button class="match-option${isBest ? ' best-match' : ''}"
              onclick="resolvePending(${pending.mp3Idx}, ${c.rowIdx})">
        <div class="opt-line">${isBest ? '⭐ Meilleur · ' : ''}Ligne ${row.line} · score ${pct}%</div>
        <strong>${esc(row.title)}</strong> ${row.artist ? '— ' + esc(row.artist) : ''}
      </button>
    `;
  }).join('');

  // Lignes du tableur non encore associées (pour pouvoir choisir une ligne hors top)
  const matchedRowIndices = new Set(state.matches.map(m => m.rowIdx));
  const otherRows = state.csvRows
    .map((row, idx) => ({ row, idx }))
    .filter(({ idx }) => !matchedRowIndices.has(idx) && !candidates.some(c => c.rowIdx === idx));

  const otherOpts = otherRows.length > 0 ? `
    <details style="margin-top:0.6rem">
      <summary style="cursor:pointer;color:var(--muted);font-size:0.78rem">
        Autres lignes disponibles (${otherRows.length})
      </summary>
      <div class="match-options" style="margin-top:0.4rem">
        ${otherRows.map(({ row, idx }) => `
          <button class="match-option" onclick="resolvePending(${pending.mp3Idx}, ${idx})">
            <div class="opt-line">Ligne ${row.line}</div>
            <strong>${esc(row.title)}</strong> ${row.artist ? '— ' + esc(row.artist) : ''}
          </button>
        `).join('')}
      </div>
    </details>
  ` : '';

  return `
    <div class="match-item">
      <div class="match-item-head">
        <span class="match-item-icon">🎵</span>
        <span class="match-item-filename">${esc(mp3.name)}</span>
        <span class="match-item-id3">${id3Display}</span>
      </div>
      <div class="match-options">
        ${opts || '<em style="color:var(--muted)">Aucun candidat de score correct.</em>'}
        <button class="match-option ignore" onclick="ignorePending(${pending.mp3Idx})">
          ✕ Ne pas inclure ce fichier dans la playlist
        </button>
      </div>
      ${otherOpts}
    </div>
  `;
}

function renderDoneRow(match) {
  const mp3 = state.mp3Files[match.mp3Idx];
  const row = state.csvRows[match.rowIdx];
  const pct = Math.round(match.score * 100);
  let cls = 'manual';
  let label = 'manuel';
  if (match.method === 'auto') {
    if (match.score >= 0.95) { cls = 'perfect'; label = pct + '%'; }
    else                     { cls = 'approx';  label = pct + '%'; }
  }

  return `
    <div class="done-row">
      <span class="done-mp3">${esc(mp3.name)}</span>
      <span class="done-arrow">→</span>
      <span class="done-track"><strong>${esc(row.title)}</strong>${row.artist ? ' / ' + esc(row.artist) : ''}</span>
      <span class="done-score ${cls}">${label}</span>
      <button class="btn-undo" onclick="undoMatch(${match.mp3Idx})">↶ défaire</button>
    </div>
  `;
}

window.resolvePending = (mp3Idx, rowIdx) => {
  // Retire le pending et l'ignored éventuel
  state.pendings = state.pendings.filter(p => p.mp3Idx !== mp3Idx);
  state.ignored.delete(mp3Idx);
  // Ajoute le match
  state.matches.push({ mp3Idx, rowIdx, score: 1, method: 'manual' });
  renderMatching();
};

window.ignorePending = (mp3Idx) => {
  state.ignored.add(mp3Idx);
  renderMatching();
};

window.undoMatch = (mp3Idx) => {
  // Retire le match
  state.matches = state.matches.filter(m => m.mp3Idx !== mp3Idx);
  // Recrée un pending pour ce mp3 avec ses candidats
  const mp3 = state.mp3Files[mp3Idx];
  const matchedRowIndices = new Set(state.matches.map(m => m.rowIdx));
  const candidates = state.csvRows
    .map((row, idx) => ({ rowIdx: idx, score: Matcher.scoreMatch(mp3, row) }))
    .filter(c => !matchedRowIndices.has(c.rowIdx))
    .sort((a, b) => b.score - a.score);
  state.pendings.push({ mp3Idx, mp3, candidates });
  renderMatching();
};

window.goToStep4 = () => {
  renderFinalSummary();
  showStep(4);
};

// ─── ÉTAPE 4 — Génération du playlist.json ──────────────────

function renderFinalSummary() {
  document.getElementById('final-folder-name').textContent = state.dirHandle.name;

  // Lister les joueurs
  const playerNames = new Set();
  state.matches.forEach(m => playerNames.add(state.csvRows[m.rowIdx].player));

  const trackCount = state.matches.length;
  const ignoredCount = state.ignored.size;

  document.getElementById('final-summary').innerHTML = `
    <strong>${trackCount} morceau${trackCount > 1 ? 'x' : ''}</strong> · ${playerNames.size} joueur${playerNames.size > 1 ? 's' : ''}
    ${ignoredCount > 0 ? `<br><small style="color:var(--muted)">${ignoredCount} fichier${ignoredCount > 1 ? 's' : ''} non inclus dans la playlist</small>` : ''}
  `;
}

async function writePlaylistJSON() {
  if (!state.dirHandle) return;

  // Construit les joueurs
  const playerNames = [];
  state.matches.forEach(m => {
    const name = state.csvRows[m.rowIdx].player;
    if (!playerNames.includes(name)) playerNames.push(name);
  });
  const players = playerNames.map((name, i) => ({
    name,
    color: SharedUtils.PLAYER_COLORS[i % SharedUtils.PLAYER_COLORS.length],
  }));

  // Construit les tracks (dans l'ordre des MP3)
  // Règle de priorité :
  //   - title  : ID3 prioritaire, sinon CSV, sinon filename sans extension
  //   - artist : ID3 prioritaire, sinon CSV
  //   - player et keyMoment : viennent uniquement du CSV
  const tracks = state.matches
    .sort((a, b) => a.mp3Idx - b.mp3Idx)
    .map(m => {
      const mp3 = state.mp3Files[m.mp3Idx];
      const row = state.csvRows[m.rowIdx];

      const fnameNoExt = mp3.name.replace(/\.[^/.]+$/, '');
      const title  = (mp3.title  && mp3.title.trim())  || row.title  || fnameNoExt;
      const artist = (mp3.artist && mp3.artist.trim()) || row.artist || '';

      return {
        filename:  mp3.name,
        title,
        artist,
        player:    row.player,
        keyMoment: row.keyMoment,
      };
    });

  const config = {
    version:   1,
    createdAt: new Date().toISOString(),
    players,
    tracks,
  };

  const json = JSON.stringify(config, null, 2);

  // Mode fallback : pas d'écriture directe, on déclenche un téléchargement
  if (state.dirHandle.isFallback) {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = PLAYLIST_JSON_NAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    document.getElementById('final-success').innerHTML = `
      <h3>📥 playlist.json téléchargé</h3>
      <p>Place ce fichier dans ton dossier <strong>${esc(state.dirHandle.name)}</strong>
         à côté des MP3, puis va dans l'app de jeu.</p>
      <a href="/" class="btn-primary">Aller à l'app de jeu</a>
    `;
    document.getElementById('final-success').style.display = 'block';
    document.getElementById('btn-write-json').disabled = true;
    document.getElementById('btn-write-json').textContent = '✓ Fichier téléchargé';
    return;
  }

  // Mode normal : écriture directe via File System Access
  try {
    const fileHandle = await state.dirHandle.getFileHandle(PLAYLIST_JSON_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();

    document.getElementById('final-success').style.display = 'block';
    document.getElementById('btn-write-json').disabled = true;
    document.getElementById('btn-write-json').textContent = '✓ Fichier écrit';
  } catch (err) {
    console.error(err);
    alert('Erreur lors de l\'écriture du fichier : ' + err.message);
  }
}

// ─── BOOTSTRAP ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  console.log('[prepare] Démarrage de l\'outil');
  console.log('[prepare] window.showDirectoryPicker =',
              typeof window.showDirectoryPicker);
  console.log('[prepare] User Agent =', navigator.userAgent);
  console.log('[prepare] Protocole =', window.location.protocol);

  showStep(1);

  // Bind défensif : si un élément manque, on log et on continue
  const bind = (id, evt, handler) => {
    const el = document.getElementById(id);
    if (!el) { console.error(`[prepare] Élément #${id} introuvable`); return; }
    el.addEventListener(evt, handler);
    console.log(`[prepare] Handler ${evt} bindé sur #${id}`);
  };

  bind('btn-pick-folder', 'click',  pickFolder);
  bind('btn-pick-csv',    'click',  pickCSV);
  bind('file-csv',        'change', (e) => loadCSV(e.target));
  bind('btn-go-step-4',   'click',  () => goToStep4());
  bind('btn-write-json',  'click',  writePlaylistJSON);
  bind('btn-back-1',      'click',  () => showStep(1));
  bind('btn-back-2',      'click',  () => showStep(2));
  bind('btn-back-3',      'click',  () => showStep(3));

  // Détection précoce de l'API File System Access
  if (typeof window.showDirectoryPicker !== 'function') {
    console.warn('[prepare] showDirectoryPicker non disponible, fallback sera utilisé');
    document.getElementById('warn-no-fsapi').style.display = 'block';
  } else {
    console.log('[prepare] showDirectoryPicker disponible — mode complet');
  }
});
