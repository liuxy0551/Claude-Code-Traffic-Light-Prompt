const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron')
const path = require('path')
const fs = require('fs')

const os = require('os')
// 统一用 ~/.claude/ 目录，Claude Code 已保证该目录存在
const TMP          = path.join(os.homedir(), '.claude')
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
  // Claude Code CLI 在所有平台都用 ~/.claude/settings.json
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function setupClaudeHooks() {
  const settingsPath = getClaudeSettingsPath()
  const settingsDir  = path.dirname(settingsPath)

  // Windows 用 cmd /c echo，避免 echo 带多余空格；macOS/Linux 用 sh
  const isWin = process.platform === 'win32'
  const stateFile = STATE_FILE.replace(/\\/g, '\\\\')
  const HOOKS_TO_ADD = {
    UserPromptSubmit: isWin ? `cmd /c "echo red> \\"${STATE_FILE}\\""` : `echo red > "${STATE_FILE}"`,
    Stop:             isWin ? `cmd /c "echo green> \\"${STATE_FILE}\\""` : `echo green > "${STATE_FILE}"`,
    Elicitation:      isWin ? `cmd /c "echo yellow> \\"${STATE_FILE}\\""` : `echo yellow > "${STATE_FILE}"`,
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

  let changed = false
  for (const [event, command] of Object.entries(HOOKS_TO_ADD)) {
    const existing = settings.hooks[event]
    const alreadySet = Array.isArray(existing) &&
      existing.some(h => Array.isArray(h.hooks) && h.hooks.some(hh => hh.command === command))
    if (!alreadySet) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
      settings.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command }] })
      changed = true
    }
  }

  if (changed) {
    try {
      fs.mkdirSync(settingsDir, { recursive: true })
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
    } catch (e) {
      // 写入失败时弹出提示
      const { dialog } = require('electron')
      dialog.showErrorBox('CC 红绿灯', `自动配置失败，请手动添加 hooks：\n${e.message}\n\n配置文件路径：${settingsPath}`)
    }
  }
}


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
