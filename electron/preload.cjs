const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  onStateChange: (callback) => {
    const handler = (_, state) => callback(state)
    ipcRenderer.on('state-change', handler)
    return () => ipcRenderer.removeListener('state-change', handler)
  },
  setState: (state) => ipcRenderer.send('set-state', state),
  quit: () => ipcRenderer.send('quit'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onThemeChange: (callback) => {
    const handler = (_, theme) => callback(theme)
    ipcRenderer.on('theme-change', handler)
    return () => ipcRenderer.removeListener('theme-change', handler)
  },
  getStyle: () => ipcRenderer.invoke('get-style'),
  setStyle: (style) => ipcRenderer.send('set-style', style),
  onStyleChange: (callback) => {
    const handler = (_, style) => callback(style)
    ipcRenderer.on('style-change', handler)
    return () => ipcRenderer.removeListener('style-change', handler)
  },
  focusApp: () => ipcRenderer.send('focus-app'),
  getMute: () => ipcRenderer.invoke('get-mute'),
  setMute: (muted) => ipcRenderer.send('set-mute', muted),
  getStats: () => ipcRenderer.invoke('get-stats'),
  setWindowHeight: (h) => ipcRenderer.send('set-window-height', h),
  setWindowWidth: (w) => ipcRenderer.send('set-window-width', w),
  fetchBalance: () => ipcRenderer.invoke('fetch-balance'),
  openBalanceTooltip: (data) => ipcRenderer.send('open-balance-tooltip', data),
  onBalanceUpdate: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('balance-update', handler)
    return () => ipcRenderer.removeListener('balance-update', handler)
  },
  onBalanceVisibleChange: (callback) => {
    const handler = (_, visible) => callback(visible)
    ipcRenderer.on('balance-visible-change', handler)
    return () => ipcRenderer.removeListener('balance-visible-change', handler)
  },

  // ChatGPT 用量
  fetchChatGPTUsage: () => ipcRenderer.invoke('fetch-chatgpt-usage'),
  openChatGPTTooltip: (data) => ipcRenderer.invoke('open-chatgpt-tooltip', data),
  onChatGPTUpdate: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('chatgpt-update', handler)
    return () => ipcRenderer.removeListener('chatgpt-update', handler)
  },
  updateChatGPTToken: (token) => ipcRenderer.invoke('update-chatgpt-token', token),

  // 静音状态变化（从托盘菜单触发）
  onMuteChange: (callback) => {
    const handler = (_, muted) => callback(muted)
    ipcRenderer.on('mute-change', handler)
    return () => ipcRenderer.removeListener('mute-change', handler)
  },

  // 从托盘菜单打开 ChatGPT tooltip
  onOpenChatGPTTooltipFromTray: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('open-chatgpt-tooltip-from-tray', handler)
    return () => ipcRenderer.removeListener('open-chatgpt-tooltip-from-tray', handler)
  },

  // 从托盘菜单打开 MiMo tooltip
  onOpenBalanceTooltipFromTray: (callback) => {
    const handler = (_, data) => callback(data)
    ipcRenderer.on('open-balance-tooltip-from-tray', handler)
    return () => ipcRenderer.removeListener('open-balance-tooltip-from-tray', handler)
  },

  // 用量显示模式变化
  getUsageMode: () => ipcRenderer.invoke('get-usage-mode'),
  onUsageModeChange: (callback) => {
    const handler = (_, mode) => callback(mode)
    ipcRenderer.on('usage-mode-change', handler)
    return () => ipcRenderer.removeListener('usage-mode-change', handler)
  },
})
