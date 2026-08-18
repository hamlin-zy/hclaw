/**
 * 精确对比 v2：b3768af5 首跳（05:38:48，105 条）= 运行时真实发送的完整序列
 * vs DB 重建「截至该时刻」的消息序列（不含 b3768af5 自身）
 * 
 * 时间点对齐：运行时首跳包含到「我现在开启了LLM调用日志监听」user 消息为止的全部历史
 * DB 重建：所有 timestamp < b3768af5.timestamp 的消息
 */
const fs = require('fs')
const Database = require('better-sqlite3')
const db = new Database('C:/Users/Hamlin/.hclaw/data/hclaw.db', {readonly: true})
const convId = 'conv-b70458a9-de95-404c-a85e-18b9ea9467af'

// ═══ 1. 运行时基线：llm-calls.jsonl 第一条（105 条全量）═══
const logs = fs.readFileSync('C:/Users/Hamlin/AppData/Roaming/hclaw/logs/llm-calls.jsonl','utf8')
  .split('\n').filter(Boolean).map(l=>JSON.parse(l))
const firstFull = logs.find(l => (l.messages||[]).length >= 100 && l.timestamp < 1787089140000)
if (!firstFull) { console.log('未找到运行时全量基线'); process.exit(1) }
const runtimeMsgs = firstFull.messages
console.log(`运行时基线: ${runtimeMsgs.length} 条 @ ${new Date(firstFull.timestamp).toLocaleTimeString('zh-CN',{hour12:false})}`)

// ═══ 2. DB 重建（截至 b3768af5 之前）═══
const b3768 = db.prepare("SELECT id, timestamp FROM messages WHERE id='b3768af5-519b-4993-9706-605918f52169'").get()
const msgs = db.prepare("SELECT id, role, timestamp FROM messages WHERE conversation_id = ? AND timestamp < ? ORDER BY timestamp")
  .all(convId, b3768.timestamp)
console.log(`DB 消息（截至首跳前）: ${msgs.length} 条`)

// 重建工具：turnIndex 分组
function rebuildTurnIndex(blocks) {
  const contentBlocks = [], toolById = new Map()
  for (const b of blocks) {
    const type = b.block_type
    if (type === 'think') contentBlocks.push({type:'think', thinkBlock: JSON.parse(b.data), turnIndex: b.turn_index})
    else if (type === 'text') contentBlocks.push({type:'text', text: b.content, turnIndex: b.turn_index})
    else if (type === 'tool_call') { const tc = JSON.parse(b.data); toolById.set(tc.id, tc); contentBlocks.push({type:'tool_use', toolCall: tc, turnIndex: b.turn_index}) }
    else if (type === 'tool_result') { const d = JSON.parse(b.data); const tc = toolById.get(d.id); if (tc) tc.result = d.result }
  }
  const groups = new Map(); let lastTurn = null, hasTurn = false
  for (const cb of contentBlocks) {
    const t = cb.turnIndex
    if (typeof t === 'number') { hasTurn = true; lastTurn = t; if(!groups.has(t)) groups.set(t, []); groups.get(t).push(cb) }
    else if (lastTurn !== null && hasTurn) groups.get(lastTurn).push(cb)
  }
  const turns = []
  for (const key of [...groups.keys()].sort((a,b)=>a-b)) {
    const seg = {reasoning:'', contentParts:[], toolCalls:[]}
    for (const cb of groups.get(key)) {
      if (cb.type==='think') { if (cb.thinkBlock?.content) seg.reasoning += cb.thinkBlock.content }
      else if (cb.type==='text') { if (cb.text) seg.contentParts.push(cb.text) }
      else if (cb.type==='tool_use') { if (cb.toolCall) seg.toolCalls.push(cb.toolCall) }
    }
    if (!seg.reasoning && seg.contentParts.length===0 && seg.toolCalls.length===0) continue
    turns.push(seg)
  }
  return turns
}

const rebuilt = []
for (const m of msgs) {
  if (m.role === 'user') {
    // user 消息 content 在 metadata.content（message_blocks 无块）
    const meta = db.prepare("SELECT metadata FROM messages WHERE id = ?").get(m.id)
    let content = ''
    try { content = JSON.parse(meta.metadata).content || '' } catch {}
    rebuilt.push({role:'user', content})
    continue
  }
  if (m.role !== 'assistant') continue
  const blocks = db.prepare("SELECT block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence").all(m.id)
  const turns = rebuildTurnIndex(blocks)
  for (const t of turns) {
    rebuilt.push({role:'assistant', content: t.contentParts.join(''), reasoning: t.reasoning || undefined,
      toolCalls: t.toolCalls.map(tc=>({id:tc.id, name:tc.name, arguments:(tc.arguments||tc.input||{})}))})
    for (const tc of t.toolCalls) {
      const raw = tc.result
      let tr = ''
      if (raw && typeof raw === 'object' && raw.toolResult) tr = raw.toolResult
      else if (raw && typeof raw === 'object' && raw.output) tr = typeof raw.output==='string' ? raw.output : JSON.stringify(raw.output)
      else if (typeof raw === 'string') tr = raw
      rebuilt.push({role:'tool', toolCallId: tc.id, toolResult: tr})
    }
  }
}
console.log(`DB 重建序列: ${rebuilt.length} 条`)

// ═══ 3. 逐条对比（结构键 + toolResult 长度标记）═══
const keyOf = m => {
  if (m.role === 'user') return `U:${(m.content||'').slice(0,80)}`
  if (m.role === 'assistant') return `A:${(m.toolCalls||[]).map(t=>t.id.slice(0,8)+':'+t.name).join(',')}:${(m.content||'').slice(0,30)}`
  if (m.role === 'tool') return `T:${(m.toolCallId||'').slice(0,8)}:len=${(m.toolResult||'').length}:${(m.toolResult||'').slice(0,20)}`
  return m.role
}

const maxLen = Math.max(runtimeMsgs.length, rebuilt.length)
let diff = -1
for (let i = 0; i < maxLen; i++) {
  const a = runtimeMsgs[i], b = rebuilt[i]
  if (!a || !b) { diff = i; break }
  if (keyOf(a) !== keyOf(b)) { diff = i; break }
}
console.log(`\n${diff === -1 ? '✓ 完全一致（缓存应命中）' : '✗ 第一个不一致在位置 ' + diff}`)
if (diff >= 0) {
  for (let i = Math.max(0,diff-2); i < Math.min(maxLen, diff+5); i++) {
    console.log(`  [${i}] 运行时: ${runtimeMsgs[i] ? keyOf(runtimeMsgs[i]) : '(无)'}${i===diff?' ◀◀◀':''}`)
    console.log(`  [${i}] 重建后: ${rebuilt[i] ? keyOf(rebuilt[i]) : '(无)'}${i===diff?' ◀◀◀':''}`)
  }
  // toolResult 长度对比（找长度不一致的）
  console.log('\n=== toolResult 长度不一致点（运行时 vs 重建）===')
  for (let i = 0; i < Math.min(runtimeMsgs.length, rebuilt.length); i++) {
    const a = runtimeMsgs[i], b = rebuilt[i]
    if (a?.role === 'tool' && b?.role === 'tool') {
      const la = (a.toolResult||'').length, lb = (b.toolResult||'').length
      if (la !== lb) console.log(`  [${i}] ${a.toolCallId?.slice(0,8)}: 运行时=${la} vs 重建=${lb} 差=${la-lb}`)
    }
  }
}
db.close()
