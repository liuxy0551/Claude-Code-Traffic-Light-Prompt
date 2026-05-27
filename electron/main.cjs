const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')

const os = require('os')
// macOS/Linux 用 /tmp（向后兼容），Windows 用 ~/.claude/（/tmp 不存在）
const TMP          = process.platform === 'win32' ? path.join(os.homedir(), '.claude') : '/tmp'
const STATE_FILE   = path.join(TMP, 'cc_traffic_light_state')
const PID_FILE     = path.join(TMP, 'cc_traffic_light_electron.pid')
const THEME_FILE   = path.join(TMP, 'cc_traffic_light_theme')
const MUTE_FILE    = path.join(TMP, 'cc_traffic_light_mute')
const distPath     = path.join(__dirname, '../dist/index.html')
const isDev        = !fs.existsSync(distPath)

const TRAY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAARklEQVR4nGNgIAD+WxvcIaQGp0Z0TD8DsGmmiiHkeWE+F5kGgDSiYfoZgE0zVQwhywsGFyPIMwCkER3TzwBsmqliCE28AAC/pr8bZBUK/QAAAABJRU5ErkJggg=='

function readTheme() {
  try {
    const t = fs.existsSync(THEME_FILE) ? fs.readFileSync(THEME_FILE, 'utf-8').trim() : ''
    return (t === 'light' || t === 'dark') ? t : 'dark'
  } catch { return 'dark' }
}

function readMute() {
  try {
    return fs.existsSync(MUTE_FILE) && fs.readFileSync(MUTE_FILE, 'utf-8').trim() === 'true'
  } catch { return false }
}

function getClaudeSettingsPath() {
  // 优先检测 CC 实际使用的配置目录，避免因安装方式不同导致路径错误
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
  ]
  if (process.platform === 'win32') {
    // 桌面版 / 不同安装方式可能写到 AppData
    const appdata = process.env.APPDATA || ''
    const localappdata = process.env.LOCALAPPDATA || ''
    candidates.push(
      path.join(appdata, 'Claude Code', 'settings.json'),
      path.join(appdata, 'Claude', 'settings.json'),
      path.join(localappdata, 'Claude Code', 'settings.json'),
      path.join(localappdata, 'AnthropicClaude', 'settings.json'),
    )
  }
  // 返回第一个已存在的路径；都不存在则用默认
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0]
}

function setupClaudeHooks() {
  const settingsPath = getClaudeSettingsPath()
  const settingsDir  = path.dirname(settingsPath)

  const isWin = process.platform === 'win32'
  // Windows 用 %USERPROFILE% 环境变量，避免硬编码绝对路径导致跨机器失效
  const HOOKS_TO_ADD = {
    UserPromptSubmit: isWin
      ? `cmd /c "echo red> %USERPROFILE%\\.claude\\cc_traffic_light_state"`
      : `echo red > ${STATE_FILE}`,
    Stop: isWin
      ? `cmd /c "echo green> %USERPROFILE%\\.claude\\cc_traffic_light_state"`
      : `echo green > ${STATE_FILE}`,
    Elicitation: isWin
      ? `cmd /c "echo yellow> %USERPROFILE%\\.claude\\cc_traffic_light_state"`
      : `echo yellow > ${STATE_FILE}`,
  }

  let settings = {}
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
  } catch {
    settings = {}
  }

  if (!settings.hooks) settings.hooks = {}

  // 清理所有旧的红绿灯 hook（含绝对路径的旧版本），避免残留失效命令
  let changed = false
  for (const event of Object.keys(HOOKS_TO_ADD)) {
    if (!Array.isArray(settings.hooks[event])) continue
    const before = settings.hooks[event].length
    settings.hooks[event] = settings.hooks[event].filter(h => {
      if (!Array.isArray(h.hooks)) return true
      return !h.hooks.some(hh =>
        typeof hh.command === 'string' && hh.command.includes('cc_traffic_light_state')
      )
    })
    if (settings.hooks[event].length !== before) changed = true
  }

  // 写入新 hook
  for (const [event, command] of Object.entries(HOOKS_TO_ADD)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    settings.hooks[event].push({ hooks: [{ type: 'command', command }] })
    changed = true
  }

  if (changed) {
    try {
      fs.mkdirSync(settingsDir, { recursive: true })
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
      lastConfiguredSettingsPath = settingsPath
    } catch (e) {
      const { dialog } = require('electron')
      dialog.showErrorBox('CC 红绿灯', `自动配置失败，请手动添加 hooks：\n${e.message}\n\n配置文件路径：${settingsPath}`)
    }
  } else {
    lastConfiguredSettingsPath = settingsPath
  }
}

let lastConfiguredSettingsPath = ''
let mainWin = null

function buildAppMenu(currentTheme) {
  return Menu.buildFromTemplate([
    {
      label: 'CC 红绿灯',
      submenu: [
        { label: '关于 CC 红绿灯', role: 'about' },
        { type: 'separator' },
        {
          label: currentTheme === 'dark' ? '切换浅色模式' : '切换深色模式',
          click: () => {
            const next = currentTheme === 'dark' ? 'light' : 'dark'
            try { fs.writeFileSync(THEME_FILE, next) } catch {}
            if (mainWin) mainWin.webContents.send('theme-change', next)
            Menu.setApplicationMenu(buildAppMenu(next))
          }
        },
        { type: 'separator' },
        { label: '隐藏', role: 'hide' },
        { label: '退出', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    },
    {
      label: '灯色',
      submenu: [
        { label: '🔴  红灯（思考中）', click: () => { try { fs.writeFileSync(STATE_FILE, 'red') } catch {} } },
        { label: '🟡  黄灯（等待中）', click: () => { try { fs.writeFileSync(STATE_FILE, 'yellow') } catch {} } },
        { label: '🟢  绿灯（已完成）', click: () => { try { fs.writeFileSync(STATE_FILE, 'green') } catch {} } },
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { type: 'separator' },
        { label: '退出', accelerator: 'Cmd+Q', click: () => app.quit() }
      ]
    }
  ])
}

function buildTrayMenu(currentTheme) {
  return Menu.buildFromTemplate([
    { label: '切换到红灯', click: () => { try { fs.writeFileSync(STATE_FILE, 'red') } catch {} } },
    { label: '切换到黄灯', click: () => { try { fs.writeFileSync(STATE_FILE, 'yellow') } catch {} } },
    { label: '切换到绿灯', click: () => { try { fs.writeFileSync(STATE_FILE, 'green') } catch {} } },
    { type: 'separator' },
    {
      label: '查看配置路径',
      click: () => {
        const { dialog, shell } = require('electron')
        const p = lastConfiguredSettingsPath || getClaudeSettingsPath()
        dialog.showMessageBox({
          type: 'info',
          title: 'CC 红绿灯 — 配置路径',
          message: 'Hooks 已写入以下文件：',
          detail: p + '\n\n如果红绿灯不响应，请确认 Claude Code 读取的是这个文件。\n点击"打开文件"可直接查看内容。',
          buttons: ['打开文件', '关闭'],
          defaultId: 1,
        }).then(({ response }) => { if (response === 0) shell.openPath(p) })
      }
    },
    {
      label: '重新写入配置',
      click: () => {
        setupClaudeHooks()
        const { dialog } = require('electron')
        dialog.showMessageBox({
          type: 'info',
          title: 'CC 红绿灯',
          message: '配置已重新写入',
          detail: lastConfiguredSettingsPath || getClaudeSettingsPath(),
          buttons: ['确定'],
        })
      }
    },
    { type: 'separator' },
    {
      label: currentTheme === 'dark' ? '切换浅色模式' : '切换深色模式',
      click: () => {
        const next = currentTheme === 'dark' ? 'light' : 'dark'
        try { fs.writeFileSync(THEME_FILE, next) } catch {}
        if (mainWin) mainWin.webContents.send('theme-change', next)
        tray.setContextMenu(buildTrayMenu(next))
        Menu.setApplicationMenu(buildAppMenu(next))
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize

  // 读取上次保存的位置，若超出屏幕则重置到右上角
  const POS_FILE = path.join(require('os').tmpdir(), 'cc_traffic_light_pos')
  let wx = sw - 120, wy = 80
  try {
    if (fs.existsSync(POS_FILE)) {
      const [px, py] = fs.readFileSync(POS_FILE, 'utf-8').split(',').map(Number)
      if (px >= 0 && px < sw - 20 && py >= 0 && py < sh - 20) { wx = px; wy = py }
    }
  } catch {}

  mainWin = new BrowserWindow({
    width: 100,
    height: 220,
    x: wx,
    y: wy,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWin.setAlwaysOnTop(true, 'floating')
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (isDev) {
    mainWin.loadURL('http://localhost:5173')
  } else {
    mainWin.loadFile(distPath)
  }

  let lastState = ''
  let lastTheme = readTheme()

  const poll = setInterval(() => {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const state = fs.readFileSync(STATE_FILE, 'utf-8').trim()
        if (state !== lastState) {
          lastState = state
          mainWin.webContents.send('state-change', state)
        }
      }
    } catch {}
  }, 300)

  mainWin.on('closed', () => { clearInterval(poll); mainWin = null })
  mainWin.on('moved', () => {
    try {
      const [x, y] = mainWin.getPosition()
      fs.writeFileSync(path.join(require('os').tmpdir(), 'cc_traffic_light_pos'), `${x},${y}`)
    } catch {}
  })

  ipcMain.on('set-state', (_, state) => {
    try { fs.writeFileSync(STATE_FILE, state); lastState = state } catch {}
  })

  ipcMain.on('focus-app', () => {
    app.focus({ steal: true })
    if (mainWin) mainWin.focus()
  })

  ipcMain.on('quit', () => app.quit())

  ipcMain.handle('get-theme', () => readTheme())

  ipcMain.handle('get-mute', () => readMute())

  ipcMain.on('set-mute', (_, muted) => {
    try { fs.writeFileSync(MUTE_FILE, muted ? 'true' : 'false') } catch {}
  })

  ipcMain.on('set-window-height', (_, h) => {
    if (mainWin) mainWin.setSize(100, h)
  })

  ipcMain.on('set-theme', (_, theme) => {
    lastTheme = theme
    try { fs.writeFileSync(THEME_FILE, theme) } catch {}
    if (tray) tray.setContextMenu(buildTrayMenu(theme))
    Menu.setApplicationMenu(buildAppMenu(theme))
  })
}

app.whenReady().then(() => {
  // 确保 ~/.claude 目录存在
  try { fs.mkdirSync(TMP, { recursive: true }) } catch {}

  if (process.platform !== 'win32') {
    // 杀掉旧的 Python 版，防止两个红绿灯同时出现
    require('child_process').exec("pkill -f 'traffic_light.py'")
  }

  setupClaudeHooks()

  try { fs.writeFileSync(PID_FILE, process.pid.toString()) } catch {}

  const theme = readTheme()

  // macOS 应用菜单栏
  Menu.setApplicationMenu(buildAppMenu(theme))

  // 系统托盘（右上角）
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(icon)
  tray.setToolTip('CC 红绿灯')
  tray.setContextMenu(buildTrayMenu(theme))

  createWindow()
})

app.on('will-quit', () => {
  try { fs.unlinkSync(PID_FILE) } catch {}
})

app.on('window-all-closed', () => app.quit())
