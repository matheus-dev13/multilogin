const { app, BrowserWindow, BrowserView, ipcMain, session, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const FIREBASE = require('./firebase-config');

const profileWindows = new Map();
const profileTabs = new Map();
const TOOLBAR_HEIGHT = 76;

let mainWindow = null;
let loginWindow = null;
let currentUser = null;

function getProfilesDir() {
  return path.join(app.getPath('userData'), 'browser_profiles');
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
    Object.defineProperty(navigator.userAgentData, 'brands', {
      get: () => [
        { brand: 'Google Chrome', version: '120' },
        { brand: 'Chromium', version: '120' },
        { brand: 'Not_A Brand', version: '8' }
      ]
    });
  }
  delete window.process;
  delete window.global;
  delete window.Buffer;
  delete window.require;
`;

function setupViewEvents(win, view, profileId, profile) {
  var wc = view.webContents;
  wc.on('dom-ready', function() {
    wc.executeJavaScript(STEALTH_JS).catch(function(){});
  });
  wc.on('did-start-navigation', function(e, url, isInPlace, isMainFrame) {
    if (isMainFrame && !win.isDestroyed()) {
      win.webContents.send('loading-changed', true);
      win.webContents.send('url-changed', url);
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
  wc.on('will-navigate', function(e, url) {
    if (url.indexOf('accounts.google.com') >= 0) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  wc.setWindowOpenHandler(function(details) {
    var u = details.url || '';
    if (u.indexOf('accounts.google.com') >= 0) {
      shell.openExternal(u);
      return { action: 'deny' };
    }
    createTab(win, profileId, profile, u);
    return { action: 'deny' };
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
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
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
  if (profileWindows.has(profile.id)) {
    const existing = profileWindows.get(profile.id);
    if (!existing.isDestroyed()) { existing.focus(); return { success: true, message: 'Janela existente focada' }; }
    profileWindows.delete(profile.id);
    profileTabs.delete(profile.id);
  }
  try {
    const partition = 'persist:profile-' + profile.id;
    const ses = session.fromPartition(partition);
    const profileDir = path.join(getProfilesDir(), profile.id);
    if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
    if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host) {
      const proxyUrl = profile.proxy_type + '://' + profile.proxy_host + ':' + (profile.proxy_port || '');
      await ses.setProxy({ proxyRules: proxyUrl });
    }
    if (profile.cookies && profile.cookies.length) {
      for (const cookie of profile.cookies) {
        try {
          const c = Object.assign({}, cookie);
          if (!c.url && c.domain) c.url = 'https://' + c.domain.replace(/^\./, '');
          await ses.cookies.set(c);
        } catch (e) {}
      }
    }
    var ua = profile.user_agent || app.userAgentFallback || '';
    ua = ua.replace(/\s*Electron\/[\d.]+\s*/g, ' ').replace(/\s*obylogin-desktop\/[\d.]+\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    ses.setUserAgent(ua);
    ses.webRequest.onBeforeSendHeaders(function(details, callback) {
      var headers = Object.assign({}, details.requestHeaders);
      if (headers['User-Agent']) {
        headers['User-Agent'] = headers['User-Agent']
          .replace(/\s*Electron\/[\d.]+\s*/g, ' ')
          .replace(/\s*obylogin-desktop\/[\d.]+\s*/gi, ' ')
          .replace(/\s+/g, ' ').trim();
      }
      callback({ requestHeaders: headers });
    });
    const win = new BrowserWindow({
      width: profile.screen_w || 1920,
      height: profile.screen_h || 1080,
      title: 'ObyLogin - ' + profile.name,
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: '#202124',
      webPreferences: { preload: path.join(__dirname, 'browser-preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    win.setMenuBarVisibility(false);
    win.loadFile('browser.html');
    profileTabs.set(profile.id, { session: ses, views: [], activeIndex: -1, profile: profile });
    profileWindows.set(profile.id, win);
    win.webContents.on('did-finish-load', function() {
      createTab(win, profile.id, profile, profile.start_url || 'https://www.google.com');
    });
    win.on('resize', function() {
      var state = profileTabs.get(profile.id);
      if (!state || state.activeIndex < 0) return;
      var view = state.views[state.activeIndex];
      if (view && !view.webContents.isDestroyed()) {
        var bounds = win.getBounds();
        view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: bounds.width, height: bounds.height - TOOLBAR_HEIGHT });
      }
    });
    win.on('closed', () => {
      var state = profileTabs.get(profile.id);
      if (state) state.views.forEach(function(v) { if (!v.webContents.isDestroyed()) v.webContents.close(); });
      profileTabs.delete(profile.id);
      profileWindows.delete(profile.id);
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('profile-closed', profile.id);
      });
    });
    return { success: true, message: 'Perfil "' + profile.name + '" aberto' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

function getProfileIdFromWindow(senderWin) {
  for (var [id, win] of profileWindows) { if (win === senderWin) return id; }
  return null;
}

ipcMain.handle('browser-go-back', (event) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) {
    var view = state.views[state.activeIndex];
    if (view && view.webContents.canGoBack()) view.webContents.goBack();
  }
});

ipcMain.handle('browser-go-forward', (event) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) {
    var view = state.views[state.activeIndex];
    if (view && view.webContents.canGoForward()) view.webContents.goForward();
  }
});

ipcMain.handle('browser-reload', (event) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) state.views[state.activeIndex].webContents.reload();
});

ipcMain.handle('browser-stop', (event) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) state.views[state.activeIndex].webContents.stop();
});

ipcMain.handle('browser-navigate', (event, url) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) state.views[state.activeIndex].webContents.loadURL(url);
});

ipcMain.handle('browser-new-tab', (event, url) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state) createTab(win, pid, state.profile, url || 'https://www.google.com');
});

ipcMain.handle('browser-switch-tab', (event, idx) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (!state || idx < 0 || idx >= state.views.length) return;
  state.activeIndex = idx;
  var view = state.views[idx];
  win.setBrowserView(view);
  var bounds = win.getBounds();
  view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: bounds.width, height: bounds.height - TOOLBAR_HEIGHT });
  view.setAutoResize({ width: true, height: true });
  sendNavState(win, view);
  sendTabsState(win, pid);
});

ipcMain.handle('browser-close-tab', (event, idx) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (!state) return;
  if (idx === -1) idx = state.activeIndex;
  if (idx < 0 || idx >= state.views.length) return;
  if (state.views.length <= 1) { win.close(); return; }
  var removed = state.views.splice(idx, 1)[0];
  if (!removed.webContents.isDestroyed()) removed.webContents.close();
  if (state.activeIndex >= state.views.length) state.activeIndex = state.views.length - 1;
  else if (idx < state.activeIndex) state.activeIndex--;
  else if (idx === state.activeIndex) state.activeIndex = Math.min(idx, state.views.length - 1);
  var view = state.views[state.activeIndex];
  win.setBrowserView(view);
  var bounds = win.getBounds();
  view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: bounds.width, height: bounds.height - TOOLBAR_HEIGHT });
  view.setAutoResize({ width: true, height: true });
  sendNavState(win, view);
  sendTabsState(win, pid);
});

ipcMain.handle('browser-get-profile-name', (event) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  return state ? state.profile.name : '';
});

ipcMain.handle('close-profile', async (event, profileId) => {
  const win = profileWindows.get(profileId);
  if (win && !win.isDestroyed()) {
    win.close();
    profileWindows.delete(profileId);
    profileTabs.delete(profileId);
    return { success: true };
  }
  return { success: false, message: 'Janela nao encontrada' };
});

ipcMain.handle('is-profile-running', (event, profileId) => {
  const win = profileWindows.get(profileId);
  return win && !win.isDestroyed();
});

ipcMain.handle('get-running-profiles', () => {
  const running = [];
  for (const [id, win] of profileWindows) {
    if (!win.isDestroyed()) running.push(id);
    else profileWindows.delete(id);
  }
  return running;
});

ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url);
});

app.whenReady().then(tryAutoLogin);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    if (currentUser) createMainWindow();
    else createLoginWindow();
  }
});
