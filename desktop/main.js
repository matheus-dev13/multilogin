const { app, BrowserWindow, BrowserView, ipcMain, session, shell, net, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const FIREBASE = require('./firebase-config');

var defaultUA = app.userAgentFallback || '';
defaultUA = defaultUA.replace(/\s*Electron\/[\d.]+\s*/g, ' ').replace(/\s*obylogin-desktop\/[\d.]+\s*/gi, ' ').replace(/\s+/g, ' ').trim();
app.userAgentFallback = defaultUA;

const profileWindows = new Map();
const profileTabs = new Map();
const runningChromeProfiles = new Map();
const TOOLBAR_HEIGHT = 76;

function findChromePath() {
  var paths = [];
  if (process.platform === 'win32') {
    var pf = process.env.PROGRAMFILES || 'C:\\Program Files';
    var pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    var local = process.env.LOCALAPPDATA || '';
    paths = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(pf86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ];
  } else if (process.platform === 'darwin') {
    paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    ];
  } else {
    paths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/brave-browser'
    ];
  }
  for (var i = 0; i < paths.length; i++) {
    try { if (fs.existsSync(paths[i])) return paths[i]; } catch(e) {}
  }
  return null;
}

let mainWindow = null;
let loginWindow = null;
let currentUser = null;

function getProfilesDir() {
  return path.join(app.getPath('userData'), 'browser_profiles');
}

function getDataFilePath() {
  return path.join(app.getPath('userData'), 'profiles_data.json');
}

function loadProfilesData() {
  try {
    var filePath = getDataFilePath();
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch(e) {}
  return { profiles: [], groups: [] };
}

function saveProfilesData(data) {
  try {
    fs.writeFileSync(getDataFilePath(), JSON.stringify(data, null, 2));
  } catch(e) {}
}

function recoverProfilesFromDisk(existing) {
  var profilesDir = getProfilesDir();
  if (!fs.existsSync(profilesDir)) return existing;
  var existingIds = {};
  existing.forEach(function(p) { existingIds[p.id] = true; });
  var dirs = fs.readdirSync(profilesDir);
  var recovered = [];
  dirs.forEach(function(dirName) {
    if (existingIds[dirName]) return;
    var dirPath = path.join(profilesDir, dirName);
    try {
      if (!fs.statSync(dirPath).isDirectory()) return;
      if (dirName.startsWith('_') || dirName.startsWith('.')) return;
      recovered.push({
        id: dirName,
        name: 'Perfil Recuperado ' + (recovered.length + 1),
        status: 'ready',
        group: '',
        notes: '',
        start_url: 'https://www.google.com',
        proxy_type: 'none', proxy_host: '', proxy_port: '', proxy_user: '', proxy_pass: '',
        user_agent: '',
        screen_w: 1920, screen_h: 1080,
        webrtc: 'real', timezone: 'auto', language: '', platform: 'Windows',
        cookies: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    } catch(e) {}
  });
  return existing.concat(recovered);
}

function getSavedAuthPath() {
  return path.join(app.getPath('userData'), 'auth.json');
}

function saveAuth(data) {
  try { fs.writeFileSync(getSavedAuthPath(), JSON.stringify(data)); } catch(e) {}
}

function loadAuth() {
  try {
    var p = getSavedAuthPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e) {}
  return null;
}

function clearAuth() {
  try { fs.unlinkSync(getSavedAuthPath()); } catch(e) {}
}

function firebaseRequest(url, body) {
  return new Promise(function(resolve, reject) {
    var postData = JSON.stringify(body);
    var req = net.request({ method: 'POST', url: url });
    req.setHeader('Content-Type', 'application/json');
    var chunks = [];
    req.on('response', function(res) {
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function firestoreGet(collection, docId, idToken) {
  return new Promise(function(resolve, reject) {
    var url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE.projectId +
      '/databases/(default)/documents/' + collection + '/' + docId;
    var req = net.request({ method: 'GET', url: url });
    req.setHeader('Authorization', 'Bearer ' + idToken);
    var chunks = [];
    req.on('response', function(res) {
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function firestoreSet(collection, docId, fields, idToken) {
  return new Promise(function(resolve, reject) {
    var url = 'https://firestore.googleapis.com/v1/projects/' + FIREBASE.projectId +
      '/databases/(default)/documents/' + collection + '/' + docId;
    var docFields = {};
    Object.keys(fields).forEach(function(k) {
      var v = fields[k];
      if (typeof v === 'string') docFields[k] = { stringValue: v };
      else if (typeof v === 'boolean') docFields[k] = { booleanValue: v };
      else if (typeof v === 'number') docFields[k] = { integerValue: String(v) };
    });
    var body = JSON.stringify({ fields: docFields });
    var req = net.request({ method: 'PATCH', url: url });
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Authorization', 'Bearer ' + idToken);
    var chunks = [];
    req.on('response', function(res) {
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseFirestoreDoc(doc) {
  if (!doc || !doc.fields) return null;
  var result = {};
  Object.keys(doc.fields).forEach(function(k) {
    var f = doc.fields[k];
    if (f.stringValue !== undefined) result[k] = f.stringValue;
    else if (f.booleanValue !== undefined) result[k] = f.booleanValue;
    else if (f.integerValue !== undefined) result[k] = parseInt(f.integerValue);
    else if (f.timestampValue !== undefined) result[k] = f.timestampValue;
  });
  return result;
}

async function firebaseLogin(email, password) {
  var url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FIREBASE.apiKey;
  var res = await firebaseRequest(url, { email: email, password: password, returnSecureToken: true });
  if (res.error) return { error: res.error.message === 'INVALID_LOGIN_CREDENTIALS' ? 'auth/invalid-credential' : 'auth/' + (res.error.message || 'unknown').toLowerCase().replace(/_/g, '-') };
  return { uid: res.localId, email: res.email, idToken: res.idToken, refreshToken: res.refreshToken };
}

async function firebaseRegister(email, password) {
  var url = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FIREBASE.apiKey;
  var res = await firebaseRequest(url, { email: email, password: password, returnSecureToken: true });
  if (res.error) {
    var msg = (res.error.message || '').toUpperCase();
    if (msg.indexOf('EMAIL_EXISTS') >= 0) return { error: 'auth/email-already-in-use' };
    if (msg.indexOf('WEAK_PASSWORD') >= 0) return { error: 'auth/weak-password' };
    return { error: 'auth/' + (res.error.message || 'unknown').toLowerCase().replace(/_/g, '-') };
  }
  return { uid: res.localId, email: res.email, idToken: res.idToken, refreshToken: res.refreshToken };
}

async function refreshToken(token) {
  var url = 'https://securetoken.googleapis.com/v1/token?key=' + FIREBASE.apiKey;
  var res = await firebaseRequest(url, { grant_type: 'refresh_token', refresh_token: token });
  if (res.error) return null;
  return { idToken: res.id_token, refreshToken: res.refresh_token, uid: res.user_id };
}

async function checkSubscription(uid, idToken) {
  try {
    var doc = await firestoreGet('users', uid, idToken);
    var data = parseFirestoreDoc(doc);
    if (!data) return { status: 'pending' };
    if (!data.active) return { status: 'pending' };
    if (data.expires_at) {
      var exp = new Date(data.expires_at);
      if (exp < new Date()) return { status: 'expired', expiresAt: data.expires_at };
    }
    return { status: 'active', name: data.name || '', plan: data.plan || 'mensal', expiresAt: data.expires_at || '' };
  } catch(e) {
    return { status: 'pending' };
  }
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    title: 'ObyLogin - Entrar',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0a0b14',
    webPreferences: {
      preload: path.join(__dirname, 'login-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile('login.html');
  loginWindow.on('closed', function() { loginWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'ObyLogin',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('closed', function() { mainWindow = null; });
  return mainWindow;
}

function showMainWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  else mainWindow.focus();
}

ipcMain.handle('auth-login', async (event, email, password) => {
  try {
    var auth = await firebaseLogin(email, password);
    if (auth.error) return { error: auth.error };
    var sub = await checkSubscription(auth.uid, auth.idToken);
    if (sub.status === 'expired') return { expired: true, expiresAt: sub.expiresAt };
    if (sub.status === 'pending') return { pending: true };
    currentUser = { uid: auth.uid, email: auth.email, name: sub.name, plan: sub.plan, expiresAt: sub.expiresAt };
    saveAuth({ refreshToken: auth.refreshToken, uid: auth.uid, email: auth.email });
    showMainWindow();
    return { success: true };
  } catch(e) {
    return { error: 'auth/network-request-failed' };
  }
});

ipcMain.handle('auth-register', async (event, name, email, password) => {
  try {
    var auth = await firebaseRegister(email, password);
    if (auth.error) return { error: auth.error };
    await firestoreSet('users', auth.uid, {
      name: name,
      email: email,
      active: false,
      plan: 'pendente',
      created_at: new Date().toISOString(),
      expires_at: ''
    }, auth.idToken);
    return { success: true };
  } catch(e) {
    return { error: 'auth/network-request-failed' };
  }
});

ipcMain.handle('auth-logout', async () => {
  currentUser = null;
  clearAuth();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  createLoginWindow();
  return { success: true };
});

ipcMain.handle('get-current-user', () => {
  return currentUser;
});

async function tryAutoLogin() {
  var saved = loadAuth();
  if (!saved || !saved.refreshToken) {
    createLoginWindow();
    return;
  }
  try {
    var tokens = await refreshToken(saved.refreshToken);
    if (!tokens) { clearAuth(); createLoginWindow(); return; }
    var sub = await checkSubscription(tokens.uid, tokens.idToken);
    if (sub.status === 'active') {
      currentUser = { uid: tokens.uid, email: saved.email, name: sub.name, plan: sub.plan, expiresAt: sub.expiresAt };
      saveAuth({ refreshToken: tokens.refreshToken, uid: tokens.uid, email: saved.email });
      showMainWindow();
    } else {
      createLoginWindow();
      if (loginWindow) {
        loginWindow.webContents.on('did-finish-load', function() {
          if (sub.status === 'expired') loginWindow.webContents.send('auto-login-result', { expired: true, expiresAt: sub.expiresAt });
          else loginWindow.webContents.send('auto-login-result', { pending: true });
        });
      }
    }
  } catch(e) {
    createLoginWindow();
  }
}

function sendNavState(win, view) {
  if (!win || win.isDestroyed() || !view || view.webContents.isDestroyed()) return;
  var wc = view.webContents;
  win.webContents.send('url-changed', wc.getURL());
  win.webContents.send('can-go-back', wc.canGoBack());
  win.webContents.send('can-go-forward', wc.canGoForward());
}

function sendTabsState(win, profileId) {
  if (!win || win.isDestroyed()) return;
  var state = profileTabs.get(profileId);
  if (!state) return;
  var tabs = state.views.map(function(v) {
    var wc = v.webContents;
    return { title: wc.isDestroyed() ? '' : wc.getTitle() || 'Nova aba', favicon: null };
  });
  win.webContents.send('tabs-updated', tabs, state.activeIndex);
}

var STEALTH_JS = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  if (navigator.userAgentData) {
    var origUA = navigator.userAgentData;
    var fakeBrands = [
      { brand: 'Chromium', version: '130' },
      { brand: 'Google Chrome', version: '130' },
      { brand: 'Not?A_Brand', version: '99' }
    ];
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({
        brands: fakeBrands,
        mobile: false,
        platform: origUA.platform || 'Windows',
        getHighEntropyValues: function(hints) {
          return Promise.resolve({
            brands: fakeBrands,
            mobile: false,
            platform: origUA.platform || 'Windows',
            platformVersion: '15.0.0',
            architecture: 'x86',
            model: '',
            uaFullVersion: '130.0.6723.118',
            fullVersionList: fakeBrands.map(function(b) { return { brand: b.brand, version: b.version + '.0.6723.118' }; })
          });
        }
      })
    });
  }
  Object.defineProperty(navigator, 'plugins', { get: () => [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
  ]});
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
  if (window.chrome === undefined) {
    window.chrome = { runtime: {}, app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } }, csi: function(){}, loadTimes: function(){} };
  }
  var origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = function(params) {
    if (params.name === 'notifications') return Promise.resolve({ state: Notification.permission });
    return origQuery.call(window.navigator.permissions, params);
  };
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
  Object.defineProperty(navigator, 'connection', { get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }) });
  try { delete window.process; } catch(e) {}
  try { delete window.global; } catch(e) {}
  try { delete window.Buffer; } catch(e) {}
  try { delete window.require; } catch(e) {}
  try { delete window.__electron_preload; } catch(e) {}
`;

function setupViewEvents(win, view, profileId, profile) {
  var wc = view.webContents;
  wc.on('dom-ready', function() {
    wc.executeJavaScript(STEALTH_JS).catch(function(){});
  });
  wc.on('did-start-navigation', function(e, url, isInPlace, isMainFrame) {
    if (isMainFrame) {
      wc.executeJavaScript(STEALTH_JS).catch(function(){});
      if (!win.isDestroyed()) {
        win.webContents.send('loading-changed', true);
        win.webContents.send('url-changed', url);
      }
    }
  });
  wc.on('did-navigate', function() {
    sendNavState(win, view);
    win.webContents.send('loading-changed', false);
    sendTabsState(win, profileId);
  });
  wc.on('did-navigate-in-page', function() {
    sendNavState(win, view);
    sendTabsState(win, profileId);
  });
  wc.on('did-finish-load', function() {
    if (!win.isDestroyed()) {
      win.webContents.send('loading-changed', false);
      sendTabsState(win, profileId);
    }
  });
  wc.on('did-fail-load', function() {
    if (!win.isDestroyed()) win.webContents.send('loading-changed', false);
  });
  wc.on('page-title-updated', function() {
    sendTabsState(win, profileId);
    var state = profileTabs.get(profileId);
    if (state && state.views[state.activeIndex] === view) {
      win.setTitle('ObyLogin - ' + (profile.name || '') + ' - ' + wc.getTitle());
    }
  });
  wc.on('page-favicon-updated', function(e, favicons) {
    if (!win.isDestroyed()) {
      win.webContents.send('favicon-changed', favicons);
      sendTabsState(win, profileId);
    }
  });
  wc.setWindowOpenHandler(function(details) {
    createTab(win, profileId, profile, details.url);
    return { action: 'deny' };
  });
  wc.on('context-menu', function(e, params) {
    var menuItems = [];
    if (params.linkURL) {
      menuItems.push({ label: 'Abrir link em nova aba', click: function() { createTab(win, profileId, profile, params.linkURL); } });
      menuItems.push({ label: 'Copiar link', click: function() { require('electron').clipboard.writeText(params.linkURL); } });
      menuItems.push({ type: 'separator' });
    }
    if (params.selectionText) {
      menuItems.push({ label: 'Copiar', role: 'copy' });
      menuItems.push({ label: 'Pesquisar "' + params.selectionText.slice(0, 30) + '"', click: function() { createTab(win, profileId, profile, 'https://www.google.com/search?q=' + encodeURIComponent(params.selectionText)); } });
      menuItems.push({ type: 'separator' });
    }
    if (params.isEditable) {
      menuItems.push({ label: 'Desfazer', role: 'undo' });
      menuItems.push({ label: 'Refazer', role: 'redo' });
      menuItems.push({ type: 'separator' });
      menuItems.push({ label: 'Recortar', role: 'cut' });
      menuItems.push({ label: 'Copiar', role: 'copy' });
      menuItems.push({ label: 'Colar', role: 'paste' });
      menuItems.push({ label: 'Selecionar tudo', role: 'selectAll' });
      menuItems.push({ type: 'separator' });
    }
    if (params.mediaType === 'image') {
      menuItems.push({ label: 'Copiar imagem', click: function() { wc.copyImageAt(params.x, params.y); } });
      menuItems.push({ label: 'Abrir imagem em nova aba', click: function() { createTab(win, profileId, profile, params.srcURL); } });
      menuItems.push({ type: 'separator' });
    }
    menuItems.push({ label: 'Voltar', enabled: wc.canGoBack(), click: function() { wc.goBack(); } });
    menuItems.push({ label: 'Avancar', enabled: wc.canGoForward(), click: function() { wc.goForward(); } });
    menuItems.push({ label: 'Recarregar', click: function() { wc.reload(); } });
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Inspecionar elemento', click: function() { wc.inspectElement(params.x, params.y); } });
    var menu = Menu.buildFromTemplate(menuItems);
    menu.popup({ window: win });
  });
  if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_user) {
    wc.on('login', function(event, details, authInfo, callback) {
      event.preventDefault();
      callback(profile.proxy_user, profile.proxy_pass || '');
    });
  }
}

function createTab(win, profileId, profile, url) {
  var state = profileTabs.get(profileId);
  if (!state) return null;
  var ses = state.session;
  var view = new BrowserView({
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false }
  });
  state.views.push(view);
  state.activeIndex = state.views.length - 1;
  win.setBrowserView(view);
  var bounds = win.getBounds();
  view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: bounds.width, height: bounds.height - TOOLBAR_HEIGHT });
  view.setAutoResize({ width: true, height: true });
  setupViewEvents(win, view, profileId, profile);
  view.webContents.loadURL(url || 'https://www.google.com');
  sendTabsState(win, profileId);
  sendNavState(win, view);
  return view;
}

ipcMain.handle('launch-profile', async (event, profile) => {
  if (runningChromeProfiles.has(profile.id)) {
    return { success: true, message: 'Perfil já está rodando' };
  }
  try {
    var chromePath = findChromePath();
    if (!chromePath) {
      return { success: false, message: 'Google Chrome não encontrado. Instale o Chrome para usar o ObyLogin.' };
    }
    var profileDir = path.join(getProfilesDir(), profile.id);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    var args = [
      '--user-data-dir=' + profileDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-background-networking',
      '--window-size=' + (profile.screen_w || 1280) + ',' + (profile.screen_h || 800)
    ];
    if (profile.user_agent) {
      args.push('--user-agent=' + profile.user_agent);
    }
    if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host) {
      var proxyServer = profile.proxy_host + ':' + (profile.proxy_port || '');
      if (profile.proxy_type === 'socks5') {
        args.push('--proxy-server=socks5://' + proxyServer);
      } else {
        args.push('--proxy-server=http://' + proxyServer);
      }
      if (profile.proxy_user) {
        var extDir = path.join(profileDir, '_proxy_auth_ext');
        if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
        var manifest = {
          manifest_version: 2,
          name: 'Proxy Auth',
          version: '1.0',
          permissions: ['proxy', 'webRequest', 'webRequestBlocking', '<all_urls>'],
          background: { scripts: ['background.js'], persistent: true }
        };
        var bgScript = 'chrome.webRequest.onAuthRequired.addListener(function(details){' +
          'return{authCredentials:{username:' + JSON.stringify(profile.proxy_user) +
          ',password:' + JSON.stringify(profile.proxy_pass || '') + '}};' +
          '},{urls:["<all_urls>"]},["blocking"]);';
        fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(extDir, 'background.js'), bgScript);
        args.push('--load-extension=' + extDir);
        args.push('--disable-extensions-except=' + extDir);
      }
    }
    if (profile.language) {
      args.push('--lang=' + profile.language);
    }
    args.push(profile.start_url || 'https://www.google.com');
    var proc = spawn(chromePath, args, { detached: true, stdio: 'ignore' });
    proc.unref();
    runningChromeProfiles.set(profile.id, proc);
    proc.on('exit', function() {
      runningChromeProfiles.delete(profile.id);
      BrowserWindow.getAllWindows().forEach(function(w) {
        if (!w.isDestroyed()) w.webContents.send('profile-closed', profile.id);
      });
    });
    return { success: true, message: 'Perfil "' + profile.name + '" aberto no Chrome' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});


ipcMain.handle('close-profile', async (event, profileId) => {
  var proc = runningChromeProfiles.get(profileId);
  if (proc) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-proc.pid, 'SIGTERM');
      }
    } catch(e) {
      try { proc.kill('SIGTERM'); } catch(e2) {}
    }
    runningChromeProfiles.delete(profileId);
    return { success: true };
  }
  return { success: false, message: 'Perfil nao encontrado' };
});

ipcMain.handle('is-profile-running', (event, profileId) => {
  return runningChromeProfiles.has(profileId);
});

ipcMain.handle('get-running-profiles', () => {
  return Array.from(runningChromeProfiles.keys());
});

ipcMain.handle('clear-profile-data', async (event, profileId, what) => {
  if (runningChromeProfiles.has(profileId)) {
    return { success: false, message: 'Feche o perfil antes de limpar os dados.' };
  }
  var profileDir = path.join(getProfilesDir(), profileId);
  if (!fs.existsSync(profileDir)) return { success: true, message: 'Nada para limpar.' };
  var defaultDir = path.join(profileDir, 'Default');
  try {
    if (what === 'all') {
      fs.rmSync(profileDir, { recursive: true, force: true });
      fs.mkdirSync(profileDir, { recursive: true });
      return { success: true, message: 'Todos os dados do perfil foram limpos.' };
    }
    if (!fs.existsSync(defaultDir)) return { success: true, message: 'Nada para limpar.' };
    var targets = [];
    if (what === 'cookies') {
      targets = ['Cookies', 'Cookies-journal'];
    } else if (what === 'cache') {
      targets = ['Cache', 'Code Cache', 'GPUCache', 'Service Worker', 'CacheStorage'];
    } else if (what === 'history') {
      targets = ['History', 'History-journal', 'Visited Links', 'Top Sites', 'Top Sites-journal'];
    } else if (what === 'localstorage') {
      targets = ['Local Storage', 'Session Storage', 'IndexedDB', 'databases'];
    }
    for (var i = 0; i < targets.length; i++) {
      var target = path.join(defaultDir, targets[i]);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    var labels = { cookies: 'Cookies', cache: 'Cache', history: 'Histórico', localstorage: 'Local Storage' };
    return { success: true, message: (labels[what] || what) + ' limpo com sucesso.' };
  } catch(e) {
    return { success: false, message: 'Erro ao limpar: ' + e.message };
  }
});

ipcMain.handle('load-profiles-data', () => {
  var data = loadProfilesData();
  data.profiles = recoverProfilesFromDisk(data.profiles);
  return data;
});

ipcMain.handle('save-profiles-data', (event, data) => {
  saveProfilesData(data);
  return { success: true };
});

ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

app.whenReady().then(function() {
  createMainWindow();

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.checkForUpdates().catch(function() {});

  autoUpdater.on('update-available', function(info) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', 'Baixando atualização v' + info.version + '...');
    }
  });

  autoUpdater.on('update-downloaded', function(info) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Atualização disponível',
      message: 'ObyLogin v' + info.version + ' foi baixado. Deseja reiniciar agora para atualizar?',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0
    }).then(function(result) {
      if (result.response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
