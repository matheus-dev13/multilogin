const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchProfile: (profile) => ipcRenderer.invoke('launch-profile', profile),
  closeProfile: (profileId) => ipcRenderer.invoke('close-profile', profileId),
  isProfileRunning: (profileId) => ipcRenderer.invoke('is-profile-running', profileId),
  getRunningProfiles: () => ipcRenderer.invoke('get-running-profiles'),
  getInstalledBrowsers: () => ipcRenderer.invoke('get-installed-browsers'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  clearProfileData: (profileId, what) => ipcRenderer.invoke('clear-profile-data', profileId, what),
  onProfileClosed: (callback) => ipcRenderer.on('profile-closed', (event, id) => callback(id)),
  loadProfilesData: () => ipcRenderer.invoke('load-profiles-data'),
  saveProfilesData: (data) => ipcRenderer.invoke('save-profiles-data', data),
  logout: () => ipcRenderer.invoke('auth-logout'),
  getCurrentUser: () => ipcRenderer.invoke('get-current-user')
});
