/**
 * 客户端使用的 HTTP 接口。挂在 DSH 自己的 webServer 上，同源即可访问。
 */
const PREFIX = '/persona-card'

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

/** 备用方案：用 Windows 原生文件夹对话框选目录。 */
function nativePick() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null)
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }',
    ].join(' ')
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true })
    } catch { return resolve(null) }
    let out = ''
    child.stdout?.on('data', chunk => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(out.trim() || null))
  })
}

function openFolder(dir) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  try {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function send(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid_json')) }
    })
    req.on('error', reject)
  })
}

export function registerRoutes({ ctx, service, injector, log = () => {} }) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname
      const method = req.method ?? 'GET'

      // DSH 的 Host/Origin 校验：拒绝 DNS rebinding、跨站请求与未登录的调用。
      const rejection = ctx.connection?.requestRejection?.(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }

      // 本地 HTTP 也不接受跨站写入：自定义头无法被跨域简单请求伪造。
      if (method === 'POST' && req.headers?.['x-persona-card'] !== '1') {
        return send(res, 403, { ok: false, error: 'forbidden' })
      }

      if (method === 'GET' && (path === '/api/state' || path === '/api/state/')) {
        return send(res, 200, service.uiState())
      }
      if (method === 'GET' && path === '/api/prompt') {
        return send(res, 200, { prompt: service.prompt(), due: service.isDue() })
      }
      if (method === 'GET' && path === '/api/backups') {
        return send(res, 200, { backups: service.backups(), stats: service.backupStats() })
      }
      if (method === 'GET' && path === '/api/session-state') {
        return send(res, 200, service.sessionState(url.searchParams.get('sessionId') ?? ''))
      }

      const body = method === 'POST' ? await readBody(req) : {}

      if (method === 'POST' && path === '/api/pick-folder') {
        let picked = null
        try {
          const controller = ctx.get('workspaceController')
          const picker = controller?.directoryPicker
          if (picker && typeof picker.pick === 'function') {
            const value = await picker.pick({})
            if (typeof value === 'string' && value.trim()) picked = value.trim()
          }
        } catch (error) {
          log(`persona-card: 目录选择器失败 ${String(error?.message ?? error)}`)
        }
        if (!picked) picked = await nativePick()
        return send(res, 200, { ok: Boolean(picked), path: picked })
      }
      if (method === 'POST' && path === '/api/open-folder') {
        const dir = service.backupDirPath()
        return send(res, 200, { ok: openFolder(dir), path: dir })
      }

      if (method === 'POST' && path === '/api/settings') {
        const settings = service.saveSettings(body.settings ?? body)
        return send(res, 200, { ok: true, settings })
      }
      if (method === 'POST' && path === '/api/cards/create') {
        return send(res, 200, service.createCard(body.name))
      }
      if (method === 'POST' && path === '/api/cards/switch') {
        return send(res, 200, service.switchCard(body.id))
      }
      if (method === 'POST' && path === '/api/cards/delete') {
        return send(res, 200, service.deleteCard(body.id))
      }
      if (method === 'POST' && path === '/api/cards/rename') {
        return send(res, 200, service.renameCard(body.id, body.name))
      }
      if (method === 'POST' && path === '/api/reminder-dismiss') {
        return send(res, 200, service.dismissReminder())
      }
      if (method === 'POST' && path === '/api/missed-dismiss') {
        return send(res, 200, service.dismissMissed())
      }
      if (method === 'POST' && path === '/api/notice') {
        return send(res, 200, service.notify(body.text))
      }
      if (method === 'POST' && path === '/api/notice-clear') {
        return send(res, 200, service.clearNotice())
      }
      if (method === 'POST' && path === '/api/gate-ping') {
        return send(res, 200, service.recordGate(body.sessionId))
      }
      if (method === 'POST' && path === '/api/session-apply') {
        return send(res, 200, { ok: injector.applySession(String(body.sessionId ?? '')) })
      }
      if (method === 'POST' && path === '/api/card') {
        const result = service.saveCardManually(body.text)
        return send(res, 200, result)
      }
      if (method === 'POST' && path === '/api/replace') {
        const result = service.replace(body.text, body.note)
        return send(res, 200, result)
      }
      if (method === 'POST' && path === '/api/clear') {
        return send(res, 200, service.clearPending())
      }
      if (method === 'POST' && path === '/api/cancel-delayed') {
        return send(res, 200, service.cancelDelayed())
      }
      if (method === 'POST' && path === '/api/apply-now') {
        const result = service.applyNow()
        return send(res, 200, result)
      }
      if (method === 'POST' && path === '/api/review-started') {
        return send(res, 200, { ok: true, ...service.started(body.mode ?? 'manual') })
      }
      if (method === 'POST' && path === '/api/restore') {
        const result = service.restore(body.name)
        return send(res, 200, result)
      }
      if (method === 'POST' && path === '/api/submit') {
        const result = service.submit({ text: body.text, notes: body.notes, source: body.source ?? 'manual' })
        injector.refresh()
        return send(res, 200, result)
      }

      send(res, 404, { ok: false, error: 'not_found' })
    } catch (error) {
      log(`persona-card: 路由失败 ${String(error?.message ?? error)}`)
      if (!res.headersSent) send(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }))
}
