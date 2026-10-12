const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchProfile: (profile) => ipcRenderer.invoke('launch-profile', profile),
  closeProfile: (profileId) => ipcRenderer.invoke('close-profile', profileId),
  isProfileRunning: (profileId) => ipcRenderer.invoke('is-profile-running', profileId),
  getRunningProfiles: () => ipcRenderer.invoke('get-running-profiles'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onProfileClosed: (callback) => ipcRenderer.on('profile-closed', (event, id) => callback(id))
});
