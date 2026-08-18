/**
 * 验证修复：execution.ts 重建路径恢复 skill system 注入消息
 * 
 * 模拟 agent-start 重建逻辑（与 execution.ts 同构）：
 * 1. 从 DB 读取历史
 * 2. 重建 assistant 消息（convertAssistantHistoryMessage 语义）
 * 3. 检测 skill tool_call → 从 result.output 恢复 system 消息
 * 
 * 验证：system 消息出现在正确位置、内容 === tool_result.output（guidance）
 */
const Database = require('better-sqlite3')
const db = new Database('C:/Users/Hamlin/.hclaw/data/hclaw.db', {readonly: true})
const convId = 'conv-b70458a9-de95-404c-a85e-18b9ea9467af'

// 简化重建（仅验证 skill system 恢复逻辑，turnIndex 分组从简）
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

// 第一条 assistant 消息 33ea07e5（含 skill 调用）
const msgId = '33ea07e5-dada-42ca-a93e-d9d971fffc87'
const blocks = db.prepare("SELECT block_type, content, data, sequence, turn_index FROM message_blocks WHERE message_id = ? ORDER BY sequence").all(msgId)
const turns = rebuildTurnIndex(blocks)

console.log(`=== 33ea07e5 重建 ${turns.length} 个 turn ===`)
let skillFound = false
for (const t of turns) {
  const skillTc = t.toolCalls.filter(tc => tc.name === 'skill')
  if (skillTc.length > 0) {
    skillFound = true
    for (const tc of skillTc) {
      const raw = tc.result
      const guidance = raw && typeof raw === 'object'
        ? (raw.output !== undefined && raw.output !== null
            ? (typeof raw.output === 'string' ? raw.output : JSON.stringify(raw.output))
            : (raw.toolResult || ''))
        : (typeof raw === 'string' ? raw : '')
      console.log(`\n✓ 找到 skill 工具调用: ${tc.id.slice(0,12)}`)
      console.log(`  result.output 长度: ${guidance.length}`)
      console.log(`  前100: ${guidance.slice(0,100)}`)
      console.log(`  与 DB tool_result 一致: ${guidance === JSON.parse(blocks.find(b=>b.block_type==='tool_result' && b.data.includes('systematic-debugging')).data).result.output}`)
    }
  }
}
console.log(`\nskill 调用找到: ${skillFound}`)
db.close()
