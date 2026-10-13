const { app, BrowserWindow, BrowserView, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const profileWindows = new Map();
const profileTabs = new Map();

const TOOLBAR_HEIGHT = 76;

function getProfilesDir() {
  return path.join(app.getPath('userData'), 'browser_profiles');
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'MultiLogin',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile('index.html');
  win.setMenuBarVisibility(false);
  return win;
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
    return {
      title: wc.isDestroyed() ? '' : wc.getTitle() || 'Nova aba',
      favicon: null
    };
  });
  win.webContents.send('tabs-updated', tabs, state.activeIndex);
}

function setupViewEvents(win, view, profileId, profile) {
  var wc = view.webContents;

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
    if (!win.isDestroyed()) {
      win.webContents.send('loading-changed', false);
    }
  });

  wc.on('page-title-updated', function() {
    sendTabsState(win, profileId);
    var state = profileTabs.get(profileId);
    if (state && state.views[state.activeIndex] === view) {
      win.setTitle('MultiLogin - ' + (profile.name || '') + ' - ' + wc.getTitle());
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
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
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
    if (!existing.isDestroyed()) {
      existing.focus();
      return { success: true, message: 'Janela existente focada' };
    }
    profileWindows.delete(profile.id);
    profileTabs.delete(profile.id);
  }

  try {
    const partition = 'persist:profile-' + profile.id;
    const ses = session.fromPartition(partition);

    const profileDir = path.join(getProfilesDir(), profile.id);
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_host) {
      const proxyUrl = profile.proxy_type + '://' + profile.proxy_host + ':' + (profile.proxy_port || '');
      await ses.setProxy({ proxyRules: proxyUrl });
    }

    if (profile.cookies && profile.cookies.length) {
      for (const cookie of profile.cookies) {
        try {
          const c = Object.assign({}, cookie);
          if (!c.url && c.domain) {
            c.url = 'https://' + c.domain.replace(/^\./, '');
          }
          await ses.cookies.set(c);
        } catch (e) {}
      }
    }

    ses.setUserAgent(profile.user_agent || app.userAgentFallback || '');

    const win = new BrowserWindow({
      width: profile.screen_w || 1920,
      height: profile.screen_h || 1080,
      title: 'MultiLogin - ' + profile.name,
      backgroundColor: '#202124',
      webPreferences: {
        preload: path.join(__dirname, 'browser-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    win.setMenuBarVisibility(false);
    win.loadFile('browser.html');

    profileTabs.set(profile.id, {
      session: ses,
      views: [],
      activeIndex: -1,
      profile: profile
    });

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
      if (state) {
        state.views.forEach(function(v) {
          if (!v.webContents.isDestroyed()) v.webContents.close();
        });
      }
      profileTabs.delete(profile.id);
      profileWindows.delete(profile.id);
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('profile-closed', profile.id);
        }
      });
    });

    return { success: true, message: 'Perfil "' + profile.name + '" aberto' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

function getProfileIdFromWindow(senderWin) {
  for (var [id, win] of profileWindows) {
    if (win === senderWin) return id;
  }
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
  if (state && state.activeIndex >= 0) {
    state.views[state.activeIndex].webContents.reload();
  }
});

ipcMain.handle('browser-stop', (event) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) {
    state.views[state.activeIndex].webContents.stop();
  }
});

ipcMain.handle('browser-navigate', (event, url) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state && state.activeIndex >= 0) {
    state.views[state.activeIndex].webContents.loadURL(url);
  }
});

ipcMain.handle('browser-new-tab', (event, url) => {
  var win = BrowserWindow.fromWebContents(event.sender);
  var pid = getProfileIdFromWindow(win);
  var state = profileTabs.get(pid);
  if (state) {
    createTab(win, pid, state.profile, url || 'https://www.google.com');
  }
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

  if (state.views.length <= 1) {
    win.close();
    return;
  }

  var removed = state.views.splice(idx, 1)[0];
  if (!removed.webContents.isDestroyed()) removed.webContents.close();

  if (state.activeIndex >= state.views.length) {
    state.activeIndex = state.views.length - 1;
  } else if (idx < state.activeIndex) {
    state.activeIndex--;
  } else if (idx === state.activeIndex) {
    state.activeIndex = Math.min(idx, state.views.length - 1);
  }

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

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
