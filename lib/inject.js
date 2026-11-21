/**
 * 每个会话的人设注入。
 *
 * 注入的是「会话创建时的快照」：切换卡或出新版本后是否更新，由设置里的三个开关决定：
 *   autoInjectNewVersion  新版本自动注入到正在使用该卡的会话
 *   autoInjectOnSwitch    切换当前卡后，把新卡注入到所有活跃会话
 *   onlyNewSessions       只在新会话应用变化（优先级最高，开启后上面两个都不生效）
 */
import { stripNotes } from './notes.js'

export const PERSONA_SECTION = 'deployment:persona-prefix'

export function createInjector({ store, log = () => {}, listAgents = () => [] }) {
  /** @type {Map<string, { agent: any, dispose: () => void, cardId: string, version: number }>} */
  const entries = new Map()
  const stats = { attempts: 0, registered: 0, skippedSubagent: 0, missingService: 0, lastError: '' }

  function snapshot(cardId = store.activeId()) {
    const id = cardId ?? store.activeId()
    const meta = store.meta(id)
    return { cardId: id, version: meta.version, text: stripNotes(store.card(id)) }
  }

  function record(sessionId, version, cardId) {
    const state = store.state()
    state.sessionVersions = state.sessionVersions ?? {}
    state.sessionVersions[sessionId] = version
    state.sessionCards = state.sessionCards ?? {}
    if (cardId) state.sessionCards[sessionId] = cardId
    const ids = Object.keys(state.sessionVersions)
    if (ids.length > 200) {
      for (const id of ids.slice(0, ids.length - 200)) {
        delete state.sessionVersions[id]
        delete state.sessionCards[id]
      }
    }
    store.saveState(state)
  }

  function release(sessionId) {
    const entry = entries.get(sessionId)
    if (!entry) return
    entries.delete(sessionId)
    try { entry.dispose() } catch { /* ignore */ }
  }

  function register(agent, force = false, cardId = undefined) {
    if (!agent || agent.id === undefined) return
    if (agent.session?.header?.origin === 'subagent') { stats.skippedSubagent++; return }
    const sessionId = String(agent.id)
    if (!force && entries.has(sessionId)) return
    stats.attempts++
    const systemPrompt = agent.ctx?.get?.('systemPrompt')
    if (!systemPrompt || typeof systemPrompt.section !== 'function') {
      stats.missingService++
      stats.lastError = 'no_systemPrompt_service'
      return
    }

    release(sessionId)
    const snap = snapshot(cardId)
    if (!snap.text.trim()) {
      // 空卡（例如「默认」）：不注册，等于不注入任何人设。
      stats.lastError = ''
      record(sessionId, snap.version, snap.cardId)
      return
    }
    try {
      const order = typeof systemPrompt.getSectionOrder === 'function'
        ? systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
        : 0
      const dispose = systemPrompt.section({ name: PERSONA_SECTION, order, text: snap.text })
      entries.set(sessionId, { agent, dispose, cardId: snap.cardId, version: snap.version })
      stats.registered++
      stats.lastError = ''
      record(sessionId, snap.version, snap.cardId)
    } catch (error) {
      stats.lastError = String(error?.message ?? error)
      log(`persona-card: 会话 ${sessionId} 注入失败：${stats.lastError}`)
    }
  }

  /**
   * 卡片变化后的重注入。
   * @param {{ type?: 'version'|'switch', cardId?: string }} event
   */
  function refresh(event = {}) {
    const settings = store.settings()
    if (settings.onlyNewSessions) return
    if (event.type === 'switch' && settings.autoInjectOnSwitch === false) return
    if (event.type === 'version' && settings.autoInjectNewVersion === false) return

    if (event.type === 'switch') {
      for (const agent of listAgents() ?? []) register(agent, true)
      return
    }
    for (const entry of [...entries.values()]) {
      if (event.cardId && entry.cardId !== event.cardId) continue
      register(entry.agent, true)
    }
  }

  /** 按会话当初记录的卡注册，保留它的旧人设（用于打开旧会话时检测不匹配）。 */
  function registerRecorded(agent) {
    const recorded = store.state().sessionCards?.[String(agent?.id)]
    register(agent, true, recorded || undefined)
  }

  function attachExisting() {
    try {
      const state = store.state()
      for (const agent of listAgents() ?? []) {
        // 重启/重载后按会话当初记录的卡恢复，避免把所有旧会话悄悄升到当前卡。
        const recorded = state.sessionCards?.[String(agent?.id)]
        register(agent, true, recorded || undefined)
      }
    } catch { /* ignore */ }
  }

  /** 把当前卡强制注入到某一个会话（用于“立即更新人设”）。 */
  function applySession(sessionId) {
    const agent = (listAgents() ?? []).find(entry => String(entry?.id) === String(sessionId))
    if (!agent) return false
    register(agent, true)
    return true
  }

  function disposeAll() {
    for (const sessionId of [...entries.keys()]) release(sessionId)
  }

  function active() {
    return [...entries.entries()].map(([sessionId, entry]) => ({ sessionId, cardId: entry.cardId, version: entry.version }))
  }

  return {
    register, registerRecorded, release, refresh, attachExisting, disposeAll, active, applySession,
    text: () => stripNotes(store.card()),
    stats: () => ({ ...stats, injected: entries.size }),
  }
}
