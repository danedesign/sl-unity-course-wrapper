const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const statusBox = $('status');
const veil = $('veil');
let currentMeta = null;

function showStatus(message, ok = false) { statusBox.textContent = message; statusBox.classList.toggle('ok', ok); statusBox.classList.remove('hidden'); }
function setBusy(active, text = 'Preparing course…') { veil.classList.toggle('hidden', !active); $('busy-text').textContent = text; $('choose').disabled = active; $('launch').disabled = active; $('export').disabled = active; }
function render(meta) {
  currentMeta = meta;
  if (!meta) return;
  dropzone.classList.add('hidden'); $('course-card').classList.remove('hidden'); $('name-row').classList.remove('hidden'); $('export-row').classList.remove('hidden'); $('platform-note').classList.remove('hidden'); $('replace').classList.remove('hidden'); $('launch').classList.remove('hidden');
  $('detected-name').textContent = meta.name; $('course-name').value = meta.name; $('source-title').textContent = meta.sourceTitle ? `Detected from: ${meta.sourceTitle}` : 'Unity WebGL build';
  $('headline').innerHTML = 'Your course is<br><em>ready to launch.</em>';
  $('description').textContent = 'This wrapper will open the imported course automatically on future launches. You can update the course build here whenever a new version is ready.';
  document.querySelectorAll('.steps span').forEach(x => x.classList.add('active'));
}
async function importPath(filePath) {
  if (!filePath) return;
  setBusy(true, 'Importing WebGL build…'); statusBox.classList.add('hidden');
  try { render(await window.slCourse.importPath(filePath)); showStatus('Course imported. Set its display name, then launch it.', true); }
  catch (e) { showStatus(e.message || 'Could not import this build.'); }
  finally { setBusy(false); }
}
async function choose() {
  setBusy(true, 'Choose your course build…');
  try { const meta = await window.slCourse.choose(); if (meta) { render(meta); showStatus('Course imported. Set its display name, then launch it.', true); } }
  catch (e) { showStatus(e.message || 'Could not import this build.'); }
  finally { setBusy(false); }
}
$('choose').addEventListener('click', choose);
$('replace').addEventListener('click', choose);
$('launch').addEventListener('click', async () => {
  try { if (!currentMeta) return; await window.slCourse.setName($('course-name').value); await window.slCourse.launch(); }
  catch (e) { showStatus(e.message || 'Could not launch the course.'); }
});
$('save-name').addEventListener('click', async () => {
  try { render(await window.slCourse.setName($('course-name').value)); showStatus('Course name saved.', true); }
  catch (e) { showStatus(e.message || 'Could not save course name.'); }
});
$('export').addEventListener('click', async () => {
  try {
    const targets = [];
    if ($('target-win').checked) targets.push('windows');
    if ($('target-mac').checked) targets.push('macos');
    if (!targets.length) throw new Error('Choose Windows, macOS, or both.');
    await window.slCourse.setName($('course-name').value);
    setBusy(true, 'Preparing your wrapper folder…');
    const response = await window.slCourse.exportWrapper(targets);
    if (!response?.ok) throw new Error(response?.error || 'The wrapper export did not complete.');
    const result = response.wrapper;
    if (result) {
      showStatus(`Wrapper exported for ${result.targets.map(x => x === 'windows' ? 'Windows' : 'macOS').join(' and ')} to ${result.path}`, true);
      await window.slCourse.openFolder(result.path);
    }
  } catch (e) { showStatus(e.message || 'Could not export this wrapper.'); }
  finally { setBusy(false); }
});
for (const event of ['dragenter','dragover']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.add('over'); });
for (const event of ['dragleave','drop']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.remove('over'); });
dropzone.addEventListener('drop', () => { setBusy(true, 'Importing WebGL build…'); statusBox.classList.add('hidden'); });
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
window.slCourse.status().then(async ({meta,oobe}) => {
  const platforms = await window.slCourse.platforms();
  $('target-win').disabled = !platforms.windows;
  $('target-mac').disabled = !platforms.macos;
  $('target-win').checked = platforms.windows;
  $('target-mac').checked = platforms.macos;
  if (!platforms.windows || !platforms.macos) $('export').disabled = true;
  render(meta);
  if (oobe) showStatus(meta ? 'Select a replacement build to update this wrapper.' : 'Add a WebGL build to get started.', true);
});
window.slCourse.onDroppedImport(meta => { setBusy(false); render(meta); showStatus('Course imported. Set its display name, then launch it.', true); });
window.slCourse.onDroppedError(message => { setBusy(false); showStatus(message || 'Could not import this build.'); });
window.slCourse.onExportProgress(message => { $('busy-text').textContent = message; });
const updaterCard = $('updater-card');
const updaterTitle = $('updater-title');
const updaterDetail = $('updater-detail');
const updateNow = $('update-now');
const updateLater = $('update-later');
let availableUpdate = null;

window.slCourse.onUpdate((channel, info = {}) => {
  if (channel === 'updater:checking') {
    updaterCard.classList.remove('hidden'); updaterTitle.textContent = 'Checking for program updates…'; updaterDetail.textContent = ''; return;
  }
  if (channel === 'updater:current') {
    updaterCard.classList.remove('hidden'); updaterTitle.textContent = `You’re up to date · v${info.version}`; updaterDetail.textContent = '';
    updateNow.classList.add('hidden'); updateLater.classList.add('hidden'); return;
  }
  if (channel === 'updater:available') {
    availableUpdate = info; updaterCard.classList.remove('hidden');
    updaterTitle.textContent = `Version ${info.version} is available`;
    updaterDetail.textContent = info.manual ? 'macOS updates must be installed manually until the app is code signed.' : 'Download now, or check again next launch.';
    updateLater.classList.remove('hidden'); updateLater.textContent = 'Next launch'; updateNow.classList.remove('hidden');
    updateNow.disabled = false; updateNow.textContent = info.manual ? 'Download update' : 'Update now'; return;
  }
  if (channel === 'updater:progress') {
    updaterTitle.textContent = 'Downloading program update…'; updaterDetail.textContent = `${info.percent || 0}%`;
    updateNow.classList.add('hidden'); updateLater.classList.add('hidden'); return;
  }
  if (channel === 'updater:downloaded') {
    updaterTitle.textContent = `Version ${info.version} is ready`; updaterDetail.textContent = 'Restart the maker to finish installing.';
    updateNow.textContent = 'Restart and install'; updateNow.classList.remove('hidden'); updateLater.classList.remove('hidden'); return;
  }
  if (channel === 'updater:error') {
    updaterCard.classList.remove('hidden'); updaterTitle.textContent = 'Update check couldn’t finish';
    updaterDetail.textContent = info.message || 'Try again later.'; updateNow.classList.add('hidden');
    updateLater.classList.remove('hidden'); updateLater.textContent = 'Dismiss';
  }
});

updateNow.addEventListener('click', async () => {
  try {
    if (availableUpdate?.manual) return await window.slCourse.openUpdateRelease(availableUpdate.releaseUrl);
    if (updateNow.textContent.includes('Restart')) return await window.slCourse.installUpdate();
    updateNow.disabled = true; updateNow.textContent = 'Starting…';
    await window.slCourse.downloadUpdate();
  } catch (error) {
    updaterTitle.textContent = 'Update could not start'; updaterDetail.textContent = error.message || 'Try again later.';
    updateNow.disabled = false; updateNow.textContent = 'Update now';
  }
});
updateLater.addEventListener('click', () => updaterCard.classList.add('hidden'));
window.slCourse.checkUpdates();
