const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const extractZip = require('extract-zip');
const updateConfig = require('./update-config.cjs');

function embeddedCourseRoot() {
  const candidates = [path.join(process.resourcesPath, 'course')];
  if (process.platform === 'win32') candidates.push(path.resolve(process.resourcesPath, '..', '..', 'course'));
  if (process.platform === 'darwin') candidates.push(path.resolve(process.resourcesPath, '..', '..', '..', '..', 'course'));
  return candidates.find(root => fs.existsSync(path.join(root, 'index.html'))) || candidates[0];
}
const EMBEDDED_COURSE_DIR = embeddedCourseRoot();
const EMBEDDED_META_FILE = path.join(path.dirname(EMBEDDED_COURSE_DIR), 'course.json');
let embeddedWrapper = false;
try {
  const embeddedMeta = JSON.parse(fs.readFileSync(EMBEDDED_META_FILE, 'utf8'));
  if (embeddedMeta.wrapperId) {
    embeddedWrapper = true;
    app.setPath('userData', path.join(app.getPath('appData'), 'Stacked Learning Courses', embeddedMeta.wrapperId));
  }
} catch {}
// Keep development launches from claiming the installed maker's single-instance
// lock or reusing its imported-course state.
if (!app.isPackaged && !embeddedWrapper) {
  app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()}-dev`));
}
const USER_COURSE_DIR = path.join(app.getPath('userData'), 'course');
const USER_META_FILE = path.join(app.getPath('userData'), 'course.json');
let APP_DIR = USER_COURSE_DIR;
let META_FILE = USER_META_FILE;
let oobeRequested = process.argv.includes('--oobe');
let mainWindow;
let courseWindow;
let server;
let courseMeta = null;
let busy = false;
let programUpdater = null;
let updaterCheckStarted = false;
let runtimeReleasePromise;
const EXPORT_LOG = path.join(app.getPath('userData'), 'logs', 'export.log');

async function logExport(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  await fsp.mkdir(path.dirname(EXPORT_LOG), { recursive:true }).catch(() => {});
  await fsp.appendFile(EXPORT_LOG, line, 'utf8').catch(() => {});
}

function sendExportProgress(message) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('course:export-progress', message);
}

function mimeFor(file) {
  const bare = file.replace(/\.(br|gz)$/i, '');
  const ext = path.extname(bare).toLowerCase();
  return ({ '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.wasm':'application/wasm', '.data':'application/octet-stream', '.json':'application/json', '.css':'text/css; charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav', '.mp4':'video/mp4', '.webm':'video/webm', '.woff2':'font/woff2' })[ext] || 'application/octet-stream';
}

async function startCourseServer() {
  if (server) return server.address().port;
  server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const target = path.resolve(APP_DIR, rel);
      if (target !== APP_DIR && !target.startsWith(APP_DIR + path.sep)) throw new Error('Invalid path');
      const realTarget = await fsp.realpath(target);
      if (realTarget !== APP_DIR && !realTarget.startsWith(APP_DIR + path.sep)) throw new Error('Invalid path');
      const stat = await fsp.stat(realTarget);
      if (!stat.isFile()) throw new Error('Not found');
      res.setHeader('Content-Type', mimeFor(realTarget));
      res.setHeader('Cache-Control', 'no-store');
      if (/\.br$/i.test(realTarget)) res.setHeader('Content-Encoding', 'br');
      if (/\.gz$/i.test(realTarget)) res.setHeader('Content-Encoding', 'gzip');
      fs.createReadStream(realTarget).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); res.end('Course file not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function readCourseMetadata(root) {
  const htmlPath = path.join(root, 'index.html');
  const html = await fsp.readFile(htmlPath, 'utf8');
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, '').trim();
  let configuredName = '';
  const loader = (await fsp.readdir(path.join(root, 'Build')).catch(() => [])).find(x => x.endsWith('.loader.js'));
  if (loader) {
    const js = await fsp.readFile(path.join(root, 'Build', loader), 'utf8');
    configuredName = js.match(/productName\s*:\s*["']([^"']+)/)?.[1] || '';
  }
  const fromTitle = title?.split('|').pop()?.trim();
  const name = configuredName || fromTitle || title || path.basename(root);
  return { name: name.slice(0, 100), sourceTitle: title || '', importedAt: new Date().toISOString() };
}

async function findIndex(root) {
  const direct = path.join(root, 'index.html');
  if (fs.existsSync(direct)) return root;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const candidates = entries.filter(e => e.isDirectory()).map(e => path.join(root, e.name));
  for (const dir of candidates) if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  throw new Error('Could not find index.html. Select the WebGL build root or a ZIP containing it.');
}

async function importCourse(sourcePath) {
  if (busy) throw new Error('An import is already in progress.');
  busy = true;
  const importCache = path.join(app.getPath('userData'), 'imports');
  const extracted = path.join(importCache, `${Date.now()}-${randomUUID()}`);
  let keepExtracted = false;
  const previousRoot = APP_DIR;
  try {
    const isZip = path.extname(sourcePath).toLowerCase() === '.zip';
    let root;
    if (isZip) {
      await fsp.mkdir(extracted, { recursive:true });
      sendExportProgress('Opening WebGL ZIP…');
      let entries = 0;
      await extractZip(sourcePath, { dir:extracted, onEntry(entry) {
        entries++;
        if (entries % 10 === 0) sendExportProgress(`Unpacking WebGL files · ${entries} items · ${path.basename(entry.fileName)}`);
      } });
      root = await findIndex(extracted);
      keepExtracted = true;
    } else {
      root = await findIndex(path.resolve(sourcePath));
    }
    const meta = await readCourseMetadata(root);
    meta.sourcePath = root;
    if (courseWindow && !courseWindow.isDestroyed()) { courseWindow.close(); courseWindow = null; }
    if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
    await fsp.writeFile(USER_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
    APP_DIR = root; META_FILE = USER_META_FILE; courseMeta = meta;
    const cachedPrefix = importCache + path.sep;
    if (previousRoot.startsWith(cachedPrefix) && previousRoot !== root) await fsp.rm(previousRoot, { recursive:true, force:true }).catch(() => {});
    return meta;
  } finally {
    if (!keepExtracted) await fsp.rm(extracted, { recursive:true, force:true }).catch(() => {});
    busy = false;
  }
}

async function chooseCourse() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Unity WebGL build', properties: ['openFile','openDirectory'],
    filters: [{ name:'WebGL ZIP archive', extensions:['zip'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return importCourse(result.filePaths[0]);
}

async function loadMetadata() {
  try {
    courseMeta = JSON.parse(await fsp.readFile(USER_META_FILE, 'utf8'));
    APP_DIR = courseMeta.sourcePath || USER_COURSE_DIR; META_FILE = USER_META_FILE;
    if (!fs.existsSync(path.join(APP_DIR, 'index.html'))) throw new Error('The selected WebGL build folder is no longer available.');
    return courseMeta;
  } catch {}
  try {
    courseMeta = JSON.parse(await fsp.readFile(EMBEDDED_META_FILE, 'utf8'));
    if (!fs.existsSync(path.join(EMBEDDED_COURSE_DIR, 'index.html'))) throw new Error('Embedded course entry is missing.');
    APP_DIR = EMBEDDED_COURSE_DIR; META_FILE = USER_META_FILE;
    return courseMeta;
  } catch { courseMeta = null; return null; }
}

function safeFolderName(name) {
  const safe = String(name || 'SL-Course-Wrapper').normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim();
  return (safe || 'SL-Course-Wrapper').slice(0, 100);
}

async function getRuntimeRelease() {
  if (!runtimeReleasePromise) runtimeReleasePromise = (async () => {
    const tag = `v${app.getVersion()}`;
    const url = `https://api.github.com/repos/${updateConfig.githubOwner}/${updateConfig.githubRepo}/releases/tags/${tag}`;
    const response = await fetch(url, { headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'SL-Course-Wrapper-Maker' }, signal:AbortSignal.timeout(30_000) });
    const release = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Could not find runtime files for ${tag} (${response.status}). Check the internet connection or install the latest maker.`);
    return release;
  })().catch(error => { runtimeReleasePromise = null; throw error; });
  return runtimeReleasePromise;
}

async function ensureRuntime(target) {
  const assetName = target === 'windows'
    ? 'windows.zip'
    : 'macos-universal.zip';
  sendExportProgress(`Checking ${target === 'windows' ? 'Windows' : 'macOS'} runtime…`);
  const release = await getRuntimeRelease();
  const asset = release.assets?.find(item => item.name === assetName);
  if (!asset?.browser_download_url) throw new Error(`The ${target} runtime is missing from release ${release.tag_name || app.getVersion()}.`);
  const cacheDir = path.join(app.getPath('userData'), 'runtime-cache', `v${app.getVersion()}`);
  const cached = path.join(cacheDir, assetName);
  const expected = String(asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
  if (fs.existsSync(cached)) {
    const digest = (await fsp.stat(cached)).size;
    if ((!asset.size || digest === Number(asset.size)) && (!expected || (await hashFile(cached)) === expected)) {
      await logExport(`Runtime cache hit: ${assetName} (${digest} bytes)`);
      return cached;
    }
    await fsp.rm(cached, { force:true });
  }
  await fsp.mkdir(cacheDir, { recursive:true });
  const temp = `${cached}.download-${randomUUID()}`;
  await logExport(`Downloading runtime ${assetName} from ${asset.browser_download_url}`);
  sendExportProgress(`Downloading ${target === 'windows' ? 'Windows' : 'macOS'} runtime…`);
  const controller = new AbortController();
  let networkTimer;
  const resetNetworkTimer = () => {
    clearTimeout(networkTimer);
    networkTimer = setTimeout(() => controller.abort(), 120_000);
  };
  resetNetworkTimer();
  let response;
  try { response = await fetch(asset.browser_download_url, { redirect:'follow', signal:controller.signal }); }
  catch (error) { clearTimeout(networkTimer); throw error; }
  if (!response.ok || !response.body) { clearTimeout(networkTimer); throw new Error(`Runtime download failed (${response.status}).`); }
  const total = Number(response.headers.get('content-length')) || Number(asset.size) || 0;
  const hash = createHash('sha256');
  let received = 0;
  let lastPercent = -1;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    resetNetworkTimer();
    received += chunk.length; hash.update(chunk);
    const percent = total ? Math.floor(received * 100 / total) : 0;
    if (percent !== lastPercent && (percent === 100 || percent % 2 === 0)) {
      lastPercent = percent;
      sendExportProgress(`Downloading ${target === 'windows' ? 'Windows' : 'macOS'} runtime · ${percent}%`);
    }
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temp));
    const actual = hash.digest('hex');
    if (asset.size && received !== Number(asset.size)) throw new Error(`Runtime download size check failed for ${assetName}.`);
    if (expected && actual !== expected) throw new Error(`Runtime checksum failed for ${assetName}.`);
    await fsp.rename(temp, cached);
    await logExport(`Runtime downloaded and verified: ${assetName} (${received} bytes, SHA-256 ${actual})`);
    return cached;
  } catch (error) {
    await fsp.rm(temp, { force:true }).catch(() => {});
    throw error;
  } finally { clearTimeout(networkTimer); }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function extractRuntime(archive, destination, target) {
  const command = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
  await logExport(`Extracting ${target} runtime with ${command}: ${archive}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['-xvf', archive, '-C', destination], { windowsHide:true });
    let output = '';
    let count = 0;
    let timedOut = false;
    let idleTimer;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; child.kill(); }, 5 * 60_000);
    };
    resetIdleTimer();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      resetIdleTimer();
      output += chunk;
      const lines = output.split(/\r?\n/); output = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        count++;
        if (count % 5 === 0) sendExportProgress(`Preparing ${target} runtime · ${count} files · ${path.basename(line.trim())}`);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { resetIdleTimer(); logExport(`tar: ${chunk.trim()}`); });
    child.on('error', error => { clearTimeout(idleTimer); reject(error); });
    child.on('close', code => {
      clearTimeout(idleTimer);
      if (code === 0) {
        sendExportProgress(`Prepared ${target} runtime · ${count} files`);
        logExport(`Extracted ${target} runtime (${count} entries)`);
        resolve();
      } else reject(new Error(timedOut ? 'Runtime extraction stopped making progress for five minutes.' : `System ZIP extractor exited with code ${code}.`));
    });
  });
}

async function copyTree(source, destination) {
  const sourceReal = await fsp.realpath(source);
  const measure = async dir => {
    let total = 0;
    for (const entry of await fsp.readdir(dir, { withFileTypes:true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await measure(p);
      else total += (await fsp.stat(p)).size;
    }
    return total;
  };
  const progress = { bytes:0, total:await measure(sourceReal), lastPercent:-1 };
  const walk = async (from, to) => {
    const entries = await fsp.readdir(from, { withFileTypes:true });
    await fsp.mkdir(to, { recursive:true });
    for (const entry of entries) {
      const fromPath = path.join(from, entry.name);
      const toPath = path.join(to, entry.name);
      if (entry.isDirectory()) { await walk(fromPath, toPath); continue; }
      const stat = await fsp.stat(fromPath);
      if (entry.isSymbolicLink()) {
        const real = await fsp.realpath(fromPath);
        if (real !== sourceReal && !real.startsWith(sourceReal + path.sep)) throw new Error(`Course link points outside the build folder: ${fromPath}`);
        if (stat.isDirectory()) { await walk(real, toPath); continue; }
      }
      await new Promise((resolve, reject) => {
        const stream = new Transform({ transform(chunk, _encoding, callback) {
          progress.bytes += chunk.length;
          const percent = progress.total ? Math.floor(progress.bytes * 100 / progress.total) : 100;
          if (percent !== progress.lastPercent) {
            progress.lastPercent = percent;
            sendExportProgress(`Copying WebGL build · ${percent}% · ${entry.name}`);
          }
          callback(null, chunk);
        } });
        pipeline(fs.createReadStream(fromPath), stream, fs.createWriteStream(toPath)).then(resolve, reject);
      });
      await fsp.utimes(toPath, stat.atime, stat.mtime).catch(() => {});
    }
  };
  await walk(sourceReal, destination);
}

async function exportWrapper(targets) {
  if (!courseMeta) throw new Error('Import a course before exporting a wrapper.');
  if (!app.isPackaged) throw new Error('Export is available in the installed maker app. Package the maker first, then import and export from that app.');
  const selected = [...new Set(Array.isArray(targets) ? targets : [])];
  if (!selected.length || selected.some(item => !['windows', 'macos'].includes(item))) throw new Error('Choose Windows, macOS, or both.');
  for (const target of selected) await ensureRuntime(target);
  const output = await dialog.showOpenDialog(mainWindow, { title:'Choose the parent folder for your wrapper', properties:['openDirectory','createDirectory'] });
  if (output.canceled || !output.filePaths[0]) return null;
  const parent = output.filePaths[0];
  const folderName = safeFolderName(courseMeta.name);
  let destination = path.join(parent, folderName);
  let suffix = 2;
  while (fs.existsSync(destination)) destination = path.join(parent, `${folderName} (${suffix++})`);
  await fsp.mkdir(destination, { recursive:true });
  let stage = 'copying the WebGL build';
  try {
    const wrapperMeta = { ...courseMeta, wrapperId:randomUUID() };
    await logExport(`Export started: ${folderName}; targets=${selected.join(',')}; source=${APP_DIR}; destination=${destination}`);
    sendExportProgress('Copying WebGL build…');
    await copyTree(APP_DIR, path.join(destination, 'course'));
    await fsp.writeFile(path.join(destination, 'course.json'), JSON.stringify(wrapperMeta, null, 2), 'utf8');
    for (const target of selected) {
      stage = `preparing the ${target === 'windows' ? 'Windows' : 'macOS'} runtime`;
      sendExportProgress(`${stage[0].toUpperCase()}${stage.slice(1)}…`);
      const targetDir = path.join(destination, target === 'windows' ? 'Windows' : 'macOS');
      await fsp.mkdir(targetDir, { recursive:true });
      const assetName = target === 'windows' ? 'windows.zip' : 'macos-universal.zip';
      const runtime = path.join(app.getPath('userData'), 'runtime-cache', `v${app.getVersion()}`, assetName);
      if (target === 'macos' && process.platform === 'win32') {
        sendExportProgress('Keeping the macOS app ZIP intact for extraction on a Mac…');
        await fsp.copyFile(runtime, path.join(targetDir, 'SL Course Wrapper.app.zip'));
      } else {
        await extractRuntime(runtime, targetDir, target === 'windows' ? 'Windows' : 'macOS');
      }
      const expectedShell = target === 'windows'
        ? path.join(targetDir, 'SL Course Wrapper.exe')
        : process.platform === 'win32'
          ? path.join(targetDir, 'SL Course Wrapper.app.zip')
          : path.join(targetDir, 'SL Course Wrapper.app', 'Contents', 'Info.plist');
      if (!fs.existsSync(expectedShell)) throw new Error(`The ${target === 'windows' ? 'Windows' : 'macOS'} runtime archive did not contain the expected app files.`);
    }
    stage = 'finishing the wrapper';
    sendExportProgress('Finishing wrapper…');
    const directions = selected.map(target => target === 'windows'
      ? 'Windows: open the Windows folder and run SL Course Wrapper.exe.'
      : process.platform === 'win32'
        ? 'macOS: extract SL Course Wrapper.app.zip into the macOS folder, then open SL Course Wrapper.app.'
        : 'macOS: open the macOS folder and run SL Course Wrapper.app.');
    const readme = [courseMeta.name, '', 'Launch the app in the folder for your operating system:', ...directions, '', 'Course files are shared in the course folder.', 'Pass --oobe to the app to replace the build.'];
    await fsp.writeFile(path.join(destination, 'READ-ME-FIRST.txt'), readme.join('\n'), 'utf8');
    await logExport(`Export completed: ${destination}`);
    return { path:destination, targets:selected, name:courseMeta.name };
  } catch (error) {
    await logExport(`Export failed while ${stage}: ${error?.stack || error}`);
    await fsp.rm(destination, { recursive:true, force:true }).catch(() => {});
    throw new Error(`Export failed while ${stage}: ${error?.message || String(error)}`);
  }
}

async function showCourse() {
  const port = await startCourseServer();
  if (!courseWindow || courseWindow.isDestroyed()) {
    courseWindow = new BrowserWindow({ width: 1280, height: 820, minWidth: 720, minHeight: 520, backgroundColor:'#151721', autoHideMenuBar:true, webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true } });
    courseWindow.on('closed', () => { courseWindow = null; if (!mainWindow || mainWindow.isDestroyed()) app.quit(); });
  }
  await courseWindow.loadURL(`http://127.0.0.1:${port}/`);
  courseWindow.setTitle(courseMeta?.name || 'Stacked Learning');
  courseWindow.show();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({ width: 1100, height: 760, minWidth: 720, minHeight: 600, backgroundColor:'#151721', title:'Stacked Learning | Course Wrapper', autoHideMenuBar:true, webPreferences:{ preload:path.join(__dirname,'preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true } });
  mainWindow.loadFile(path.join(__dirname,'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendUpdater(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

async function githubApi(url) {
  const response = await fetch(url, { headers: { Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `GitHub update request failed (${response.status}).`);
  return body;
}

async function startUpdateCheck() {
  if (embeddedWrapper || !app.isPackaged) return { skipped:true };
  if (updaterCheckStarted) return { checking:true };
  updaterCheckStarted = true;
  try {
    if (process.platform === 'darwin') {
      const release = await githubApi(`https://api.github.com/repos/${updateConfig.githubOwner}/${updateConfig.githubRepo}/releases/latest`);
      const version = String(release.tag_name || '').replace(/^v/, '');
      if (compareVersions(version, app.getVersion()) > 0) sendUpdater('updater:available', { version, releaseUrl:release.html_url, platform:'macos', manual:true });
      else sendUpdater('updater:current', { version:app.getVersion() });
      return { checked:true };
    }
    if (!programUpdater) {
      const { autoUpdater } = require('electron-updater');
      programUpdater = autoUpdater;
      programUpdater.autoDownload = false;
      programUpdater.autoInstallOnAppQuit = false;
      programUpdater.setFeedURL({ provider:'github', owner:updateConfig.githubOwner, repo:updateConfig.githubRepo });
      programUpdater.on('checking-for-update', () => sendUpdater('updater:checking'));
      programUpdater.on('update-available', info => sendUpdater('updater:available', { version:info.version, platform:'windows' }));
      programUpdater.on('update-not-available', info => sendUpdater('updater:current', { version:info.version || app.getVersion() }));
      programUpdater.on('download-progress', progress => sendUpdater('updater:progress', { percent:Math.round(progress.percent) }));
      programUpdater.on('update-downloaded', info => sendUpdater('updater:downloaded', { version:info.version }));
      programUpdater.on('error', error => sendUpdater('updater:error', { message:error.message || 'Update check failed.' }));
    }
    await programUpdater.checkForUpdates();
    return { checked:true };
  } catch (error) {
    sendUpdater('updater:error', { message:error.message || 'Update check failed.' });
    return { checked:false, error:error.message };
  } finally { updaterCheckStarted = false; }
}

const ownsAppLock = app.requestSingleInstanceLock();
if (!ownsAppLock) app.quit();
else app.on('second-instance', (_event, argv) => {
  if (argv.includes('--oobe')) {
    oobeRequested = true;
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (courseWindow && !courseWindow.isDestroyed()) courseWindow.hide();
    mainWindow.show(); mainWindow.focus();
  } else if (courseWindow && !courseWindow.isDestroyed()) {
    courseWindow.show(); courseWindow.focus();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show(); mainWindow.focus();
  }
});
if (ownsAppLock) app.whenReady().then(async () => {
  await loadMetadata();
  if (embeddedWrapper && courseMeta && !oobeRequested) await showCourse();
  else createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { server?.close(); });

ipcMain.handle('course:status', async () => ({ meta:courseMeta, oobe:oobeRequested, busy }));
ipcMain.handle('updater:check', startUpdateCheck);
ipcMain.handle('updater:download', async () => {
  if (process.platform === 'darwin') return { manual:true };
  if (!programUpdater) await startUpdateCheck();
  if (!programUpdater) throw new Error('Update service is not available.');
  return programUpdater.downloadUpdate();
});
ipcMain.handle('updater:install', () => {
  if (!programUpdater || process.platform !== 'win32') throw new Error('Automatic installation is available in the Windows maker build.');
  programUpdater.quitAndInstall(false, true);
});
ipcMain.handle('updater:open-release', async (_event, url) => {
  const prefix = `https://github.com/${updateConfig.githubOwner}/${updateConfig.githubRepo}/releases/`;
  if (typeof url !== 'string' || !url.startsWith(prefix)) throw new Error('Invalid update release URL.');
  return shell.openExternal(url);
});
ipcMain.handle('course:platforms', () => ({ windows:true, macos:true, default:process.platform }));
ipcMain.handle('course:choose', async () => chooseCourse());
ipcMain.handle('course:import-path', async (_event, p) => importCourse(p));
ipcMain.handle('course:set-name', async (_event, name) => {
  if (!courseMeta) throw new Error('Import a WebGL course first.');
  const trimmed = String(name || '').trim().slice(0,100);
  if (!trimmed) throw new Error('Enter a course name.');
  courseMeta.name = trimmed; await fsp.writeFile(META_FILE, JSON.stringify(courseMeta,null,2));
  if (courseWindow && !courseWindow.isDestroyed()) courseWindow.setTitle(trimmed);
  return courseMeta;
});
ipcMain.handle('course:launch', showCourse);
ipcMain.handle('course:export', async (_event, targets) => {
  try { return { ok:true, wrapper:await exportWrapper(targets) }; }
  catch (error) { await logExport(`Export request failed: ${error?.stack || error}`); return { ok:false, error:error?.message || String(error) }; }
});
ipcMain.handle('course:open-folder', async (_event, dir) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Invalid folder path.');
  return shell.openPath(dir);
});
ipcMain.on('course:dropped', (event, file) => {
  if (event.sender !== mainWindow?.webContents || !path.isAbsolute(file)) return;
  importCourse(file).then(meta => mainWindow?.webContents.send('course:imported', meta)).catch(error => mainWindow?.webContents.send('course:import-error', error.message));
});
