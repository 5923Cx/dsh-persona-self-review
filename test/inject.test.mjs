/**
 * 注入开关的单元测试：用假 agent / 假 systemPrompt 验证三种生效范围。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'persona-card-inject-'))
process.env.DSH_HOME = home

const { CardStore } = await import('../lib/store.js')
const { createInjector } = await import('../lib/inject.js')

function makeAgent(id, sections) {
  return {
    id,
    session: { header: { origin: 'user' } },
    ctx: {
      get(name) {
        if (name !== 'systemPrompt') return undefined
        return {
          getSectionOrder: key => (key === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 100),
          section(options) {
            const entry = { ...options }
            sections.push(entry)
            return () => { entry.disposed = true }
          },
        }
      },
    },
  }
}

function setup() {
  const store = new CardStore()
  store.init()
  store.saveSettings({ onlyNewSessions: false, autoInjectNewVersion: true, autoInjectOnSwitch: true })
  const card = store.createCard('测试人设')
  store.switchCard(card.id)
  store.saveCard('测试人设 v1')
  const sections = []
  const agent = makeAgent('session-a', sections)
  const injector = createInjector({ store, listAgents: () => [agent] })
  injector.register(agent)
  return { store, sections, agent, injector, cardId: card.id }
}

test('默认开启：新版本会重新注入活跃会话', () => {
  const { store, sections, injector, cardId } = setup()
  assert.equal(sections.length, 1)
  store.saveCard('测试人设 v2')
  injector.refresh({ type: 'version', cardId })
  assert.equal(sections.length, 2)
  assert.equal(sections[1].text, '测试人设 v2')
})

test('关闭「新版本自动注入」后，版本变化不重注入', () => {
  const { store, sections, injector, cardId } = setup()
  store.saveSettings({ autoInjectNewVersion: false })
  store.saveCard('测试人设 v3')
  injector.refresh({ type: 'version', cardId })
  assert.equal(sections.length, 1)
})

test('切换卡片时默认重注入旧会话', () => {
  const { store, sections, injector } = setup()
  store.switchCard('card1')
  injector.refresh({ type: 'switch' })
  // 「系统默认」是空卡，等于移除人设
  assert.ok(sections.length >= 1)
  assert.equal(injector.active().length, 0)
})

test('「仅在新会话应用」开启后，切换与版本都不重注入', () => {
  const { store, sections, injector, cardId } = setup()
  store.saveSettings({ onlyNewSessions: true })
  store.saveCard('测试人设 v4')
  injector.refresh({ type: 'version', cardId })
  store.switchCard('card1')
  injector.refresh({ type: 'switch' })
  assert.equal(sections.length, 1)
  assert.equal(injector.active().length, 1)
})

test('重新打开旧会话时按记录的卡恢复，不会升到当前卡', () => {
  const { store, injector } = setup()
  store.switchCard('card1')

  const sections = []
  const reopened = makeAgent('session-a', sections)
  injector.registerRecorded(reopened)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].text, '测试人设 v1')
})
