/**
 * 变更备注的解析与剥离。
 *
 * 模型按提示词在正文末尾附上：
 *   【变更备注】
 *   原因：…
 *   改动：…
 *   证据：…
 *   【/变更备注】
 *
 * 备注只进存档与文本框 c，绝不进角色卡；替换前整块剥掉。
 */
const NOTE_BLOCK = /【变更备注】([\s\S]*?)【\/变更备注】/g

/** 去掉所有备注块，并清理首尾空白。 */
export function stripNotes(text) {
  return String(text ?? '').replace(NOTE_BLOCK, '').replace(/[ \t]+$/gm, '').trim()
}

/** 取出第一段备注（可能为空字符串）。 */
export function extractNotes(text) {
  const source = String(text ?? '')
  const match = source.match(/【变更备注】([\s\S]*?)【\/变更备注】/)
  return match ? match[1].trim() : ''
}

/** 从备注里抽取「改前：」行，用于逐字核对。 */
export function parseBeforeClaims(notes) {
  const claims = []
  for (const line of String(notes ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*改前\s*[：:]\s*(.+)$/)
    if (match) claims.push(match[1].trim())
  }
  return claims
}

/** 把备注拆成结构化字段，便于 UI 与测试。 */
export function parseNotes(notes) {
  const fields = { reason: '', changes: '', evidence: '' }
  for (const line of String(notes ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(原因|改动|证据)\s*[：:]\s*(.+)$/)
    if (!match) continue
    if (match[1] === '原因') fields.reason = match[2].trim()
    if (match[1] === '改动') fields.changes = match[2].trim()
    if (match[1] === '证据') fields.evidence = match[2].trim()
  }
  return fields
}
