/**
 * 终极对比：重建路径（DB → historyConverter 语义）生成的 API 消息序列
 * vs 运行时 llm-calls 日志记录的实际 messages（增量拼接 = 运行时完整序列）
 * 
 * 找到第一个不一致点 → 定位缓存断裂的精确位置
 */
const fs = require('fs')
const Database = require('better-sqlite3')
const db = new Database('C:/Users/Hamlin/.hclaw/data/hclaw.db', {readonly: true})
const convId = 'conv-b70458a9-de95-404c-a85e-18b9ea9467af'

// ═══ 1. 运行时序列：从 llm-calls.jsonl 拼接增量 ═══
const logs = fs.readFileSync('C:/Users/Hamlin/AppData/Roaming/hclaw/logs/llm-calls.jsonl','utf8')
  .split('\n').filter(Boolean).map(l=>JSON.parse(l))

// 找该会话的所有调用记录（conversationTitle 为空，用时间范围 + messages 内容匹配）
// 简化：用最后一条全量重建（msgs=171）作为"运行时实际发送的完整序列"参考，
// 它本身就是运行时发出的真实 API messages
const fullLog = logs.filter(l => (l.messages||[]).length >= 100).slice(-1)[0]
const runtimeMsgs = fullLog.messages
console.log(`运行时全量序列: ${runtimeMsgs.length} 条 (${new Date(fullLog.timestamp).toLocaleTimeString('zh-CN',{hour12:false})})`)

// ═══ 2. 重建序列：DB → turnIndex 分组 → assistant+tool 展开 ═══
const msgs = db.prepare("SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY timestamp").all(convId)
const rebuilt = []
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

for (const m of msgs) {
  if (m.role === 'user') {
    // 读取 user 消息内容（从 message_blocks 或直接构造）
    const blocks = db.prepare("SELECT block_type, content, data FROM message_blocks WHERE message_id = ? ORDER BY sequence").all(m.id)
    const textBlocks = blocks.filter(b => b.block_type === 'text' && b.content)
    const content = textBlocks.map(b => b.content).join('')
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
console.log(`重建序列: ${rebuilt.length} 条`)

// ═══ 3. 逐条对比（仅比对结构键）═══
const keyOf = m => {
  if (m.role === 'user') return `U:${(m.content||'').slice(0,50)}`
  if (m.role === 'assistant') return `A:${(m.toolCalls||[]).map(t=>t.id+':'+t.name).join(',')}:${(m.content||'').slice(0,30)}`
  if (m.role === 'tool') return `T:${m.toolCallId||''}:${(m.toolResult||'').slice(0,30)}`
  return m.role
}

const maxLen = Math.max(runtimeMsgs.length, rebuilt.length)
let diff = -1
for (let i = 0; i < maxLen; i++) {
  const a = runtimeMsgs[i], b = rebuilt[i]
  if (!a || !b) { diff = i; break }
  if (keyOf(a) !== keyOf(b)) { diff = i; break }
}
console.log(`\n${diff === -1 ? '✓ 完全一致' : '✗ 第一个不一致在位置 ' + diff}`)
if (diff >= 0) {
  for (let i = Math.max(0,diff-2); i < Math.min(maxLen, diff+4); i++) {
    console.log(`  [${i}] 运行时: ${runtimeMsgs[i] ? keyOf(runtimeMsgs[i]) : '(无)'}${i===diff?' ◀◀◀':''}`)
    console.log(`  [${i}] 重建后: ${rebuilt[i] ? keyOf(rebuilt[i]) : '(无)'}${i===diff?' ◀◀◀':''}`)
  }
}
db.close()
