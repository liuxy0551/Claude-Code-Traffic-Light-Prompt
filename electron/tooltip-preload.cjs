const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tooltipAPI', {
  refreshBalance: () => ipcRenderer.invoke('refresh-balance-tooltip'),
  updateCookie: (cookie) => ipcRenderer.invoke('update-balance-cookie', cookie),
  resize: (height) => ipcRenderer.send('resize-balance-tooltip', height),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
})
