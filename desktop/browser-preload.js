const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  goBack: () => ipcRenderer.invoke('browser-go-back'),
  goForward: () => ipcRenderer.invoke('browser-go-forward'),
  reload: () => ipcRenderer.invoke('browser-reload'),
  stop: () => ipcRenderer.invoke('browser-stop'),
  navigate: (url) => ipcRenderer.invoke('browser-navigate', url),
  newTab: (url) => ipcRenderer.invoke('browser-new-tab', url),
  switchTab: (idx) => ipcRenderer.invoke('browser-switch-tab', idx),
  closeTab: (idx) => ipcRenderer.invoke('browser-close-tab', idx),
  getProfileName: () => ipcRenderer.invoke('browser-get-profile-name'),

  onUrlChanged: (cb) => ipcRenderer.on('url-changed', (e, url) => cb(url)),
  onTitleChanged: (cb) => ipcRenderer.on('title-changed', (e, title) => cb(title)),
  onLoadingChanged: (cb) => ipcRenderer.on('loading-changed', (e, loading) => cb(loading)),
  onCanGoBackChanged: (cb) => ipcRenderer.on('can-go-back', (e, val) => cb(val)),
  onCanGoForwardChanged: (cb) => ipcRenderer.on('can-go-forward', (e, val) => cb(val)),
  onTabsUpdated: (cb) => ipcRenderer.on('tabs-updated', (e, tabs, activeIdx) => cb(tabs, activeIdx)),
  onFaviconChanged: (cb) => ipcRenderer.on('favicon-changed', (e, favicons) => cb(favicons))
});
