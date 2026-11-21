/**
 * Client 冒烟测试：在假 window / 假 React 下执行 factory 与 apply，
 * 确认三个 slot 都注册、组件函数可调用而不抛错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
}

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: definition => { captured = definition },
  },
}

const fn = new Function('window', 'module', 'exports', 'require', source)
fn(globalThis.window, { exports: {} }, {}, name => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require: ${name}`)
})

test('client bundle 注册了三个 slot 条目', () => {
  assert.ok(captured, '没有捕获到 ModuleLoader.load')
  assert.equal(captured.id, 'dsh-persona-self-review')
  const module = captured.factory(name => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require: ${name}`)
  })
  assert.equal(module.name, 'persona-self-review')

  const registrations = []
  const ctx = {
    slots: {
      inject: (_owner, callback) => callback(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    get: () => undefined,
  }
  module.apply(ctx)

  const names = registrations.map(entry => entry.options.name).sort()
  assert.deepEqual(names, ['conversation.session.header.actions', 'main', 'shell.overlay', 'shell.overlay', 'sidebar.panellist'])
  assert.equal(registrations.find(entry => entry.options.name === 'main').options.key, 'persona-card')
  for (const entry of registrations) assert.equal(typeof entry.component, 'function')
})
