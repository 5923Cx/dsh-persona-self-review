/**
 * 硬校验：只拦两端——改一两个字的噪声，和整段重写。
 * 通过与否都不阻止用户手动替换；但只有「通过且无提示」才允许自动替换。
 */
import { parseBeforeClaims } from './notes.js'

/** 去掉公共前后缀，返回真正变化的那一段。 */
export function changedSpan(before, after) {
  const a = String(before ?? '')
  const b = String(after ?? '')
  const min = Math.min(a.length, b.length)
  let start = 0
  while (start < min && a[start] === b[start]) start++
  let end = 0
  while (end < min - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return {
    old: a.slice(start, a.length - end),
    next: b.slice(start, b.length - end),
  }
}

export function validateCardChange(oldCard, newCard, notes, settings) {
  const before = String(oldCard ?? '')
  const after = String(newCard ?? '')
  if (!after.trim()) return { ok: false, code: 'empty' }
  if (after === before) return { ok: false, code: 'no_change' }

  const span = changedSpan(before, after)
  const deltaOld = span.old.length
  const deltaNew = span.next.length
  const delta = Math.max(deltaOld, deltaNew)
  const ratio = delta / Math.max(1, before.length)
  const minDelta = Number(settings?.minDeltaChars) || 8
  const maxChars = Number(settings?.maxChars) || 400
  const maxRatio = Number(settings?.maxRatio) || 0.25

  // 先核对证据：备注里写到的「改前」必须逐字存在于旧卡，否则这次改动不可核实。
  const claims = parseBeforeClaims(notes)
  const warnings = []
  if (claims.length === 0) warnings.push('missing_before_claims')
  for (const claim of claims) {
    if (!before.includes(claim)) {
      return { ok: false, code: 'unverifiable', delta, ratio, warnings: ['before_not_found'] }
    }
  }

  if (delta < minDelta) {
    return { ok: false, code: 'too_small', delta, ratio, warnings }
  }
  if (delta > maxChars || ratio > maxRatio) {
    return { ok: false, code: 'too_large', delta, ratio, warnings }
  }

  return { ok: true, code: 'ok', delta, ratio, warnings }
}
