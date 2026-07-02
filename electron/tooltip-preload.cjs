const { contextBridge, ipcRenderer } = require('electron')

// 通用的 tooltip API，同时支持 MiMo 和 ChatGPT
contextBridge.exposeInMainWorld('tooltipAPI', {
  // MiMo 相关
  refreshBalance: () => ipcRenderer.invoke('refresh-balance-tooltip'),
  updateCookie: (cookie) => ipcRenderer.invoke('update-balance-cookie', cookie),
  getLastBalanceRefreshTime: () => ipcRenderer.invoke('get-last-balance-refresh-time'),

  // ChatGPT 相关
  refreshChatGPT: () => ipcRenderer.invoke('refresh-chatgpt-tooltip'),
  updateToken: (token) => ipcRenderer.invoke('update-chatgpt-token', token),
  getLastChatgptRefreshTime: () => ipcRenderer.invoke('get-last-chatgpt-refresh-time'),

  // 通用
  resize: (height) => ipcRenderer.send('resize-balance-tooltip', height),
  resizeChatGPT: (height) => ipcRenderer.send('resize-chatgpt-tooltip', height),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  getPollInterval: () => ipcRenderer.invoke('get-poll-interval'),
})
