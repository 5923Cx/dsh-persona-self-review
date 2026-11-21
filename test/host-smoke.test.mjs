/**
 * Host 冒烟测试：用一个假的 ctx 跑 apply，验证工具、路由、注入、定时器都能挂上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'persona-card-host-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')
const { writeJson, writeText } = await import('../lib/store.js')

function makeCtx() {
  const tools = new Map()
  const routes = []
  const handlers = new Map()
  const services = { agents: { list: () => [] } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    get(name) { return services[name] },
    tools: {
      register(definition) {
        if (!definition.output || !definition.output.schema || typeof definition.output.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render, presentationMeta? }`)
        }
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: { register(options) { routes.push(options); return () => {} } },
  }
  return { ctx, tools, routes, handlers, services }
}

test('apply 注册三个工具和一条前缀路由', () => {
  const { ctx, tools, routes } = makeCtx()
  apply(ctx, {})
  assert.deepEqual([...tools.keys()].sort(), ['persona_cards', 'persona_read', 'persona_replace', 'persona_submit_proposal', 'persona_switch'])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/persona-card')
})

test('agent/created 注入 persona section，且跳过子代理', () => {
  // 内置只有一张只读空卡；先准备一张有内容的卡再激活它。
  const base = join(home, 'persona-card')
  mkdirSync(join(base, 'cards'), { recursive: true })
  writeJson(join(base, 'cards.json'), {
    cards: [
      { id: 'card1', name: '系统默认', builtin: true },
      { id: 'card2', name: '测试卡', builtin: false },
    ],
    activeId: 'card2',
  })
  writeText(join(base, 'cards', 'card1.md'), '')
  writeText(join(base, 'cards', 'card2.md'), '这是一张测试人设卡。')

  const { ctx, handlers } = makeCtx()
  apply(ctx, {})

  const sections = []
  const systemPrompt = {
    getSectionOrder: key => (key === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : 100),
    section(options) { sections.push(options); return () => {} },
  }
  const agent = { id: 'session-1', session: { header: { origin: 'user' } }, ctx: { get: () => systemPrompt } }
  handlers.get('agent/created')({ agent })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'deployment:persona-prefix')
  assert.equal(typeof sections[0].text, 'string')
  assert.match(sections[0].text, /测试人设/)

  const sub = { id: 'sub-1', session: { header: { origin: 'subagent' } }, ctx: { get: () => systemPrompt } }
  handlers.get('agent/created')({ agent: sub })
  assert.equal(sections.length, 1)
})

test('POST 缺少自定义头时拒绝（防跨站写入）', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, {})
  const handler = routes[0].handler
  const result = await new Promise(resolve => {
    const req = { method: 'POST', url: '/persona-card/api/card', headers: {}, on() {} }
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text || '{}') }) },
    }
    handler(req, res)
  })
  assert.equal(result.status, 403)
  assert.equal(result.body.error, 'forbidden')
})

test('HTTP 路由：state / settings / clear', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, {})
  const handler = routes[0].handler

  const call = (method, path, body) => new Promise(resolve => {
    const req = {
      method, url: `/persona-card${path}`,
      headers: { 'x-persona-card': '1' },
      on(event, fn) {
        if (event === 'data') { if (body) fn(Buffer.from(JSON.stringify(body))) }
        if (event === 'end') fn()
      },
    }
    const chunks = []
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader() {},
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text || '{}') }) },
    }
    handler(req, res)
  })

  const state = await call('GET', '/api/state')
  assert.equal(state.status, 200)
  assert.ok(typeof state.body.card === 'string')
  assert.equal(state.body.version, 1)

  const saved = await call('POST', '/api/settings', { settings: { intervalDays: 2 } })
  assert.equal(saved.body.ok, true)
  assert.equal(saved.body.settings.intervalDays, 2)

  const cleared = await call('POST', '/api/clear')
  assert.equal(cleared.body.ok, true)

  const missing = await call('GET', '/api/nope')
  assert.equal(missing.status, 404)
})
