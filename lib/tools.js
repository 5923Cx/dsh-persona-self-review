/**
 * 给 agent 用的三个工具：读卡、提交审视结果、直接替换。
 * 返回值统一是 { text }，与 dsh-soul 的工具形状一致。
 */
export function registerTools({ ctx, service }) {
  const disposers = []
  // 工具必须声明 output 形状：schema 描述返回值，render 把它转成文本块。
  const output = {
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
  const register = definition => {
    disposers.push(ctx.tools.register({ ...definition, output }))
  }

  register({
    name: 'persona_read',
    description: '读取当前角色卡全文、版本号与最近一次变更备注。修改人设前先调用它。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() {
      const state = service.uiState()
      return {
        text: JSON.stringify({
          version: state.version,
          card: state.card,
          lastApplied: state.lastApplied,
          pending: state.pending ? { validation: state.pending.validation, notes: state.pending.notes } : null,
        }, null, 2),
      }
    },
  })

  register({
    name: 'persona_submit_proposal',
    description: '提交一次自我审视的结果。text 是完整的新角色卡（含【变更备注】块），notes 是备注内容。校验与存档由插件完成；没有实质修改时不要调用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '完整的新角色卡正文，末尾附【变更备注】…【/变更备注】' },
        notes: { type: 'string', description: '变更备注：原因、改动、证据、改前原文' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const state = service.uiState()
      const source = state.reviewMode === 'auto' ? 'auto' : 'manual'
      const result = service.submit({ text: args.text, notes: args.notes, source })
      return { text: JSON.stringify(result, null, 2) }
    },
  })

  register({
    name: 'persona_cards',
    description: '列出所有角色卡（id、名称、是否当前激活、只读），用于切换前确认卡名。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async execute() {
      const state = service.uiState()
      return {
        text: JSON.stringify({
          activeId: state.activeId,
          activeName: state.activeName,
          cards: state.cards.map(card => ({ id: card.id, name: card.name, active: card.id === state.activeId, builtin: card.builtin === true })),
        }, null, 2),
      }
    },
  })

  register({
    name: 'persona_switch',
    description: '切换当前角色卡。参数 card 可以是卡名或 id。用户要求换角色时直接调用，不要先长篇推理。',
    parameters: {
      type: 'object',
      properties: { card: { type: 'string', description: '角色卡名称或 id' } },
      required: ['card'],
      additionalProperties: false,
    },
    async execute(args) {
      const query = String(args.card ?? '').trim().toLowerCase()
      const state = service.uiState()
      const match = state.cards.find(card => card.id.toLowerCase() === query || String(card.name).toLowerCase() === query)
        ?? state.cards.find(card => String(card.name).includes(args.card) || card.id.includes(query))
      if (!match) {
        return { text: JSON.stringify({ ok: false, code: 'not_found', available: state.cards.map(card => card.name) }) }
      }
      const result = service.switchCard(match.id)
      return { text: JSON.stringify({ ok: result.ok, activeId: result.activeId, activeName: result.activeName }) }
    },
  })

  register({
    name: 'persona_replace',
    description: '立即用给定文本替换角色卡（会剥掉备注、备份、版本号+1）。只有用户明确要求改人设时才调用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '新的角色卡正文' },
        note: { type: 'string', description: '这次修改的原因，写入存档' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const result = service.replace(args.text, args.note)
      return { text: JSON.stringify(result, null, 2) }
    },
  })

  return () => { for (const dispose of disposers.splice(0)) try { dispose() } catch { /* ignore */ } }
}
