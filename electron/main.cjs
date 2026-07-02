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
const STYLE_FILE   = path.join(TMP, 'cc_traffic_light_style')
const COOKIE_FILE  = path.join(TMP, 'cc_traffic_light_cookie')
const CHATGPT_TOKEN_FILE = path.join(TMP, 'cc_traffic_light_chatgpt_token')
const USAGE_MODE_FILE = path.join(TMP, 'cc_traffic_light_usage_mode') // 'mimo' | 'chatgpt' | 'none'
const POLL_INTERVAL_FILE = path.join(TMP, 'cc_traffic_light_poll_interval') // 分钟数
// 统计文件存到 ~/.claude/，跨平台持久化，不放 /tmp 避免重启丢失
const STATS_FILE   = path.join(os.homedir(), '.claude', 'cc_traffic_light_stats.json')
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

function readStyle() {
  try {
    const s = fs.existsSync(STYLE_FILE) ? fs.readFileSync(STYLE_FILE, 'utf-8').trim() : ''
    // 兼容旧的 'triple' 值
    if (s === 'triple' || s === 'triple-vertical') return 'triple-vertical'
    if (s === 'triple-horizontal') return 'triple-horizontal'
    return 'single'
  } catch { return 'triple-vertical' }
}

function getToday() {
  // 用本地时区日期，避免跨时区问题
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function readStats() {
  try {
    return fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')) : {}
  } catch { return {} }
}

function saveStats(stats) {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true })
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2))
  } catch {}
}

function recordStateChange(newState, prevState, redStartTime) {
  const today = getToday()
  const stats = readStats()
  if (!stats[today]) stats[today] = { redCount: 0, greenCount: 0, redDuration: 0 }
  if (newState === 'red') {
    stats[today].redCount++
  } else if (newState === 'green') {
    stats[today].greenCount++
    if (prevState === 'red' && redStartTime) {
      stats[today].redDuration += Date.now() - redStartTime
    }
  }
  saveStats(stats)
}

// ─── 余量查询 ───────────────────────────────────────────────────
const DEFAULT_BALANCE_CONFIG = {
  request: {
    url: 'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
    method: 'GET',
    headers: {
      Cookie: ``,
      'User-Agent': 'cc-switch/1.0',
      Accept: 'application/json',
    },
  },
  extractor: `function (response) {
    const SCALE = 1000000;
    const items = response?.data?.usage?.items || [];
    const planConfigs = [
      { name: "plan_total_token", planName: "套餐" },
      { name: "compensation_total_token", planName: "补偿" },
    ];
    const formatPercent = (used, total, fallbackPercent) => {
      const percent = total > 0 ? used / total : Number(fallbackPercent || 0);
      return (percent * 100).toFixed(2).replace(/\\.?0+$/, "") + "%";
    };
    const formatValue = (value) => (value / SCALE) / 100;
    return planConfigs.map(({ name, planName }) => {
      const item = items.find((i) => i?.name === name);
      if (!item) return null;
      const used = Number(item?.used || 0);
      const total = Number(item?.limit || 0);
      const remaining = Math.max(total - used, 0);
      return {
        isValid: true, planName,
        used: formatValue(used), total: formatValue(total), remaining: formatValue(remaining),
        unit: "亿 Credits",
        extra: formatPercent(used, total, item?.percent),
      };
    }).filter(Boolean).filter(item => item.total > 0);
  }`,
}

function readSavedCookie() {
  try {
    return fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf-8').trim() : ''
  } catch { return '' }
}

function readUsageMode() {
  try {
    return fs.existsSync(USAGE_MODE_FILE) ? fs.readFileSync(USAGE_MODE_FILE, 'utf-8').trim() : 'MiMo'
  } catch { return 'MiMo' }
}

function readPollInterval() {
  try {
    const val = fs.existsSync(POLL_INTERVAL_FILE) ? parseInt(fs.readFileSync(POLL_INTERVAL_FILE, 'utf-8').trim()) : 3
    return [1, 2, 3, 5, 10].includes(val) ? val : 3
  } catch { return 3 }
}

let balanceConfig = { ...DEFAULT_BALANCE_CONFIG }
// 启动时回显已保存的 Cookie
;(function() {
  const saved = readSavedCookie()
  if (saved) balanceConfig.request.headers.Cookie = saved
})()

function fetchBalanceData() {
  return new Promise((resolve) => {
    try {
      const { request: reqConfig, extractor } = balanceConfig
      if (!reqConfig || !reqConfig.url) {
        return resolve({ isValid: false, error: '无效的配置：缺少 request.url' })
      }

      const url = new URL(reqConfig.url)
      const transport = url.protocol === 'https:' ? require('https') : require('http')

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: reqConfig.method || 'GET',
        headers: reqConfig.headers || {},
        timeout: 10000,
      }

      const req = transport.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            const fn = new Function('return (' + extractor + ')')()
            const result = fn(json)
            if (Array.isArray(result)) {
              resolve({ items: result })
            } else {
              resolve(result)
            }
          } catch (e) {
            resolve({ isValid: false, error: '解析失败: ' + e.message })
          }
        })
      })

      req.on('error', (e) => resolve({ isValid: false, error: '请求失败: ' + e.message }))
      req.on('timeout', () => { req.destroy(); resolve({ isValid: false, error: '请求超时' }) })
      req.end()
    } catch (e) {
      resolve({ isValid: false, error: e.message })
    }
  })
}

// ─── ChatGPT 用量查询 ─────────────────────────────────────────────
function readSavedChatGPTToken() {
  try {
    // 优先使用用户手动设置的 token
    if (fs.existsSync(CHATGPT_TOKEN_FILE)) {
      const saved = fs.readFileSync(CHATGPT_TOKEN_FILE, 'utf-8').trim()
      if (saved) return { token: saved, isManual: true }
    }
    // 回退到 Codex auth.json 自动读取
    const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json')
    if (fs.existsSync(codexAuthPath)) {
      const authData = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'))
      if (authData?.tokens?.access_token) {
        return { token: authData.tokens.access_token, isManual: false }
      }
    }
    return { token: '', isManual: false }
  } catch { return { token: '', isManual: false } }
}

function refreshChatGPTToken() {
  return new Promise((resolve) => {
    try {
      const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json')
      if (!fs.existsSync(codexAuthPath)) {
        return resolve({ ok: false, error: 'Codex auth.json 不存在' })
      }
      const authData = JSON.parse(fs.readFileSync(codexAuthPath, 'utf-8'))
      const refreshToken = authData?.tokens?.refresh_token
      if (!refreshToken) {
        return resolve({ ok: false, error: '没有 refresh_token' })
      }

      const { net } = require('electron')
      const postData = JSON.stringify({
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })

      const request = net.request({
        method: 'POST',
        url: 'https://auth.openai.com/oauth/token',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      let responseData = ''
      request.on('response', (response) => {
        response.on('data', (chunk) => { responseData += chunk.toString() })
        response.on('end', () => {
          try {
            const json = JSON.parse(responseData)
            if (json.access_token) {
              // 更新 auth.json
              authData.tokens.access_token = json.access_token
              if (json.refresh_token) {
                authData.tokens.refresh_token = json.refresh_token
              }
              authData.last_refresh = new Date().toISOString()
              fs.writeFileSync(codexAuthPath, JSON.stringify(authData, null, 2))
              resolve({ ok: true, token: json.access_token })
            } else {
              resolve({ ok: false, error: json.error?.message || '刷新失败' })
            }
          } catch (e) {
            resolve({ ok: false, error: e.message })
          }
        })
      })

      request.on('error', (e) => resolve({ ok: false, error: e.message }))
      setTimeout(() => { request.abort(); resolve({ ok: false, error: '超时' }) }, 15000)
      request.write(postData)
      request.end()
    } catch (e) {
      resolve({ ok: false, error: e.message })
    }
  })
}

function fetchChatGPTUsage(retryCount = 0) {
  return new Promise((resolve) => {
    try {
      const { token } = readSavedChatGPTToken()
      if (!token) {
        return resolve({ isValid: false, error: '未设置 token' })
      }

      const { net } = require('electron')
      const request = net.request({
        method: 'GET',
        url: 'https://chatgpt.com/backend-api/wham/usage',
        headers: {
          'Authorization': 'Bearer ' + token,
          'User-Agent': 'codex-cli',
          'Accept': 'application/json',
        },
      })

      let responseData = ''
      request.on('response', (response) => {
        response.on('data', (chunk) => {
          responseData += chunk.toString()
        })
        response.on('end', () => {
          // 如果 401 且未重试过，尝试刷新 token
          if (response.statusCode === 401 && retryCount === 0) {
            refreshChatGPTToken().then((result) => {
              if (result.ok) {
                fetchChatGPTUsage(1).then(resolve)
              } else {
                resolve({ isValid: false, error: 'token 已失效，请重新登录 Codex' })
              }
            })
            return
          }

          try {
            const json = JSON.parse(responseData)
            const primary = json?.rate_limit?.primary_window
            const secondary = json?.rate_limit?.secondary_window
            resolve({
              isValid: true,
              primary: primary ? {
                usedPercent: primary.used_percent,
                windowSeconds: primary.limit_window_seconds,
                resetAfterSeconds: primary.reset_after_seconds,
                resetAt: primary.reset_at,
              } : null,
              secondary: secondary ? {
                usedPercent: secondary.used_percent,
                windowSeconds: secondary.limit_window_seconds,
                resetAfterSeconds: secondary.reset_after_seconds,
                resetAt: secondary.reset_at,
              } : null,
            })
          } catch (e) {
            resolve({ isValid: false, error: '解析失败: ' + e.message })
          }
        })
      })

      request.on('error', (e) => resolve({ isValid: false, error: '请求失败: ' + e.message }))
      setTimeout(() => {
        request.abort()
        resolve({ isValid: false, error: '请求超时' })
      }, 15000)
      request.end()
    } catch (e) {
      resolve({ isValid: false, error: e.message })
    }
  })
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
      path.join(appdata, 'Agent', 'settings.json'),
      path.join(appdata, 'Claude', 'settings.json'),
      path.join(localappdata, 'Agent', 'settings.json'),
      path.join(localappdata, 'AnthropicClaude', 'settings.json'),
    )
  }
  // 返回第一个已存在的路径；都不存在则用默认
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0]
}

function getCodexHooksPath() {
  return path.join(os.homedir(), '.codex', 'hooks.json')
}

function setupAllHooks() {
  setupAllHooks()
  setupCodexHooks()
}

function setupAllHooks() {
  const settingsPath = getClaudeSettingsPath()
  const settingsDir  = path.dirname(settingsPath)

  const isWin = process.platform === 'win32'
  // Windows 用 %USERPROFILE% 环境变量，避免硬编码绝对路径导致跨机器失效
  const stateCmd = (color) => isWin
    ? `cmd /c "echo ${color}> %USERPROFILE%\\.claude\\cc_traffic_light_state"`
    : `echo ${color} > ${STATE_FILE}`

  // Elicitation 在旧版 CC（<2.1.76）不支持，改用 PreToolUse+AskUserQuestion 触发黄灯
  // UserPromptSubmit/Stop 是生命周期事件，不需要 matcher 字段
  const HOOKS_TO_ADD = [
    { event: 'UserPromptSubmit', command: stateCmd('red')    },
    { event: 'Stop',             command: stateCmd('green')  },
    { event: 'PreToolUse',       matcher: 'AskUserQuestion', command: stateCmd('yellow') },
  ]
  // 需要清理的旧事件（含已废弃的 Elicitation）
  const EVENTS_TO_CLEAN = ['UserPromptSubmit', 'Stop', 'PreToolUse', 'Elicitation']

  let settings = {}
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
  } catch {
    settings = {}
  }

  if (!settings.hooks) settings.hooks = {}

  // 清理所有旧的红绿灯 hook（含绝对路径旧版本、Elicitation 废弃事件）
  let changed = false
  for (const event of EVENTS_TO_CLEAN) {
    if (!Array.isArray(settings.hooks[event])) continue
    const before = settings.hooks[event].length
    settings.hooks[event] = settings.hooks[event].filter(h => {
      if (!Array.isArray(h.hooks)) return true
      return !h.hooks.some(hh =>
        typeof hh.command === 'string' && hh.command.includes('cc_traffic_light_state')
      )
    })
    if (settings.hooks[event].length !== before) changed = true
    // 清空后删除空数组，避免留下空 key
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }

  // 写入新 hook（matcher 仅在需要时写入，生命周期事件不加 matcher）
  for (const { event, matcher, command } of HOOKS_TO_ADD) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const entry = { hooks: [{ type: 'command', command }] }
    if (matcher) entry.matcher = matcher
    settings.hooks[event].push(entry)
    changed = true
  }

  if (changed) {
    try {
      fs.mkdirSync(settingsDir, { recursive: true })
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
      lastConfiguredSettingsPath = settingsPath
    } catch (e) {
      const { dialog } = require('electron')
      dialog.showErrorBox('Agent 红绿灯', `自动配置失败，请手动添加 hooks：\n${e.message}\n\n配置文件路径：${settingsPath}`)
    }
  } else {
    lastConfiguredSettingsPath = settingsPath
  }
}

function setupCodexHooks() {
  const hooksPath = getCodexHooksPath()
  const hooksDir = path.dirname(hooksPath)

  const isWin = process.platform === 'win32'
  const stateCmd = (color) => isWin
    ? `cmd /c "echo ${color}> %USERPROFILE%\\.claude\\cc_traffic_light_state"`
    : `echo ${color} > ${STATE_FILE}`

  // Codex 使用和 Agent 相同的事件名
  const HOOKS_TO_ADD = [
    { event: 'UserPromptSubmit', command: stateCmd('red') },
    { event: 'Stop', command: stateCmd('green') },
    { event: 'PreToolUse', matcher: 'AskUserQuestion', command: stateCmd('yellow') },
  ]
  const EVENTS_TO_CLEAN = ['UserPromptSubmit', 'Stop', 'PreToolUse', 'Elicitation']

  let hooks = {}
  try {
    if (fs.existsSync(hooksPath)) {
      hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'))
    }
  } catch {
    hooks = {}
  }

  if (!hooks.hooks) hooks.hooks = {}

  // 清理旧的红绿灯 hook
  let changed = false
  for (const event of EVENTS_TO_CLEAN) {
    if (!Array.isArray(hooks.hooks[event])) continue
    const before = hooks.hooks[event].length
    hooks.hooks[event] = hooks.hooks[event].filter(h => {
      if (!Array.isArray(h.hooks)) return true
      return !h.hooks.some(hh =>
        typeof hh.command === 'string' && hh.command.includes('cc_traffic_light_state')
      )
    })
    if (hooks.hooks[event].length !== before) changed = true
    if (hooks.hooks[event].length === 0) delete hooks.hooks[event]
  }

  // 写入新 hook
  for (const { event, matcher, command } of HOOKS_TO_ADD) {
    if (!Array.isArray(hooks.hooks[event])) hooks.hooks[event] = []
    const entry = { hooks: [{ type: 'command', command }] }
    if (matcher) entry.matcher = matcher
    hooks.hooks[event].push(entry)
    changed = true
  }

  if (changed) {
    try {
      fs.mkdirSync(hooksDir, { recursive: true })
      fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), 'utf-8')
      lastConfiguredSettingsPath = hooksPath
    } catch (e) {
      const { dialog } = require('electron')
      dialog.showErrorBox('Agent 红绿灯', `Codex hooks 配置失败：\n${e.message}\n\n配置文件路径：${hooksPath}`)
    }
  } else {
    lastConfiguredSettingsPath = hooksPath
  }
}

let lastConfiguredSettingsPath = ''
let mainWin = null

function needsUpdate(remoteVersion) {
  try {
    const current = require('../package.json').version
    const parse = v => v.split('.').map(Number)
    const [rMaj, rMin, rPat] = parse(remoteVersion)
    const [cMaj, cMin, cPat] = parse(current)
    return rMaj > cMaj || (rMaj === cMaj && rMin > cMin) || (rMaj === cMaj && rMin === cMin && rPat > cPat)
  } catch { return false }
}

function handleRemoteConfig({ version, notes, message }, manual = false) {
  const { dialog, shell } = require('electron')
  const showUpdate = () => {
    if (!version || !needsUpdate(version)) {
      if (manual) {
        const current = require('../package.json').version
        dialog.showMessageBox({
          type: 'info',
          title: 'Agent 红绿灯',
          message: `当前已是最新版本 v${current}`,
          buttons: ['好的'],
        })
      }
      return
    }
    dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `Agent 红绿灯 v${version} 已发布`,
      detail: (notes || '') + '\n\n点击"立即更新"跳转到下载页面。',
      buttons: ['立即更新', '稍后再说'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        shell.openExternal('https://github.com/freed85-xiaozai/Claude-Code-Traffic-Light-Prompt/releases/latest')
      }
    })
  }

  if (message && message.trim()) {
    dialog.showMessageBox({
      type: 'info',
      title: '来自作者的消息',
      message: message.trim(),
      buttons: ['知道了'],
    }).then(showUpdate)
  } else {
    showUpdate()
  }
}

function checkForUpdates(manual = false) {
  const https = require('https')
  const url = 'https://cdn.jsdelivr.net/gh/freed85-xiaozai/Claude-Code-Traffic-Light-Prompt@main/public/update.json'
  const req = https.get(url, (res) => {
    let data = ''
    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      try { handleRemoteConfig(JSON.parse(data), manual) } catch {}
    })
  })
  req.on('error', () => {
    if (manual) {
      const { dialog } = require('electron')
      dialog.showErrorBox('Agent 红绿灯', '检查更新失败，请检查网络连接。')
    }
  })
  req.setTimeout(8000, () => req.destroy())
}

function buildAppMenu(currentTheme) {
  return Menu.buildFromTemplate([
    {
      label: 'Agent 红绿灯',
      submenu: [
        { label: '关于 Agent 红绿灯', role: 'about' },
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

function setPollInterval(minutes) {
  try { fs.writeFileSync(POLL_INTERVAL_FILE, String(minutes)) } catch {}
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('poll-interval-changed')
  }
}

function closeAllTooltips() {
  if (balanceTooltipWin && !balanceTooltipWin.isDestroyed()) {
    balanceTooltipWin.close()
    balanceTooltipWin = null
  }
  if (chatgptTooltipWin && !chatgptTooltipWin.isDestroyed()) {
    chatgptTooltipWin.close()
    chatgptTooltipWin = null
  }
}

function buildTrayMenu(currentTheme, currentStyle) {
  const isSingle = currentStyle === 'single'
  const isMuted = readMute()
  const usageMode = readUsageMode()
  const pollInterval = readPollInterval()
  return Menu.buildFromTemplate([
    // 用量查询
    {
      label: '📊 用量查询',
      submenu: [
        {
          label: '显示 MiMo 用量',
          type: 'radio',
          checked: usageMode === 'mimo',
          click: () => {
            try { fs.writeFileSync(USAGE_MODE_FILE, 'mimo') } catch {}
            closeAllTooltips()
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.webContents.send('usage-mode-change', 'mimo')
            }
            tray.setContextMenu(buildTrayMenu(currentTheme, currentStyle))
          }
        },
        {
          label: '显示 Codex 用量',
          type: 'radio',
          checked: usageMode === 'chatgpt',
          click: () => {
            try { fs.writeFileSync(USAGE_MODE_FILE, 'chatgpt') } catch {}
            closeAllTooltips()
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.webContents.send('usage-mode-change', 'chatgpt')
            }
            tray.setContextMenu(buildTrayMenu(currentTheme, currentStyle))
          }
        },
        {
          label: '隐藏用量',
          type: 'radio',
          checked: usageMode === 'none',
          click: () => {
            try { fs.writeFileSync(USAGE_MODE_FILE, 'none') } catch {}
            closeAllTooltips()
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.webContents.send('usage-mode-change', 'none')
            }
            tray.setContextMenu(buildTrayMenu(currentTheme, currentStyle))
          }
        },
      ]
    },
    {
      label: '⏱️ 刷新间隔',
      submenu: [
        { label: '1 分钟', type: 'radio', checked: pollInterval === 1, click: () => setPollInterval(1) },
        { label: '2 分钟', type: 'radio', checked: pollInterval === 2, click: () => setPollInterval(2) },
        { label: '3 分钟', type: 'radio', checked: pollInterval === 3, click: () => setPollInterval(3) },
        { label: '5 分钟', type: 'radio', checked: pollInterval === 5, click: () => setPollInterval(5) },
        { label: '10 分钟', type: 'radio', checked: pollInterval === 10, click: () => setPollInterval(10) },
      ]
    },
    { type: 'separator' },

    // 灯色和样式切换
    {
      label: '🚦 灯色切换',
      submenu: [
        { label: '红灯', click: () => { try { fs.writeFileSync(STATE_FILE, 'red') } catch {} } },
        { label: '黄灯', click: () => { try { fs.writeFileSync(STATE_FILE, 'yellow') } catch {} } },
        { label: '绿灯', click: () => { try { fs.writeFileSync(STATE_FILE, 'green') } catch {} } },
        { type: 'separator' },
        {
          label: '演示模式',
          click: () => {
            // 立即显示红灯
            try { fs.writeFileSync(STATE_FILE, 'red') } catch {}
            // 2 秒后黄灯
            setTimeout(() => { try { fs.writeFileSync(STATE_FILE, 'yellow') } catch {} }, 2000)
            // 4 秒后绿灯
            setTimeout(() => { try { fs.writeFileSync(STATE_FILE, 'green') } catch {} }, 4000)
          }
        },
      ]
    },
    {
      label: '🎨 样式切换',
      submenu: [
        {
          label: '单灯',
          type: 'radio',
          checked: currentStyle === 'single',
          click: () => {
            try { fs.writeFileSync(STYLE_FILE, 'single') } catch {}
            if (mainWin) mainWin.webContents.send('style-change', 'single')
            tray.setContextMenu(buildTrayMenu(currentTheme, 'single'))
          }
        },
        {
          label: '横版三灯',
          type: 'radio',
          checked: currentStyle === 'triple-horizontal',
          click: () => {
            try { fs.writeFileSync(STYLE_FILE, 'triple-horizontal') } catch {}
            if (mainWin) mainWin.webContents.send('style-change', 'triple-horizontal')
            tray.setContextMenu(buildTrayMenu(currentTheme, 'triple-horizontal'))
          }
        },
        {
          label: '竖版三灯',
          type: 'radio',
          checked: currentStyle === 'triple-vertical',
          click: () => {
            try { fs.writeFileSync(STYLE_FILE, 'triple-vertical') } catch {}
            if (mainWin) mainWin.webContents.send('style-change', 'triple-vertical')
            tray.setContextMenu(buildTrayMenu(currentTheme, 'triple-vertical'))
          }
        },
      ]
    },
    { type: 'separator' },

    // 设置和配置
    {
      label: '⚙️ 设置',
      submenu: [
        {
          label: isMuted ? '🔇 取消静音' : '🔔 静音',
          click: () => {
            const next = !isMuted
            try { fs.writeFileSync(MUTE_FILE, next ? 'true' : 'false') } catch {}
            if (mainWin && !mainWin.isDestroyed()) {
              mainWin.webContents.send('mute-change', next)
            }
            tray.setContextMenu(buildTrayMenu(currentTheme, currentStyle))
          }
        },
        {
          label: currentTheme === 'dark' ? '☀️ 浅色模式' : '🌙 深色模式',
          click: () => {
            const next = currentTheme === 'dark' ? 'light' : 'dark'
            try { fs.writeFileSync(THEME_FILE, next) } catch {}
            if (mainWin) mainWin.webContents.send('theme-change', next)
            tray.setContextMenu(buildTrayMenu(next, currentStyle))
            Menu.setApplicationMenu(buildAppMenu(next))
          }
        },
      ]
    },
    {
      label: '📝 写入配置',
      submenu: [
        {
          label: 'Claude Code',
          click: () => {
            setupClaudeHooks()
            const { dialog } = require('electron')
            dialog.showMessageBox({
              type: 'info',
              title: 'Agent 红绿灯',
              message: 'Claude Code 配置已写入',
              detail: getClaudeSettingsPath(),
              buttons: ['确定'],
            })
          }
        },
        {
          label: 'Codex',
          click: () => {
            setupCodexHooks()
            const { dialog } = require('electron')
            dialog.showMessageBox({
              type: 'info',
              title: 'Agent 红绿灯',
              message: 'Codex 配置已写入',
              detail: getCodexHooksPath(),
              buttons: ['确定'],
            })
          }
        },
        {
          label: '以上全部',
          click: () => {
            setupAllHooks()
            const { dialog } = require('electron')
            dialog.showMessageBox({
              type: 'info',
              title: 'Agent 红绿灯',
              message: '配置已全部写入',
              detail: 'Claude Code: ' + getClaudeSettingsPath() + '\nCodex: ' + getCodexHooksPath(),
              buttons: ['确定'],
            })
          }
        },
        { type: 'separator' },
        {
          label: '复制手动配置',
          click: () => {
            const { clipboard, dialog } = require('electron')
            const isWin = process.platform === 'win32'
            const snippet = isWin
              ? `"UserPromptSubmit": [{"hooks": [{"type": "command","command": "cmd /c \\"echo red> %USERPROFILE%\\\\.claude\\\\cc_traffic_light_state\\""}]}],\n  "Stop": [{"hooks": [{"type": "command","command": "cmd /c \\"echo green> %USERPROFILE%\\\\.claude\\\\cc_traffic_light_state\\""}]}],\n  "PreToolUse": [{"matcher": "AskUserQuestion","hooks": [{"type": "command","command": "cmd /c \\"echo yellow> %USERPROFILE%\\\\.claude\\\\cc_traffic_light_state\\""}]}]`
              : `"UserPromptSubmit": [{"hooks": [{"type": "command","command": "echo red > /tmp/cc_traffic_light_state"}]}],\n  "Stop": [{"hooks": [{"type": "command","command": "echo green > /tmp/cc_traffic_light_state"}]}],\n  "PreToolUse": [{"matcher": "AskUserQuestion","hooks": [{"type": "command","command": "echo yellow > /tmp/cc_traffic_light_state"}]}]`
            clipboard.writeText(snippet)
            dialog.showMessageBox({
              type: 'info',
              title: 'Agent 红绿灯',
              message: '已复制到剪贴板',
              detail: '请在以下文件的 "hooks": { } 内粘贴：\n\nClaude Code: ' + getClaudeSettingsPath() + '\nCodex: ' + getCodexHooksPath() + '\n\n保存后重启对应工具即可。',
              buttons: ['知道了'],
            })
          }
        },
        {
          label: '查看配置路径',
          click: () => {
            const { dialog } = require('electron')
            dialog.showMessageBox({
              type: 'info',
              title: 'Agent 红绿灯 — 配置路径',
              message: '配置文件位置：',
              detail: 'Claude Code: ' + getClaudeSettingsPath() + '\nCodex: ' + getCodexHooksPath() + '\n\n如果红绿灯不响应，请确认对应工具读取的是这些文件。',
              buttons: ['关闭'],
              defaultId: 0,
            })
          }
        },
      ]
    },
    { type: 'separator' },

    // 其他功能
    {
      label: '📈 本周周报',
      click: () => {
        const { dialog } = require('electron')
        const stats = readStats()
        const today = new Date()
        const dow = today.getDay() || 7
        let totalRed = 0, totalGreen = 0, totalDuration = 0
        for (let i = 1; i <= dow; i++) {
          const d = new Date(today)
          d.setDate(today.getDate() - (dow - i))
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
          const day = stats[key]
          if (day) {
            totalRed      += day.redCount   || 0
            totalGreen    += day.greenCount  || 0
            totalDuration += day.redDuration || 0
          }
        }
        const h = Math.floor(totalDuration / 3600000)
        const m = Math.floor((totalDuration % 3600000) / 60000)
        const durStr = h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
        dialog.showMessageBox({
          type: 'info',
          title: '本周周报',
          message: '本周 Agent 使用情况',
          detail: `思考次数：${totalRed} 次\n回复次数：${totalGreen} 次\n思考总时长：${durStr}`,
          buttons: ['好的'],
        })
      }
    },
    {
      label: '🔄 检查更新',
      click: () => checkForUpdates(true)
    },
    {
      label: 'ℹ️ 关于我',
      click: () => {
        const { dialog, shell } = require('electron')
        dialog.showMessageBox({
          type: 'info',
          title: '关于我',
          message: '张顽心',
          detail: '一个纯爱玩的产品经理，不定期更新自己的 vibe coding 产品\n\n抖音：张顽心\nGitHub：freed85-xiaozai',
          buttons: ['访问 GitHub', '关闭'],
          defaultId: 1,
        }).then(({ response }) => {
          if (response === 0) {
            shell.openExternal('https://github.com/freed85-xiaozai/Claude-Code-Traffic-Light-Prompt')
          }
        })
      }
    },
    { type: 'separator' },
    { label: '⏻ 退出', click: () => app.quit() }
  ])
}

// ─── 余量查询 IPC ─────────────────────────────────────────────
let balanceTooltipWin = null
let isTooltipOpen = false
let isBalanceVisible = true
let lastBalanceRefreshTime = Date.now()
let lastChatgptRefreshTime = Date.now()

ipcMain.handle('fetch-balance', async () => {
  return await fetchBalanceData()
})

ipcMain.on('open-balance-tooltip', (_, data) => {
  if (balanceTooltipWin && !balanceTooltipWin.isDestroyed()) {
    balanceTooltipWin.close()
    balanceTooltipWin = null
    isTooltipOpen = false
    if (tray) tray.setContextMenu(buildTrayMenu(readTheme(), readStyle()))
    return
  }

  const [mx, my] = mainWin.getPosition()
  const [mw] = mainWin.getSize()
  const tooltipW = 280, tooltipH = 222

  const { width: sw } = screen.getPrimaryDisplay().workAreaSize
  let tx = mx + mw + 4
  if (tx + tooltipW > sw) tx = mx - tooltipW - 4

  balanceTooltipWin = new BrowserWindow({
    width: tooltipW,
    height: tooltipH,
    x: tx,
    y: my,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'tooltip-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  })

  balanceTooltipWin.setAlwaysOnTop(true, 'floating')
  balanceTooltipWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  const tooltipPath = isDev
    ? path.join(__dirname, '../public/balance-tooltip.html')
    : path.join(__dirname, '../dist/balance-tooltip.html')
  balanceTooltipWin.loadFile(tooltipPath)

  balanceTooltipWin.webContents.on('did-finish-load', () => {
    if (!balanceTooltipWin || balanceTooltipWin.isDestroyed()) return
    const encoded = encodeURIComponent(JSON.stringify(data))
    const encodedCookie = encodeURIComponent(balanceConfig.request?.headers?.Cookie || '')
    balanceTooltipWin.webContents.executeJavaScript(
      `window.__balanceData = JSON.parse(decodeURIComponent("${encoded}")); window.__savedCookie = decodeURIComponent("${encodedCookie}"); if(window.__savedCookie) cookieValue = window.__savedCookie; renderBalance && renderBalance(window.__balanceData)`
    )
  })

  isTooltipOpen = true
  if (tray) tray.setContextMenu(buildTrayMenu(readTheme(), readStyle()))

  balanceTooltipWin.on('closed', () => {
    balanceTooltipWin = null
    isTooltipOpen = false
    if (tray) tray.setContextMenu(buildTrayMenu(readTheme(), readStyle()))
  })

  balanceTooltipWin.on('blur', () => {
    if (balanceTooltipWin && !balanceTooltipWin.isDestroyed()) {
      balanceTooltipWin.close()
    }
  })
})

ipcMain.handle('refresh-balance-tooltip', async () => {
  const data = await fetchBalanceData()
  lastBalanceRefreshTime = Date.now()
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('balance-update', data)
  }
  return data
})

ipcMain.on('resize-balance-tooltip', (_, height) => {
  if (balanceTooltipWin && !balanceTooltipWin.isDestroyed()) {
    balanceTooltipWin.setSize(280, height)
  }
})

ipcMain.handle('read-clipboard', () => {
  const { clipboard } = require('electron')
  return clipboard.readText()
})

ipcMain.handle('get-last-balance-refresh-time', () => {
  return lastBalanceRefreshTime
})

ipcMain.handle('get-last-chatgpt-refresh-time', () => {
  return lastChatgptRefreshTime
})

ipcMain.handle('update-balance-cookie', async (_, cookie) => {
  try {
    if (!balanceConfig.request) balanceConfig.request = {}
    if (!balanceConfig.request.headers) balanceConfig.request.headers = {}
    balanceConfig.request.headers.Cookie = cookie
    try { fs.writeFileSync(COOKIE_FILE, cookie) } catch {}
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ─── 用量显示模式 IPC ──────────────────────────────────────────────
ipcMain.handle('get-usage-mode', () => readUsageMode())

// ─── ChatGPT IPC Handlers ─────────────────────────────────────────
ipcMain.handle('fetch-chatgpt-usage', async () => {
  return await fetchChatGPTUsage()
})

ipcMain.handle('update-chatgpt-token', async (_, token) => {
  try {
    // 如果 token 为空，删除手动保存的文件，恢复使用配置文件
    if (!token || !token.trim()) {
      try { fs.unlinkSync(CHATGPT_TOKEN_FILE) } catch {}
      return { ok: true }
    }
    // 保存 token
    try { fs.writeFileSync(CHATGPT_TOKEN_FILE, token) } catch {}
    // 验证 token 是否有效
    const data = await fetchChatGPTUsage()
    if (data.isValid) {
      return { ok: true }
    } else {
      // token 无效，删除保存的文件，恢复使用 auth.json
      try { fs.unlinkSync(CHATGPT_TOKEN_FILE) } catch {}
      return { ok: false, error: data.error || 'Token 无效' }
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

let chatgptTooltipWin = null

ipcMain.handle('open-chatgpt-tooltip', async (_, data) => {
  // Toggle: 如果已打开则关闭
  if (chatgptTooltipWin && !chatgptTooltipWin.isDestroyed()) {
    chatgptTooltipWin.close()
    chatgptTooltipWin = null
    return
  }

  const { BrowserWindow: BW } = require('electron')
  const mainBounds = mainWin.getBounds()
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize

  let x = mainBounds.x + mainBounds.width + 4
  let y = mainBounds.y
  if (x + 280 > sw) x = mainBounds.x - 284

  chatgptTooltipWin = new BW({
    width: 280, height: 200,
    x, y,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'tooltip-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const chatgptTooltipPath = isDev
    ? path.join(__dirname, '../public/chatgpt-tooltip.html')
    : path.join(__dirname, '../dist/chatgpt-tooltip.html')
  chatgptTooltipWin.loadFile(chatgptTooltipPath)

  chatgptTooltipWin.webContents.on('did-finish-load', () => {
    if (!chatgptTooltipWin || chatgptTooltipWin.isDestroyed()) return
    const encoded = encodeURIComponent(JSON.stringify(data))
    const { token, isManual } = readSavedChatGPTToken()
    const encodedToken = encodeURIComponent(token)
    chatgptTooltipWin.webContents.executeJavaScript(
      `window.__chatgptData = JSON.parse(decodeURIComponent("${encoded}"));
       window.__savedToken = decodeURIComponent("${encodedToken}");
       window.__manualToken = ${isManual};
       if(window.__savedToken && window.__manualToken) tokenValue = window.__savedToken;
       renderUsage && renderUsage(window.__chatgptData)`
    )
  })

  chatgptTooltipWin.on('blur', () => {
    if (chatgptTooltipWin && !chatgptTooltipWin.isDestroyed()) {
      chatgptTooltipWin.close()
      chatgptTooltipWin = null
    }
  })
})

ipcMain.handle('refresh-chatgpt-tooltip', async () => {
  const data = await fetchChatGPTUsage()
  lastChatgptRefreshTime = Date.now()
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('chatgpt-update', data)
  }
  return data
})

ipcMain.on('resize-chatgpt-tooltip', (_, height) => {
  if (chatgptTooltipWin && !chatgptTooltipWin.isDestroyed()) {
    chatgptTooltipWin.setSize(280, height)
  }
})

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
  let redStartTime = null

  const poll = setInterval(() => {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const state = fs.readFileSync(STATE_FILE, 'utf-8').trim()
        if (state !== lastState) {
          recordStateChange(state, lastState, redStartTime)
          if (state === 'red') redStartTime = Date.now()
          else redStartTime = null
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
    if (mainWin) mainWin.setSize(mainWin.getSize()[0], h)
  })

  ipcMain.on('set-window-width', (_, w) => {
    if (mainWin) {
      const [currentWidth, currentHeight] = mainWin.getSize()
      const [x, y] = mainWin.getPosition()
      // 保持右侧位置不变
      const right = x + currentWidth
      const newX = right - w
      mainWin.setBounds({ x: newX, y, width: w, height: currentHeight })
    }
  })

  ipcMain.on('set-theme', (_, theme) => {
    lastTheme = theme
    try { fs.writeFileSync(THEME_FILE, theme) } catch {}
    if (tray) tray.setContextMenu(buildTrayMenu(theme, readStyle()))
    Menu.setApplicationMenu(buildAppMenu(theme))
  })

  ipcMain.handle('get-style', () => readStyle())

  ipcMain.on('set-style', (_, style) => {
    try { fs.writeFileSync(STYLE_FILE, style) } catch {}
    if (tray) tray.setContextMenu(buildTrayMenu(readTheme(), style))
  })

  ipcMain.handle('get-stats', () => readStats())

  ipcMain.handle('get-poll-interval', () => readPollInterval())

  // 自动刷新余量和用量
  let balanceTimer = null
  let chatgptTimer = null

  const fetchAndNotifyBalance = async () => {
    const data = await fetchBalanceData()
    lastBalanceRefreshTime = Date.now()
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('balance-update', data)
    }
  }

  const fetchAndNotifyChatGPT = async () => {
    const data = await fetchChatGPTUsage()
    lastChatgptRefreshTime = Date.now()
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('chatgpt-update', data)
    }
  }

  function restartPollTimers() {
    if (balanceTimer) clearInterval(balanceTimer)
    if (chatgptTimer) clearInterval(chatgptTimer)
    const interval = readPollInterval() * 60000
    balanceTimer = setInterval(fetchAndNotifyBalance, interval)
    chatgptTimer = setInterval(fetchAndNotifyChatGPT, interval)
  }

  // 初始启动定时器
  restartPollTimers()

  // 监听轮询间隔变化
  ipcMain.on('poll-interval-changed', () => {
    restartPollTimers()
    tray.setContextMenu(buildTrayMenu(readTheme(), readStyle()))
  })

  mainWin.on('closed', () => { clearInterval(balanceTimer); clearInterval(chatgptTimer) })
}

app.whenReady().then(() => {
  // 确保 ~/.claude 目录存在
  try { fs.mkdirSync(TMP, { recursive: true }) } catch {}

  if (process.platform !== 'win32') {
    // 杀掉旧的 Python 版，防止两个红绿灯同时出现
    require('child_process').exec("pkill -f 'traffic_light.py'")
  }

  setupAllHooks()

  try { fs.writeFileSync(PID_FILE, process.pid.toString()) } catch {}

  const theme = readTheme()
  const style = readStyle()

  // macOS 应用菜单栏
  Menu.setApplicationMenu(buildAppMenu(theme))

  // 系统托盘（右上角）
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_B64}`)
  tray = new Tray(icon)
  tray.setToolTip('Agent 红绿灯')
  tray.setContextMenu(buildTrayMenu(theme, style))

  createWindow()

  // 启动 3 秒后静默检查更新和消息
  setTimeout(checkForUpdates, 3000)
})

app.on('will-quit', () => {
  try { fs.unlinkSync(PID_FILE) } catch {}
})

app.on('window-all-closed', () => app.quit())
