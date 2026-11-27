const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const extractZip = require('extract-zip');

function embeddedCourseRoot() {
  const candidates = [path.join(process.resourcesPath, 'course')];
  if (process.platform === 'win32') candidates.push(path.resolve(process.resourcesPath, '..', '..', 'course'));
  if (process.platform === 'darwin') candidates.push(path.resolve(process.resourcesPath, '..', '..', '..', '..', 'course'));
  return candidates.find(root => fs.existsSync(path.join(root, 'index.html'))) || candidates[0];
}
const EMBEDDED_COURSE_DIR = embeddedCourseRoot();
const EMBEDDED_META_FILE = path.join(path.dirname(EMBEDDED_COURSE_DIR), 'course.json');
try {
  const embeddedMeta = JSON.parse(fs.readFileSync(EMBEDDED_META_FILE, 'utf8'));
  if (embeddedMeta.wrapperId) app.setPath('userData', path.join(app.getPath('appData'), 'Stacked Learning Courses', embeddedMeta.wrapperId));
} catch {}
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
  const tmp = path.join(app.getPath('userData'), `course-import-${Date.now()}`);
  const backup = path.join(app.getPath('userData'), `course-backup-${Date.now()}`);
  const staged = path.join(app.getPath('userData'), `course-ready-${Date.now()}`);
  try {
    await fsp.mkdir(tmp, { recursive: true });
    const isZip = path.extname(sourcePath).toLowerCase() === '.zip';
    if (isZip) await extractZip(sourcePath, { dir: tmp });
    else await fsp.cp(sourcePath, tmp, { recursive: true, dereference: false, filter: (src) => !src.split(path.sep).some(part => part === '..') });
    const root = await findIndex(tmp);
    const meta = await readCourseMetadata(root);
    await fsp.cp(root, staged, { recursive: true, dereference: false });
    if (courseWindow && !courseWindow.isDestroyed()) { courseWindow.close(); courseWindow = null; }
    if (server) { await new Promise(resolve => server.close(resolve)); server = null; }
    let hadCourse = false;
    try { await fsp.rename(USER_COURSE_DIR, backup); hadCourse = true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
    try {
      await fsp.rename(staged, USER_COURSE_DIR);
      await fsp.writeFile(USER_META_FILE, JSON.stringify(meta, null, 2), 'utf8');
    } catch (err) {
      await fsp.rm(USER_COURSE_DIR, { recursive: true, force: true });
      if (hadCourse) await fsp.rename(backup, USER_COURSE_DIR);
      throw err;
    }
    await fsp.rm(backup, { recursive: true, force: true });
    APP_DIR = USER_COURSE_DIR; META_FILE = USER_META_FILE; courseMeta = meta;
    return meta;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
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
    APP_DIR = USER_COURSE_DIR; META_FILE = USER_META_FILE;
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

async function exportWrapper(targets) {
  if (!courseMeta) throw new Error('Import a course before exporting a wrapper.');
  if (!app.isPackaged) throw new Error('Export is available in the installed maker app. Package the maker first, then import and export from that app.');
  const selected = [...new Set(Array.isArray(targets) ? targets : [])];
  if (!selected.length || selected.some(item => !['windows', 'macos'].includes(item))) throw new Error('Choose Windows, macOS, or both.');
  const templates = { windows:path.join(process.resourcesPath,'templates','windows.zip'), macos:path.join(process.resourcesPath,'templates','macos-universal.zip') };
  for (const target of selected) if (!fs.existsSync(templates[target])) throw new Error(`The ${target === 'windows' ? 'Windows' : 'macOS'} runtime template is missing. Reinstall the latest maker release.`);
  const output = await dialog.showOpenDialog(mainWindow, { title:'Choose the parent folder for your wrapper', properties:['openDirectory','createDirectory'] });
  if (output.canceled || !output.filePaths[0]) return null;
  const parent = output.filePaths[0];
  const folderName = safeFolderName(courseMeta.name);
  let destination = path.join(parent, folderName);
  let suffix = 2;
  while (fs.existsSync(destination)) destination = path.join(parent, `${folderName} (${suffix++})`);
  await fsp.mkdir(destination, { recursive:true });
  try {
    const wrapperMeta = { ...courseMeta, wrapperId:randomUUID() };
    await fsp.cp(APP_DIR, path.join(destination, 'course'), { recursive:true, dereference:false });
    await fsp.writeFile(path.join(destination, 'course.json'), JSON.stringify(wrapperMeta, null, 2), 'utf8');
    for (const target of selected) {
      const targetDir = path.join(destination, target === 'windows' ? 'Windows' : 'macOS');
      await fsp.mkdir(targetDir, { recursive:true });
      await extractZip(templates[target], { dir:targetDir });
    }
    const directions = selected.map(target => target === 'windows'
      ? 'Windows: open the Windows folder and run SL Course Wrapper.exe.'
      : 'macOS: open the macOS folder and run SL Course Wrapper.app.');
    const readme = [courseMeta.name, '', 'Launch the app in the folder for your operating system:', ...directions, '', 'Course files are shared in the course folder.', 'Pass --oobe to the app to replace the build.'];
    await fsp.writeFile(path.join(destination, 'READ-ME-FIRST.txt'), readme.join('\n'), 'utf8');
    return { path:destination, targets:selected, name:courseMeta.name };
  } catch (error) {
    await fsp.rm(destination, { recursive:true, force:true }).catch(() => {});
    throw error;
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
  }
});
if (ownsAppLock) app.whenReady().then(async () => {
  await loadMetadata();
  if (courseMeta && !oobeRequested) await showCourse();
  else createMainWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { server?.close(); });

ipcMain.handle('course:status', async () => ({ meta:courseMeta, oobe:oobeRequested, busy }));
ipcMain.handle('course:platforms', () => ({ windows:fs.existsSync(path.join(process.resourcesPath,'templates','windows.zip')), macos:fs.existsSync(path.join(process.resourcesPath,'templates','macos-universal.zip')) }));
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
ipcMain.handle('course:export', (_event, targets) => exportWrapper(targets));
ipcMain.handle('course:open-folder', async (_event, dir) => {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Invalid folder path.');
  return shell.openPath(dir);
});
ipcMain.on('course:dropped', (event, file) => {
  if (event.sender !== mainWindow?.webContents || !path.isAbsolute(file)) return;
  importCourse(file).then(meta => mainWindow?.webContents.send('course:imported', meta)).catch(error => mainWindow?.webContents.send('course:import-error', error.message));
});
