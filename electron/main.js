/**
 * main.js — desktop shell. Starts the API server in-process, opens the window.
 * Phone and desktop hit the same API, so edits sync live between them.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 4173;
let win = null;

/** Source CSVs ship inside the app; on first run copy them to userData so the
 *  user's own exports land in an editable place outside the install directory. */
function seedDataDir() {
  const dest = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dest, { recursive: true });
  // dev: ./data next to the app. packaged: unpacked into resources/data.
  const candidates = [
    path.join(__dirname, '..', 'data'),
    path.join(process.resourcesPath || '', 'data')
  ];
  let copied = 0;
  for (const src of candidates) {
    try {
      if (!fs.existsSync(src)) continue;
      for (const f of fs.readdirSync(src)) {
        if (!/\.(csv|json|txt)$/i.test(f)) continue;
        const to = path.join(dest, f);
        if (!fs.existsSync(to)) { fs.copyFileSync(path.join(src, f), to); copied++; }
      }
      if (copied) break;
    } catch (e) { /* try the next candidate */ }
  }
  return { dest, copied };
}

/**
 * The API server runs in-process on Electron's Node runtime.
 * Native modules (better-sqlite3) are rebuilt for the Electron ABI at package
 * time, so this works identically in development and in the packaged app.
 * It also means the phone can reach the API for as long as the app is open.
 */
function startServer() {
  return new Promise((resolve) => {
    let ready = false;
    const done = () => { if (!ready) { ready = true; resolve(); } };
    process.env.PORT = String(PORT);
    // data/ and the database live beside the app, not inside the asar archive
    const { dest } = seedDataDir();
    process.env.NSPECTOR_DATA = dest;
    process.env.NSPECTOR_DB = path.join(app.getPath('userData'), 'nspector.db');
    try {
      require(path.join(__dirname, '..', 'server', 'server.js'));
      setTimeout(done, 2000);
    } catch (e) {
      process.stderr.write('[srv!] ' + (e && e.stack || e) + '\n');
      dialog.showErrorBox('NSpector could not start',
        'The data service failed to start:\n\n' + (e && e.message || e));
      setTimeout(done, 1000);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 560,
    backgroundColor: '#0b0f14',
    title: 'NSpector',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  win.loadURL(`http://localhost:${PORT}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

function menu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Sync now', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.executeJavaScript(
          "fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(()=>location.reload())") },
      { label: 'Open data folder', click: () => shell.openPath(path.join(__dirname, '..', 'data')) },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }
    ]},
    { label: 'Help', submenu: [
      { label: 'Server address', click: () => dialog.showMessageBox(win, {
        type:'info', title:'NSpector', message:'Phone app connects to this address:',
        detail: `http://<this PC's LAN IP>:${PORT}` }) },
      { label: 'About', click: () => dialog.showMessageBox(win, {
        type:'info', title:'NSpector', message:'NSpector 1.0.0',
        detail:'Device inventory inspector.\nDuplicate IMEI, returns, and ownership tracking.' }) }
    ]}
  ]));
}

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  menu();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });