const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const profileWindows = new Map();

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

ipcMain.handle('launch-profile', async (event, profile) => {
  if (profileWindows.has(profile.id)) {
    const existing = profileWindows.get(profile.id);
    if (!existing.isDestroyed()) {
      existing.focus();
      return { success: true, message: 'Janela existente focada' };
    }
    profileWindows.delete(profile.id);
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
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.setMenuBarVisibility(false);

    if (profile.proxy_type && profile.proxy_type !== 'none' && profile.proxy_user) {
      win.webContents.on('login', (event, details, authInfo, callback) => {
        event.preventDefault();
        callback(profile.proxy_user, profile.proxy_pass || '');
      });
    }

    profileWindows.set(profile.id, win);

    win.on('closed', () => {
      profileWindows.delete(profile.id);
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          w.webContents.send('profile-closed', profile.id);
        }
      });
    });

    const startUrl = profile.start_url || 'https://www.google.com';
    await win.loadURL(startUrl);

    return { success: true, message: 'Perfil "' + profile.name + '" aberto' };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('close-profile', async (event, profileId) => {
  const win = profileWindows.get(profileId);
  if (win && !win.isDestroyed()) {
    win.close();
    profileWindows.delete(profileId);
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
