/**
 * 磁盘状态：多张角色卡、每卡版本、运行时状态、备份存档。
 *
 * 目录：
 *   $DSH_HOME/persona-card/cards.json     卡片索引（id、名称、当前激活）
 *   $DSH_HOME/persona-card/cards/<id>.md  卡片正文
 *   $DSH_HOME/persona-card/cards/<id>.meta.json  该卡的版本与当日计数
 *   $DSH_HOME/persona-card/state.json     设置、暂存、调度
 *   <备份目录>/<日期>-<角色名>-<当日序号>.txt
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
const DEFAULTS = {
  reviewEnabled: false,
  intervalDays: 1,
  delayHours: 3,
  backupDir: '',
  reviewPrompt: '',
  minDeltaChars: 8,
  maxRatio: 0.25,
  maxChars: 400,
  graceHours: 6,
  dailyVersionReset: true,
  backupReminderDisabled: false,
  autoInjectNewVersion: false,
  autoInjectOnSwitch: false,
  onlyNewSessions: true,
}

export const DEFAULT_SETTINGS = DEFAULTS

export function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function dataDir() {
  return join(dshHome(), 'persona-card')
}

export function readText(file) {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

export function readJson(file, fallback) {
  const text = readText(file)
  if (text === null) return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

export function writeJson(file, value) {
  writeText(file, JSON.stringify(value, null, 2))
}

export function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function localDate(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 文件名安全化：去掉 Windows 不允许的字符。 */
export function safeName(name, fallback = 'card') {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40)
  return cleaned || fallback
}

export function defaultState() {
  return {
    settings: { ...DEFAULTS },
    lastReviewAt: 0,
    nextDueAt: 0,
    missedAt: 0,
    reviewMode: '',
    reviewStartedAt: 0,
    reviewCount: 0,
    backupReminder: null,
    pending: null,
    delayedApply: null,
    lastApplied: null,
    lastError: null,
  }
}

export class CardStore {
  constructor() {
    this.dir = dataDir()
    this.cardsDir = join(this.dir, 'cards')
    this.indexPath = join(this.dir, 'cards.json')
    this.statePath = join(this.dir, 'state.json')
    this.legacyCardPath = join(this.dir, 'card.md')
    this.legacyMetaPath = join(this.dir, 'meta.json')
  }

  init() {
    mkdirSync(this.cardsDir, { recursive: true })
    if (!existsSync(this.indexPath)) this.migrate()
    this.migrateIds()
    this.repairSessionCards()
    this.ensureBuiltin('card1', '系统默认', '')
    if (!existsSync(this.statePath)) writeJson(this.statePath, defaultState())
    const index = this.index()
    if (!index.cards.some(card => card.id === index.activeId)) this.saveIndex({ ...index, activeId: 'card1' })
    // 系统默认卡永远为空；若迁移前它带着内容，先留一份副本再从卡里移除。
    const systemId = this.systemCardId()
    const systemText = this.card(systemId)
    if (systemText.trim()) {
      writeText(join(this.dir, 'system-default-legacy.md'), systemText)
      writeText(this.cardPath(systemId), '')
    }
    const systemDefault = index.cards.find(card => card.id === systemId)
    if (systemDefault && systemDefault.name !== '系统默认') {
      systemDefault.name = '系统默认'
      this.saveIndex(index)
    }
  }

  /** 旧版单卡迁移：card.md/meta.json 里的内容保留为用户自己的 card2。 */
  migrate() {
    const oldCard = readText(this.legacyCardPath)
    const oldMeta = readJson(this.legacyMetaPath, null)
    const hasLegacy = Boolean(oldCard && oldCard.trim())
    const cards = [{ id: 'card1', name: '系统默认', builtin: true, createdAt: Date.now() }]
    if (hasLegacy) cards.push({ id: 'card2', name: '我的角色卡', builtin: false, createdAt: Date.now() })
    this.saveIndex({ cards, activeId: hasLegacy ? 'card2' : 'card1' })
    writeText(this.cardPath('card1'), '')
    if (hasLegacy) {
      writeText(this.cardPath('card2'), oldCard)
      if (oldMeta && Number.isFinite(oldMeta.version)) {
        writeJson(this.metaPath('card2'), {
          version: oldMeta.version ?? 1,
          updatedAt: oldMeta.updatedAt ?? Date.now(),
          hash: oldMeta.hash ?? sha(oldCard),
          dailyDate: oldMeta.dailyDate ?? localDate(),
          dailyIndex: oldMeta.dailyIndex ?? 0,
        })
      }
    }
  }

  ensureBuiltin(id, name, text) {
    const path = this.cardPath(id)
    if (!existsSync(path)) writeText(path, text ?? '')
    const metaPath = this.metaPath(id)
    if (!existsSync(metaPath)) writeJson(metaPath, { version: 1, updatedAt: Date.now(), hash: sha(text ?? ''), dailyDate: localDate(), dailyIndex: 1 })
  }

  cardPath(id) { return join(this.cardsDir, `${id}.md`) }
  metaPath(id) { return join(this.cardsDir, `${id}.meta.json`) }

  index() {
    return readJson(this.indexPath, { cards: [], activeId: 'card1' })
  }

  saveIndex(index) {
    writeJson(this.indexPath, index)
  }

  cards() {
    return this.index().cards ?? []
  }

  activeId() {
    const index = this.index()
    const id = index.activeId && index.cards?.some(card => card.id === index.activeId) ? index.activeId : 'card1'
    return id
  }

  activeName() {
    const id = this.activeId()
    return this.cards().find(card => card.id === id)?.name ?? '默认'
  }

  card(id = this.activeId()) {
    return readText(this.cardPath(id)) ?? ''
  }

  meta(id = this.activeId()) {
    return readJson(this.metaPath(id), { version: 1, updatedAt: 0, hash: '', dailyDate: localDate(), dailyIndex: 0 })
  }

  state() {
    const state = readJson(this.statePath, defaultState())
    return { ...defaultState(), ...state, settings: { ...DEFAULTS, ...(state.settings ?? {}) } }
  }

  saveState(state) {
    writeJson(this.statePath, state)
  }

  settings() {
    return this.state().settings
  }

  saveSettings(patch) {
    const state = this.state()
    const settings = { ...state.settings }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULTS)) continue
      settings[key] = value
    }
    state.settings = sanitizeSettings(settings)
    this.saveState(state)
    return state.settings
  }

  /** 写当前（或指定）卡并返回新版本号；维护「每日第几个」。 */
  saveCard(text, id = this.activeId()) {
    const meta = this.meta(id)
    const version = meta.version + 1
    const today = localDate()
    const dailyIndex = meta.dailyDate === today ? (meta.dailyIndex ?? 0) + 1 : 1
    writeText(this.cardPath(id), text)
    writeJson(this.metaPath(id), { version, updatedAt: Date.now(), hash: sha(text), dailyDate: today, dailyIndex })
    return version
  }

  /** 卡片编号：card1、card2……新卡取当前最大编号 +1。 */
  nextCardId() {
    return `card${this.nextCardNumber()}`
  }

  nextCardNumber() {
    const used = new Set()
    for (const card of this.cards()) {
      const match = String(card.id).match(/^card(\d+)$/)
      if (match) used.add(Number(match[1]))
    }
    let n = 1
    while (used.has(n)) n++
    return n
  }

  /** 删除一张卡（系统默认不可删，当前激活卡需先切走）。 */
  deleteCard(id) {
    if (id === this.systemCardId()) return { ok: false, code: 'readonly' }
    const index = this.index()
    const card = index.cards?.find(entry => entry.id === id)
    if (!card) return { ok: false, code: 'not_found' }
    // 删除的是当前卡时，先切回系统默认再删，避免“激活卡不能删”的死角。
    if (index.activeId === id) index.activeId = this.systemCardId()

    index.cards = index.cards.filter(entry => entry.id !== id)
    this.saveIndex(index)
    try { unlinkSync(this.cardPath(id)) } catch { /* ignore */ }
    try { unlinkSync(this.metaPath(id)) } catch { /* ignore */ }

    const state = this.state()
    for (const [sid, cid] of Object.entries(state.sessionCards ?? {})) {
      if (cid === id) { delete state.sessionCards[sid]; delete state.sessionVersions?.[sid] }
    }
    this.saveState(state)
    return { ok: true }
  }

  /** 把旧的 id（default / dafuyu / card-xxxx）统一改成 cardN，并同步会话记录。 */
  migrateIds() {
    const index = this.index()
    const cards = index.cards ?? []
    if (cards.length > 0 && cards.every(card => /^card\d+$/.test(String(card.id)))) return

    const order = ['default', 'dafuyu']
    const sorted = [...cards].sort((a, b) => {
      const ai = order.indexOf(a.id)
      const bi = order.indexOf(b.id)
      if (ai >= 0 && bi >= 0) return ai - bi
      if (ai >= 0) return -1
      if (bi >= 0) return 1
      return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    })
    const map = {}
    sorted.forEach((card, i) => { map[card.id] = `card${i + 1}` })

    const state = this.state()
    const sessionCards = {}
    for (const [sid, cid] of Object.entries(state.sessionCards ?? {})) sessionCards[sid] = map[cid] ?? cid
    state.sessionCards = sessionCards
    this.saveState(state)

    for (const card of sorted) {
      const oldId = card.id
      const newId = map[oldId]
      if (oldId === newId) continue
      const text = this.card(oldId)
      const meta = this.meta(oldId)
      writeText(this.cardPath(newId), text)
      writeJson(this.metaPath(newId), meta)
      try { unlinkSync(this.cardPath(oldId)) } catch { /* ignore */ }
      try { unlinkSync(this.metaPath(oldId)) } catch { /* ignore */ }
      card.id = newId
    }
    this.saveIndex({ cards: sorted, activeId: map[index.activeId] ?? sorted[0]?.id ?? 'card1' })
  }

  /** 清理会话记录里失效的卡编号（迁移中断、手改文件等）。 */
  repairSessionCards() {
    const ids = new Set(this.cards().map(card => card.id))
    const alias = { default: 'card1', dafuyu: 'card2' }
    const state = this.state()
    let changed = false
    const next = {}
    for (const [sid, cid] of Object.entries(state.sessionCards ?? {})) {
      const candidate = ids.has(cid) ? cid : alias[cid]
      if (candidate && ids.has(candidate)) next[sid] = candidate
      if (next[sid] !== cid) changed = true
    }
    if (changed) {
      state.sessionCards = next
      this.saveState(state)
    }
  }

  /** 系统默认卡的 id（按名字找，避免写死）。 */
  systemCardId() {
    return this.cards().find(card => card.name === '系统默认')?.id ?? 'card1'
  }

  createCard(name) {
    const index = this.index()
    const id = this.nextCardId()
    const card = { id, name: safeName(name, '新角色'), builtin: false, createdAt: Date.now() }
    index.cards = [...(index.cards ?? []), card]
    this.saveIndex(index)
    writeText(this.cardPath(id), '')
    writeJson(this.metaPath(id), { version: 1, updatedAt: Date.now(), hash: '', dailyDate: localDate(), dailyIndex: 0 })
    return card
  }

  switchCard(id) {
    const index = this.index()
    if (!index.cards?.some(card => card.id === id)) return false
    this.saveIndex({ ...index, activeId: id })
    return true
  }

  renameCard(id, name) {
    const index = this.index()
    const card = index.cards?.find(entry => entry.id === id)
    if (!card) return false
    card.name = safeName(name, card.name)
    this.saveIndex(index)
    return true
  }
}

export function sanitizeSettings(input) {
  const number = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    reviewEnabled: input.reviewEnabled === true,
    dailyVersionReset: input.dailyVersionReset !== false,
    backupReminderDisabled: input.backupReminderDisabled === true,
    autoInjectNewVersion: input.autoInjectNewVersion === true,
    autoInjectOnSwitch: input.autoInjectOnSwitch === true,
    onlyNewSessions: input.onlyNewSessions !== false,
    intervalDays: number(input.intervalDays, 1, 0.25, 365),
    delayHours: number(input.delayHours, 3, 2, 4),
    backupDir: typeof input.backupDir === 'string' ? input.backupDir.trim().slice(0, 500) : '',
    reviewPrompt: typeof input.reviewPrompt === 'string' ? input.reviewPrompt.slice(0, 20000) : '',
    minDeltaChars: number(input.minDeltaChars, 8, 1, 200),
    maxRatio: number(input.maxRatio, 0.25, 0.01, 1),
    maxChars: number(input.maxChars, 400, 20, 20000),
    graceHours: number(input.graceHours, 6, 0, 240),
  }
}

export const BACKUP_FOLDER = 'dsh角色卡备份'

/** 备份目录：用户设置 → ~/Documents/dsh角色卡备份 → 插件数据目录。 */
export function backupDir(settings) {
  const configured = settings?.backupDir?.trim()
  if (configured) return configured
  const target = join(homedir(), 'Documents', BACKUP_FOLDER)
  try {
    mkdirSync(target, { recursive: true })
    return target
  } catch {
    return join(dataDir(), 'backups')
  }
}

/**
 * 存档一次生成结果（无论是否通过校验、是否被应用）。
 * 文件名：<日期>-<角色名>-<当日序号>.txt。
 */
export function archive({ settings, text, notes, validation, source, version, prompt, cardName }) {
  const dir = backupDir(settings)
  mkdirSync(dir, { recursive: true })
  const base = `${localDate()}-${safeName(cardName, 'card')}-${version}`
  let name = `${base}.txt`
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.txt`
  const file = join(dir, name)
  const header = [
    `# 角色卡：${cardName ?? '未命名'}`,
    `日期: ${new Date().toISOString()}`,
    `来源: ${source === 'auto' ? '自动审视' : '手动整理'}`,
    `校验: ${validation?.ok ? '通过' : `未通过（${validation?.code ?? 'unknown'}）`}`,
    validation?.warnings?.length ? `提示: ${validation.warnings.join(', ')}` : '',
    '',
    '## 本次审视规则',
    prompt?.trim() ? prompt.trim() : '（使用内置默认规则）',
    '',
    '## 变更备注',
    notes?.trim() ? notes.trim() : '（无）',
    '',
    '## 生成文本',
    text,
    '',
  ].filter(line => line !== undefined).join('\n')
  writeText(file, header)
  return file
}
