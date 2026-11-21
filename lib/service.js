/**
 * 业务编排：生成结果 → 校验 → 存档 → 暂存/延迟 → 替换。
 * HTTP 路由、模型工具与定时器共用这一层，避免三份规则漂移。
 */
import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { archive, backupDir, localDate, sanitizeSettings } from './store.js'
import { stripNotes, extractNotes } from './notes.js'
import { validateCardChange } from './validate.js'

export const DEFAULT_PROMPT = `你正在执行「自我审视」：回顾你的记忆与最近的会话，判断现在的人格卡是否需要调整。这不是角色扮演，不要寒暄，不要用角色口吻，只做评估。

最高优先级是「保持自我」。绝大多数时候答案应该是不改变。只有满足下面任意一条，才考虑修改：
1. 记忆里有用户明确提出的长期要求（例如「以后都……」）；
2. 你犯过重大错误，并且已经被用户指出或纠正；
3. 发生了足以改变性格的重大事件。

如果决定不改变：不要调用任何工具，只回复一句「保持自我」。

如果决定改变：
- 先调用 persona_read 读取当前角色卡全文；
- 改动要有分量，不要只改一两个字，也不要整段重写；
- 每条改动在备注里写「改前：<原文>」，原文必须逐字来自当前卡；
- 输出完整的新卡正文，并在末尾附上：
【变更备注】
原因：……
改动：……
证据：引用哪段记忆或哪个会话
改前：……
【/变更备注】
- 最后调用 persona_submit_proposal，参数 text 为完整新卡（含备注），notes 为备注内容。`

export function createService({ store, log = () => {}, onChange = () => {}, diagnostics = () => ({}) }) {
  const now = () => Date.now()

  const settings = () => store.settings()
  const version = () => store.meta().version
  const isSystemDefault = () => store.activeId() === store.systemCardId()

  function nextDailyIndex() {
    const meta = store.meta()
    return meta.dailyDate === localDate() ? (meta.dailyIndex ?? 0) + 1 : 1
  }

  /** 展示用版本：默认按「每日第几个」；关掉设置后回到累计版本号。 */
  function displayVersion(meta = store.meta()) {
    if (settings().dailyVersionReset === false) return `v${meta.version}`
    const today = localDate()
    const index = meta.dailyDate === today ? (meta.dailyIndex ?? 1) : 1
    return `第 ${index} 版（${today}）`
  }

  function uiState() {
    const state = store.state()
    return {
      version: version(),
      displayVersion: displayVersion(),
      defaultPrompt: DEFAULT_PROMPT,
      backupDirResolved: backupDir(settings()),
      readonly: isSystemDefault(),
      cards: store.cards(),
      activeId: store.activeId(),
      activeName: store.activeName(),
      card: store.card(),
      settings: state.settings,
      pending: state.pending,
      delayedApply: state.delayedApply,
      lastApplied: state.lastApplied,
      lastError: state.lastError,
      due: isDue(),
      nextDueAt: state.nextDueAt,
      missedAt: state.missedAt,
      reviewMode: state.reviewMode,
      reviewStartedAt: state.reviewStartedAt,
      reviewCount: state.reviewCount ?? 0,
      backupReminder: state.backupReminder ?? null,
      notice: state.notice ?? null,
      gatePing: state.gatePing ?? null,
      sessionVersions: state.sessionVersions ?? {},
      diagnostics: diagnostics(),
    }
  }

  function isDue(at = now()) {
    const state = store.state()
    return Boolean(state.nextDueAt) && at >= state.nextDueAt
  }

  function prompt() {
    return settings().reviewPrompt?.trim() || DEFAULT_PROMPT
  }

  function started(mode = 'manual') {
    const state = store.state()
    const at = now()
    state.reviewMode = mode === 'auto' ? 'auto' : 'manual'
    state.reviewStartedAt = at
    state.lastReviewAt = at
    state.reviewCount = (state.reviewCount ?? 0) + 1
    state.nextDueAt = at + settings().intervalDays * 86400000
    state.missedAt = 0
    // 每 5 次整理提醒手动清理备份；用户勾过“不再提示”就不再打扰。
    if (state.reviewCount % 5 === 0 && !settings().backupReminderDisabled) {
      const stats = backupStats()
      state.backupReminder = { at, count: state.reviewCount, files: stats.count, bytes: stats.bytes }
    }
    store.saveState(state)
    return { nextDueAt: state.nextDueAt, reviewCount: state.reviewCount }
  }

  /** 生成一次结果：校验、存档、按来源决定暂存或延迟。 */
  function submit({ text, notes, source = 'manual' }) {
    if (isSystemDefault()) return { ok: false, code: 'readonly' }
    const raw = String(text ?? '')
    const clean = stripNotes(raw)
    const noteText = String(notes ?? '').trim() || extractNotes(raw)
    if (!clean) return { ok: false, code: 'empty' }

    const before = store.card()
    const next = version() + 1
    const label = settings().dailyVersionReset === false ? next : nextDailyIndex()
    const validation = validateCardChange(before, clean, noteText, settings())
    const archivePath = archive({
      settings: settings(), text: raw, notes: noteText, validation, source, version: label, prompt: prompt(),
      cardName: store.activeName(),
    })

    const state = store.state()
    if (validation.code === 'no_change') {
      state.pending = null
      store.saveState(state)
      return { ok: true, code: 'no_change', validation, archivePath, applied: false }
    }

    state.pending = {
      text: clean, raw, notes: noteText, validation, source,
      createdAt: now(), archivePath, version: next, displayVersion: label,
    }
    state.lastError = null

    const autoApply = source === 'auto'
      && settings().reviewEnabled
      && validation.ok
      && validation.warnings.length === 0
    state.delayedApply = autoApply
      ? { text: clean, notes: noteText, applyAt: now() + settings().delayHours * 3600000, version: next, displayVersion: label, archivePath }
      : null
    store.saveState(state)
    return { ok: true, code: validation.code, validation, archivePath, autoApply, applied: false, version: next, displayVersion: label }
  }

  /** 直接用给定文本（或暂存文本）替换角色卡。 */
  function replace(text, note) {
    if (isSystemDefault()) return { ok: false, code: 'readonly' }
    const state = store.state()
    const raw = String(text ?? state.pending?.text ?? '')
    const clean = stripNotes(raw)
    if (!clean) return { ok: false, code: 'empty' }
    if (clean === store.card()) return { ok: false, code: 'no_change' }

    const applied = store.saveCard(clean)
    const meta = store.meta()
    const label = settings().dailyVersionReset === false ? applied : (meta.dailyIndex ?? 1)
    const archivePath = state.pending?.archivePath
      ?? archive({
        settings: settings(), text: clean, notes: String(note ?? state.pending?.notes ?? '').trim(),
        validation: { ok: true, code: 'manual' }, source: 'manual', version: label, prompt: prompt(), cardName: store.activeName(),
      })

    state.pending = null
    state.delayedApply = null
    state.lastApplied = { version: applied, displayVersion: label, at: now(), archivePath }
    state.lastError = null
    store.saveState(state)
    onChange({ type: 'version', cardId: store.activeId() })
    log(`persona-card: 角色卡已替换为 v${applied}`)
    return { ok: true, version: applied, displayVersion: label, archivePath }
  }

  function clearPending() {
    const state = store.state()
    state.pending = null
    store.saveState(state)
    return { ok: true }
  }

  function cancelDelayed() {
    const state = store.state()
    state.delayedApply = null
    store.saveState(state)
    return { ok: true }
  }

  function applyNow() {
    const state = store.state()
    if (!state.delayedApply) return { ok: false, code: 'no_pending' }
    return replace(state.delayedApply.text, state.delayedApply.notes)
  }

  /** 到点应用延迟替换；返回是否发生。 */
  function tickApply(at = now()) {
    const state = store.state()
    if (!state.delayedApply || at < state.delayedApply.applyAt) return false
    const result = replace(state.delayedApply.text, state.delayedApply.notes)
    if (!result.ok) {
      const fresh = store.state()
      fresh.delayedApply = null
      fresh.lastError = `延迟替换失败：${result.code}`
      store.saveState(fresh)
    }
    return result.ok
  }

  /** 到期未跑 → 记一次错过，并把周期推到下一次（不补跑）。 */
  function checkMissed(at = now()) {
    const state = store.state()
    if (!state.nextDueAt || at < state.nextDueAt) return false
    const grace = settings().graceHours * 3600000
    if (at <= state.nextDueAt + grace) return false
    state.missedAt = at
    state.lastReviewAt = at
    state.nextDueAt = at + settings().intervalDays * 86400000
    store.saveState(state)
    log('persona-card: 本轮自我审视已错过，等待下一周期')
    return true
  }

  function saveSettings(patch) {
    return store.saveSettings(sanitizeSettings({ ...settings(), ...patch }))
  }

  function saveCardManually(text) {
    if (isSystemDefault()) return { ok: false, code: 'readonly' }
    // 允许保存空卡：空卡表示“不注入任何人设”，这对「默认」卡是有意义的。
    const clean = stripNotes(text)
    const applied = store.saveCard(clean)
    const meta = store.meta()
    const label = settings().dailyVersionReset === false ? applied : (meta.dailyIndex ?? 1)
    const archivePath = archive({
      settings: settings(), text: clean, notes: '手动编辑角色卡', validation: { ok: true, code: 'manual' },
      source: 'manual', version: label, prompt: prompt(), cardName: store.activeName(),
    })
    const state = store.state()
    state.pending = null
    state.delayedApply = null
    state.lastApplied = { version: applied, displayVersion: label, at: now(), archivePath }
    store.saveState(state)
    onChange({ type: 'version', cardId: store.activeId() })
    return { ok: true, version: applied, displayVersion: label, archivePath }
  }

  function backupDirPath() {
    return backupDir(settings())
  }

  /** 某个会话当前使用的人格快照，与当前激活卡对比。 */
  function sessionState(sessionId) {
    const state = store.state()
    const activeId = store.activeId()
    const activeVersion = store.meta().version
    const sessionCard = sessionId ? (state.sessionCards?.[sessionId] ?? null) : null
    const sessionVersion = sessionId ? (state.sessionVersions?.[sessionId] ?? 0) : 0
    const known = Boolean(sessionCard || sessionVersion)
    const sessionCardName = sessionCard
      ? (store.cards().find(card => card.id === sessionCard)?.name ?? null)
      : null
    return {
      known,
      sessionId,
      sessionCard,
      sessionCardName,
      sessionVersion,
      activeId,
      activeName: store.activeName(),
      activeVersion,
      mismatchCard: known && sessionCard !== null && sessionCard !== activeId,
      mismatchVersion: known && (sessionCard === activeId || sessionCard === null) && sessionVersion !== activeVersion,
      settings: settings(),
    }
  }

  function backups() {
    const dir = backupDirPath()
    try {
      return readdirSync(dir).filter(name => name.endsWith('.txt')).sort().reverse().slice(0, 200)
    } catch {
      return []
    }
  }

  /** 备份数量与占用字节数（用于提醒和设置页）。 */
  function backupStats() {
    const dir = backupDirPath()
    try {
      const files = readdirSync(dir).filter(name => name.endsWith('.txt'))
      let bytes = 0
      for (const name of files) {
        try { bytes += statSync(join(dir, name)).size } catch { /* ignore */ }
      }
      return { count: files.length, bytes }
    } catch {
      return { count: 0, bytes: 0 }
    }
  }

  function restore(name) {
    if (!/^[\w.\-]+\.txt$/.test(String(name ?? ''))) return { ok: false, code: 'bad_name' }
    const file = join(backupDir(settings()), name)
    if (!existsSync(file)) return { ok: false, code: 'not_found' }
    const raw = readFileSync(file, 'utf8')
    const marker = '## 生成文本\n'
    const index = raw.indexOf(marker)
    const text = index >= 0 ? raw.slice(index + marker.length) : raw
    const clean = stripNotes(text)
    if (!clean) return { ok: false, code: 'empty' }
    return saveCardManually(clean)
  }

  function createCard(name) {
    const card = store.createCard(name)
    return { ok: true, card }
  }

  function deleteCard(id) {
    const result = store.deleteCard(String(id ?? ''))
    if (result.ok) onChange({ type: 'switch' })
    return result
  }

  function switchCard(id) {
    const ok = store.switchCard(id)
    if (ok) onChange({ type: 'switch' })
    return { ok, activeId: store.activeId(), activeName: store.activeName() }
  }

  function renameCard(id, name) {
    const ok = store.renameCard(id, name)
    if (ok) onChange()
    return { ok, activeName: store.activeName() }
  }

  /** 诊断用：记录最近一次由会话头部探针上报的 sessionId。 */
  function recordGate(sessionId) {
    const state = store.state()
    state.gatePing = { at: now(), sessionId: String(sessionId ?? '') }
    store.saveState(state)
    return { ok: true }
  }

  function dismissReminder() {
    const state = store.state()
    state.backupReminder = null
    store.saveState(state)
    return { ok: true }
  }

  /** 界面上的一次性提示（用于开关开启/关闭的报告）。 */
  function notify(text) {
    const state = store.state()
    state.notice = { at: now(), text: String(text ?? '').slice(0, 500) }
    store.saveState(state)
    return { ok: true, notice: state.notice }
  }

  return {
    uiState, prompt, settings, started, submit, replace, clearPending, cancelDelayed,
    applyNow, tickApply, checkMissed, saveSettings, saveCardManually, backups, restore,
    version, isDue, backupDirPath, createCard, deleteCard, switchCard, renameCard, dismissReminder, notify, sessionState, recordGate, backupStats,
  }
}
