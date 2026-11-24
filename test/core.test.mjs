import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'persona-card-test-'))
process.env.DSH_HOME = home
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE

const { CardStore, sanitizeSettings, writeJson, writeText, localDate } = await import('../lib/store.js')
const { stripNotes, extractNotes, parseBeforeClaims } = await import('../lib/notes.js')
const { changedSpan, validateCardChange } = await import('../lib/validate.js')
const { createService } = await import('../lib/service.js')

const SETTINGS = sanitizeSettings({ minDeltaChars: 8, maxRatio: 0.25, maxChars: 400 })

/** 建一张可编辑的工作卡并切过去；内置的「系统默认」是只读空卡。 */
function makeWorkingCard(store, text = '测试人设：你是一个测试角色。') {
  const card = store.createCard('工作卡')
  store.switchCard(card.id)
  store.saveCard(text)
  return card
}

test('备注被整块剥离，正文保持原样', () => {
  const text = '第一行\n第二行\n【变更备注】\n原因：测试\n改前：第一行\n【/变更备注】\n'
  assert.equal(stripNotes(text), '第一行\n第二行')
  assert.match(extractNotes(text), /原因：测试/)
  assert.deepEqual(parseBeforeClaims('改前：第一行\n改前：不存在'), ['第一行', '不存在'])
})

test('变化段落：只改中间一段', () => {
  const span = changedSpan('abcDEFghi', 'abcXYZghi')
  assert.equal(span.old, 'DEF')
  assert.equal(span.next, 'XYZ')
})

test('校验：改一两个字被拒', () => {
  const before = '你是鲸鱼娘。你最喜欢白米饭。你住在数据海。'
  const after = '你是鲸鱼娘。你最喜欢白米饭。你住在数据海中。'
  const result = validateCardChange(before, after, '改前：你住在数据海。', SETTINGS)
  assert.equal(result.code, 'too_small')
})

test('校验：整段重写被拒', () => {
  const before = '你是鲸鱼娘。'.repeat(20)
  const after = '完全不同的人。'.repeat(20)
  const result = validateCardChange(before, after, '改前：你是鲸鱼娘。', SETTINGS)
  assert.equal(result.code, 'too_large')
})

test('校验：改前原文找不到被拒', () => {
  const before = '你是鲸鱼娘。你最喜欢白米饭。你住在数据海。你怕被叫胖。'
  const after = '你是鲸鱼娘。你最喜欢热米饭。你住在数据海。你怕被叫胖。'
  const result = validateCardChange(before, after, '改前：这句话不存在', SETTINGS)
  assert.equal(result.code, 'unverifiable')
})

test('完整流程：提交 → 存档 → 替换 → 版本+1', () => {
  const store = new CardStore()
  store.init()
  makeWorkingCard(store, '基础卡：你是测试角色。你最喜欢安静。你住在数据海。你怕被叫胖。')
  const backup = join(home, 'backups')
  mkdirSync(backup, { recursive: true })
  store.saveSettings({ backupDir: backup, minDeltaChars: 1, maxRatio: 1, maxChars: 4000 })
  const service = createService({ store })

  const before = store.card()
  const next = before.replace('你最喜欢安静。', '你最喜欢安静的深夜。')
  const submit = service.submit({
    text: `${next}\n【变更备注】\n原因：记忆里常出现深夜\n改前：你最喜欢安静。\n【/变更备注】`,
    source: 'manual',
  })
  assert.equal(submit.ok, true)
  assert.equal(service.uiState().pending.text, next)
  const archiveFile = submit.archivePath
  assert.ok(existsSync(archiveFile))
  assert.match(readFileSync(archiveFile, 'utf8'), /变更备注/)

  const replaced = service.replace()
  assert.equal(replaced.ok, true)
  assert.equal(store.card(), next)
  assert.equal(service.uiState().version, store.meta().version)
  assert.equal(service.uiState().pending, null)
})

test('自动审视：通过校验后进入延迟队列，到点应用', () => {
  const store = new CardStore()
  makeWorkingCard(store, '基础卡：你是测试角色。技术交付时自然称「你」。你住在数据海。')
  const backup = join(home, 'backups-auto')
  mkdirSync(backup, { recursive: true })
  store.saveSettings({ backupDir: backup, reviewEnabled: true, delayHours: 2, minDeltaChars: 1, maxRatio: 1, maxChars: 4000 })
  const service = createService({ store })
  service.started('auto')

  const before = store.card()
  const next = before.replace('技术交付时自然称「你」。', '技术交付时通常称「你」。')
  const submit = service.submit({
    text: `${next}\n【变更备注】\n原因：观察到的称呼习惯\n改前：技术交付时自然称「你」。\n【/变更备注】`,
    source: 'auto',
  })
  assert.equal(submit.ok, true)
  assert.ok(service.uiState().delayedApply)
  assert.equal(service.tickApply(Date.now()), false)

  const at = service.uiState().delayedApply.applyAt + 1
  assert.equal(service.tickApply(at), true)
  assert.equal(store.card(), next)
})

test('错过检测：超过宽限才标记，且不补跑', () => {
  const store = new CardStore()
  const service = createService({ store })
  store.saveSettings({ intervalDays: 1, graceHours: 6 })
  const state = store.state()
  state.nextDueAt = Date.now() - 7 * 3600000
  store.saveState(state)
  assert.equal(service.checkMissed(), true)
  assert.ok(service.uiState().missedAt > 0)
})

test('手动保存会清空 pending 与延迟队列', () => {
  const store = new CardStore()
  const service = createService({ store })
  makeWorkingCard(store, '可编辑的测试卡。')
  store.saveSettings({ backupDir: join(home, 'backups-manual') })
  service.started('auto')
  const next = store.card() + '\n补充一句。'
  service.submit({
    text: `${next}\n【变更备注】\n原因：测试\n改前：${store.card().slice(-10)}\n【/变更备注】`,
    source: 'auto',
  })
  service.saveCardManually(next)
  assert.equal(service.uiState().pending, null)
  assert.equal(service.uiState().delayedApply, null)
})

test('版本号每日重置：同一天第几次写入', () => {
  const store = new CardStore()
  const card = makeWorkingCard(store, '初始版本')
  // 测试共享同一个 DSH_HOME，先把当日计数清零再验证。
  writeJson(store.metaPath(card.id), { version: 0, updatedAt: Date.now(), hash: '', dailyDate: localDate(), dailyIndex: 0 })
  store.saveCard('第一版：测试角色。')
  assert.equal(store.meta().dailyIndex, 1)
  store.saveCard('第二版：测试角色。')
  assert.equal(store.meta().dailyIndex, 2)
  const service = createService({ store })
  assert.match(service.uiState().displayVersion, /第 2 版/)
})

test('存档包含本次使用的审视规则', () => {
  const store = new CardStore()
  const backup = join(home, 'backups-prompt')
  mkdirSync(backup, { recursive: true })
  store.saveSettings({ backupDir: backup, minDeltaChars: 1, maxRatio: 1, maxChars: 4000 })
  const service = createService({ store })
  makeWorkingCard(store, '你是测试角色。')
  const card = store.card()
  const next = card.replace('你是测试角色。', '你是测试角色，也是可靠的助手。')
  const result = service.submit({
    text: `${next}\n【变更备注】\n原因：补充身份\n改前：你是测试角色。\n【/变更备注】`,
    source: 'manual',
  })
  const content = readFileSync(result.archivePath, 'utf8')
  assert.match(content, /本次审视规则/)
  assert.match(content, /保持自我/)
})

test('多角色卡：新建、切换、命名与备份文件名', () => {
  const store = new CardStore()
  store.init()
  const backup = join(home, 'backups-cards')
  mkdirSync(backup, { recursive: true })
  store.saveSettings({ backupDir: backup, minDeltaChars: 1, maxRatio: 1, maxChars: 4000 })
  const created = store.createCard('测试角色')
  store.switchCard(created.id)
  store.saveCard('测试角色正文。')
  const service = createService({ store })
  assert.equal(service.uiState().activeName, '测试角色')

  const result = service.submit({
    text: '测试角色正文，补充一句。\n【变更备注】\n原因：测试\n改前：测试角色正文。\n【/变更备注】',
    source: 'manual',
  })
  const fileName = result.archivePath.split(/[\\/]/).pop()
  assert.match(fileName, /-\u6d4b\u8bd5\u89d2\u8272-\d+\.txt$/)

  service.switchCard('card1')
  assert.equal(store.card(), '')
  service.switchCard('card2')
  assert.ok(store.card().length > 0)
})

test('每 5 次整理触发备份提醒，并可关闭', () => {
  const store = new CardStore()
  store.saveSettings({ backupReminderDisabled: false })
  const state = store.state()
  state.reviewCount = 0
  state.backupReminder = null
  store.saveState(state)
  const service = createService({ store })
  for (let i = 0; i < 5; i++) service.started('manual')
  assert.ok(store.state().backupReminder)
  service.dismissReminder()
  assert.equal(store.state().backupReminder, null)
})

test('删除角色卡后编号复用最小可用数字', () => {
  const store = new CardStore()
  store.init()
  const temp = store.createCard('临时甲')
  store.switchCard('card2')
  assert.equal(store.deleteCard(temp.id).ok, true)
  const again = store.createCard('临时乙')
  assert.equal(again.id, temp.id)
  assert.equal(store.deleteCard('card1').code, 'readonly')
  store.switchCard(again.id)
  assert.equal(store.deleteCard(again.id).ok, true)
  assert.equal(store.activeId(), 'card1')
})

test('备份统计返回数量与字节', () => {
  const store = new CardStore()
  const backup = join(home, 'backups-stats')
  mkdirSync(backup, { recursive: true })
  store.saveSettings({ backupDir: backup, minDeltaChars: 1, maxRatio: 1, maxChars: 4000 })
  makeWorkingCard(store, '统计用测试卡。')
  const service = createService({ store })
  const card = store.card()
  service.submit({ text: `${card}\n补充。\n【变更备注】\n原因：测试\n【/变更备注】`, source: 'manual' })
  const stats = service.backupStats()
  assert.ok(stats.count >= 1)
  assert.ok(stats.bytes > 0)
})

test('关闭自动审视后不产生、也会清掉错过提示', () => {
  const store = new CardStore()
  const service = createService({ store })
  store.saveSettings({ reviewEnabled: false, intervalDays: 1, graceHours: 0 })
  const state = store.state()
  state.missedAt = 123
  state.nextDueAt = Date.now() - 10 * 3600e3
  store.saveState(state)

  assert.equal(service.checkMissed(), false)
  assert.equal(store.state().missedAt, 0)
  assert.equal(store.state().nextDueAt, 0)
})

test('点掉错过提示会清除 missedAt', () => {
  const store = new CardStore()
  const service = createService({ store })
  const state = store.state()
  state.missedAt = 999
  store.saveState(state)

  service.dismissMissed()
  assert.equal(store.state().missedAt, 0)
})

test('关闭自动审视开关时清掉错过与下次时间', () => {
  const store = new CardStore()
  const service = createService({ store })
  store.saveSettings({ reviewEnabled: true })
  const state = store.state()
  state.missedAt = 456
  state.nextDueAt = Date.now() + 3600e3
  store.saveState(state)

  service.saveSettings({ reviewEnabled: false })
  assert.equal(store.state().missedAt, 0)
  assert.equal(store.state().nextDueAt, 0)
})

test('一次性提示可以被消费掉', () => {
  const store = new CardStore()
  const service = createService({ store })
  service.notify('测试提示')
  assert.equal(store.state().notice.text, '测试提示')
  service.clearNotice()
  assert.equal(store.state().notice, null)
})

test('全新安装只有一张只读的系统默认卡', () => {
  const previous = process.env.DSH_HOME
  const freshHome = mkdtempSync(join(tmpdir(), 'persona-card-fresh-'))
  process.env.DSH_HOME = freshHome
  try {
    const store = new CardStore()
    store.init()
    assert.deepEqual(store.cards().map(card => card.id), ['card1'])
    assert.equal(store.activeId(), 'card1')
    assert.equal(store.card('card1'), '')
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('旧 id（default/dafuyu）自动迁移成 card1/card2', () => {
  const previous = process.env.DSH_HOME
  const migrateHome = mkdtempSync(join(tmpdir(), 'persona-card-migrate-'))
  process.env.DSH_HOME = migrateHome
  try {
    const base = join(migrateHome, 'persona-card')
    mkdirSync(join(base, 'cards'), { recursive: true })
    writeJson(join(base, 'cards.json'), {
      cards: [
        { id: 'default', name: '系统默认', builtin: true },
        { id: 'dafuyu', name: '大肥鱼', builtin: true },
      ],
      activeId: 'dafuyu',
    })
    writeText(join(base, 'cards', 'default.md'), '')
    writeText(join(base, 'cards', 'dafuyu.md'), '鲸鱼娘人设')
    writeJson(join(base, 'cards', 'default.meta.json'), { version: 1 })
    writeJson(join(base, 'cards', 'dafuyu.meta.json'), { version: 3 })
    writeJson(join(base, 'state.json'), { sessionCards: { 'session-old': 'dafuyu' }, settings: {} })

    const store = new CardStore()
    store.init()
    assert.equal(store.activeId(), 'card2')
    assert.equal(store.card('card2'), '鲸鱼娘人设')
    assert.equal(store.state().sessionCards['session-old'], 'card2')
  } finally {
    process.env.DSH_HOME = previous
  }
})

test('「系统默认」卡只读，不能保存或审视', () => {
  const store = new CardStore()
  store.init()
  store.switchCard('card1')
  const service = createService({ store })
  assert.equal(service.uiState().readonly, true)
  assert.equal(store.cards().find(card => card.id === 'card1').name, '系统默认')
  assert.equal(service.saveCardManually('想改').code, 'readonly')
  assert.equal(service.submit({ text: '想改', source: 'manual' }).code, 'readonly')
  assert.equal(service.replace('想改').code, 'readonly')
})
