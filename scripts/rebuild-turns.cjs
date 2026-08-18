/**
 * 终极验证：重建路径（DB → historyConverter → convertMessages）生成的 API 消息
 * vs 运行时实际发送的 API 消息（从 llm-calls.jsonl 的 systemPrompt + messages 重建）
 * 
 * 关键：日志不记录 tools，但记录 messages 结构 + systemPrompt。
 * 重建路径必须复现运行时完全相同的 API 请求前缀才能命中缓存。
 */
const fs = require('fs')
const Database = require('better-sqlite3')
const db = new Database('C:/Users/Hamlin/.hclaw/data/hclaw.db', {readonly: true})
const convId = 'conv-b70458a9-de95-404c-a85e-18b9ea9467af'

// 1. 从 DB 重建完整消息（模拟 agent-start 重建路径）
const msgs = db.prepare("SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY timestamp").all(convId)
console.log(`DB 消息数: ${msgs.length}`)

// 对每个 assistant 消息：按 historyConverter 的 turnIndex 分组重建
function rebuildTurnIndex(blocks) {
  const contentBlocks = []
  const toolById = new Map()
  for (const b of blocks) {
    const type = b.block_type
    if (type === 'think') contentBlocks.push({type:'think', thinkBlock: JSON.parse(b.data), turnIndex: b.turn_index})
    else if (type === 'text') contentBlocks.push({type:'text', text: b.content, turnIndex: b.turn_index})
    else if (type === 'tool_call') {
      const tc = JSON.parse(b.data); toolById.set(tc.id, tc)
      contentBlocks.push({type:'tool_use', toolCall: tc, turnIndex: b.turn_index})
    } else if (type === 'tool_result') {
      const d = JSON.parse(b.data); const tc = toolById.get(d.id)
      if (tc) tc.result = d.result
    }
  }
  const groups = new Map()
  let lastTurn = null, hasTurn = false
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

// 2. 对每个 assistant 消息重建 turns，统计：有 think 的 turn、无 think 的 turn
console.log('\n=== 各 assistant 消息的 turn 重建情况 ===')
for (const m of msgs) {
  if (m.role !== 'assistant') continue
  const blocks = db.prepare("SELECT block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence").all(m.id)
  const turns = rebuildTurnIndex(blocks)
  const withThink = turns.filter(t => t.reasoning).length
  const withoutThink = turns.filter(t => !t.reasoning).length
  console.log(`  ${m.id.slice(0,8)}: 重建 turn=${turns.length} (有think=${withThink} 无think=${withoutThink})`)
  
  // 记录第一个无 think 的 turn 的 toolCalls（这些在运行时是无 thinking 块的纯 tool 轮）
  for (let i=0; i<turns.length; i++) {
    if (!turns[i].reasoning) {
      const tcs = turns[i].toolCalls.map(t=>t.name).join(',')
      console.log(`    └ 无think turn: toolCalls=[${tcs}]`)
    }
  }
}
db.close()
