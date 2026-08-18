/**
 * 增强版缓存断裂定位：拼接旧循环增量 → 上一轮末态完整上下文，与新循环全量重建逐消息对比。
 * 
 * 原理：日志 messages 只记录"本次调用新增段"（slice(lastLoggedMsgCount)）。
 * 新循环首跳 lastLoggedMsgCount=0 → 记录全量（125/171 条）；旧循环每次记录 2 条增量。
 * 因此：旧循环全部日志的 messages 按顺序拼接 = 上一轮 loop 末态完整 messages。
 * 将拼接结果与新循环首跳全量逐条对比，找第一个不一致点。
 */
import fs from 'fs'

const logFile = process.argv[2] || 'C:\\Users\\Hamlin\\AppData\\Roaming\\hclaw\\logs\\llm-calls.jsonl'
const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
const logs = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

console.log(`日志总数: ${logs.length}\n`)

// 找到回退点：相邻两条 cache_read 下降 > 2000
const breaks = []
for (let i = 1; i < logs.length; i++) {
  const prev = logs[i-1], cur = logs[i]
  const pCr = prev.cacheReadTokens || 0, cCr = cur.cacheReadTokens || 0
  if (pCr > 0 && cCr < pCr - 2000) breaks.push({i, prev, cur})
}

console.log(`回退点: ${breaks.length} 个\n`)

for (const {i, prev, cur} of breaks) {
  const t1 = new Date(prev.timestamp).toLocaleString('zh-CN', {hour12:false})
  const t2 = new Date(cur.timestamp).toLocaleString('zh-CN', {hour12:false})
  console.log(`════════ 回退点 #${breaks.indexOf({i,prev,cur})+1} ════════`)
  console.log(`前(${t1}) in=${prev.inputTokens} cache=${prev.cacheReadTokens} msgs=${prev.messages?.length} 增量`)
  console.log(`后(${t2}) in=${cur.inputTokens} cache=${cur.cacheReadTokens} msgs=${cur.messages?.length} 全量重建`)

  // 1) 拼接旧循环所有增量（从上一个回退点之后到 prev 之前的所有日志）
  const startIdx = breaks.length > 1 && breaks.findIndex(b => b.i === i) > 0
    ? breaks[breaks.findIndex(b => b.i === i) - 1].i : 0
  const merged = []
  const mergeSet = new Set()
  for (let j = startIdx; j <= i; j++) {
    for (const m of logs[j].messages || []) {
      const key = `${m.role}|${m.toolCallId || ''}|${(m.content||'').slice(0,50)}`
      if (!mergeSet.has(key)) { mergeSet.add(key); merged.push(m) }
    }
  }
  // 2) 新循环首跳全量
  const full = cur.messages || []

  console.log(`\n旧循环末态(拼接): ${merged.length} 条 | 新循环首跳: ${full.length} 条`)
  console.log(`systemPrompt 一致: ${prev.systemPrompt === cur.systemPrompt}\n`)

  // 3) 逐条对比，找第一个不一致
  const maxLen = Math.max(merged.length, full.length)
  let firstDiff = -1
  for (let k = 0; k < maxLen; k++) {
    const a = merged[k], b = full[k]
    if (!a || !b) { firstDiff = k; break }
    const aKey = JSON.stringify({r:a.role, c:a.content, tc:(a.toolCalls||[]).map(t=>t.id+':'+t.name), tid:a.toolCallId, tr:a.toolResult?.slice(0,80)})
    const bKey = JSON.stringify({r:b.role, c:b.content, tc:(b.toolCalls||[]).map(t=>t.id+':'+t.name), tid:b.toolCallId, tr:b.toolResult?.slice(0,80)})
    if (aKey !== bKey) { firstDiff = k; break }
  }

  if (firstDiff === -1) {
    console.log('✓ 拼接上下文与新循环首跳完全一致（长度相同、逐条相同）——断裂不在 messages')
  } else {
    console.log(`✗ 第一个不一致点: 位置 ${firstDiff}`)
    for (let k = Math.max(0, firstDiff-1); k < Math.min(maxLen, firstDiff+3); k++) {
      const a = merged[k], b = full[k]
      const fmt = (m) => {
        if (!m) return '(无)'
        const tc = (m.toolCalls||[]).map(t=>`${t.name}:${JSON.stringify(t.arguments||{}).slice(0,40)}`).join(';')
        return `[${m.role}] content=${(m.content||'').slice(0,80)} tc=${tc||'-'} tid=${m.toolCallId||'-'} tr=${(m.toolResult||'').slice(0,60)}`
      }
      const mark = k === firstDiff ? '◀◀◀' : ''
      console.log(`  ${k} 前: ${fmt(a)} ${mark}`)
      console.log(`  ${k} 后: ${fmt(b)} ${mark}`)
    }
  }
  console.log('')
}
