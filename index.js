/**
 * dsh-persona-self-review — 角色卡 · 自我审视（Host 半）。
 *
 * 职责：
 *  - 把人格存成一份可编辑的卡，按会话注入（遮蔽 preset 人设）；
 *  - 每天（可配）由客户端开一个审视会话，模型读卡、读记忆、提出小改；
 *  - 校验、存档、延迟生效、错过提醒；
 *  - 暴露 persona_read / persona_submit_proposal / persona_replace 三个工具。
 */
import { CardStore } from './lib/store.js'
import { createService } from './lib/service.js'
import { createInjector } from './lib/inject.js'
import { registerTools } from './lib/tools.js'
import { registerRoutes } from './lib/routes.js'

export const name = 'persona-self-review'
export const inject = ['webServer', 'tools', 'connection']

export function apply(ctx, config = {}) {
  const store = new CardStore()
  store.init()

  const log = (...args) => {
    try { ctx.logger?.info?.(args.join(' ')) } catch { /* ignore */ }
  }

  let injector
  const listAgents = () => {
    try { return ctx.get('agents')?.list?.() ?? [] } catch { return [] }
  }
  const service = createService({
    store,
    log,
    onChange: event => injector?.refresh(event ?? {}),
    diagnostics: () => ({
      injected: injector?.active?.().length ?? 0,
      agents: listAgents().length,
      ...(injector?.stats?.() ?? {}),
    }),
  })
  injector = createInjector({ store, log, listAgents })

  // 新会话创建时注入；插件加载时补齐已存在的会话（服务可能晚就绪，补几次）。
  ctx.effect(() => ctx.on('agent/created', payload => injector.registerRecorded(payload?.agent)))
  ctx.effect(() => {
    const timers = [300, 1500, 5000, 15000].map(delay => {
      const timer = setTimeout(() => { try { injector.attachExisting() } catch { /* ignore */ } }, delay)
      timer.unref?.()
      return timer
    })
    return () => { for (const timer of timers) clearTimeout(timer) }
  })

  // 插件卸载时释放所有会话级 section，避免重新启用时撞上「already registered」。
  ctx.effect(() => () => { try { injector.disposeAll() } catch { /* ignore */ } })

  const disposeTools = registerTools({ ctx, service })
  ctx.effect(() => disposeTools)

  // 一段很短的运行时提示：换角色卡时直接调工具，避免模型在“该怎么换”上花时间。
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.context === 'function') {
    ctx.effect(() => systemPrompt.context({
      name: 'persona-self-review:hint',
      order: 945,
      interpolate: false,
      text: ({ agent } = {}) => {
        try {
          if (agent?.session?.header?.origin === 'subagent') return ''
          const state = service.uiState()
          const names = state.cards.slice(0, 12).map(card => `${card.id}-${card.name}`).join('、')
          const more = state.cards.length > 12 ? ' 等' : ''
          return [
            `角色卡：当前「${state.activeId}-${state.activeName}」。`,
            '方法：切换用 persona_switch（卡名/id/编号-名称）；查看清单用 persona_cards；读取或修改人设用 persona_read。不要为“该怎么换”展开推理。',
            `可切换：${names}${more}。系统默认卡不可修改。`,
          ].join('\n')
        } catch { return '' }
      },
    }))
  }

  registerRoutes({ ctx, service, injector, log })

  // 定时检查：延迟替换到点应用、错过检测。也用于插件加载时补一次。
  ctx.effect(() => {
    const tick = () => {
      try {
        service.tickApply()
        service.checkMissed()
      } catch (error) {
        log(`persona-card: 定时检查失败 ${String(error?.message ?? error)}`)
      }
    }
    tick()
    const timer = setInterval(tick, 30000)
    timer.unref?.()
    return () => clearInterval(timer)
  })

  log(`persona-card: 已加载，角色卡 v${store.meta().version}`)
}
