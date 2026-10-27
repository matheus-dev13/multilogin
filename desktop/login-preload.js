const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('authAPI', {
  login: (email, password) => ipcRenderer.invoke('auth-login', email, password),
  register: (name, email, password) => ipcRenderer.invoke('auth-register', name, email, password),
  onAutoLogin: (cb) => ipcRenderer.on('auto-login-result', (e, result) => cb(result))
});
