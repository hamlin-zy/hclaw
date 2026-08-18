/**
 * LLM 调用日志差异分析 — 定位跨 turn 缓存断裂的精确差异点
 *
 * 原理：llm-calls.jsonl 记录每次调用的完整 systemPrompt + messages。
 * 跨 turn 断裂时，第二轮首调的 cache_read 会相对第一轮末次调用回退，
 * 且 messages 是 agent-start 重建序列（新 worker 从 0 记录）。
 * 对比断裂前后两条日志，逐消息/逐字段找出第一个不一致点。
 *
 * 用法：node scripts/analyze-llm-cache-break.cjs [日志文件路径] [会话关键词]
 */
const fs = require('fs');
const path = require('path');

const logFile = process.argv[2] || path.join(process.env.APPDATA || '', 'hclaw', 'logs', 'llm-calls.jsonl');
const keyword = process.argv[3] || ''; // 可选：会话标题关键词过滤

if (!fs.existsSync(logFile)) {
  console.error('日志文件不存在:', logFile);
  process.exit(1);
}

const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
const logs = lines.map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

console.log(`日志总数: ${logs.length}`);

// 过滤：可选按会话标题关键词
const filtered = keyword ? logs.filter(log => (log.conversationTitle || '').includes(keyword)) : logs;
console.log(`过滤后: ${filtered.length} (关键词: "${keyword || '(全部)'}")`);

// 找 cache_read 回退点：相邻两条，后者 cache_read 明显小于前者（差 > 2000）
console.log('\n=== cache_read 回退点 ===');
for (let i = 1; i < filtered.length; i++) {
  const prev = filtered[i - 1];
  const cur = filtered[i];
  const pCr = prev.cacheReadTokens || 0;
  const cCr = cur.cacheReadTokens || 0;
  if (pCr > 0 && cCr < pCr - 2000) {
    const t1 = new Date(prev.timestamp).toLocaleString();
    const t2 = new Date(cur.timestamp).toLocaleString();
    console.log(`\n[回退] ${t1} → ${t2}`);
    console.log(`  前: model=${prev.model} in=${prev.inputTokens} cache=${pCr} (${prev.messages?.length || 0}条消息增量)`);
    console.log(`  后: model=${cur.model} in=${cur.inputTokens} cache=${cCr} (${cur.messages?.length || 0}条消息)`);
    console.log(`  标题: ${prev.conversationTitle} → ${cur.conversationTitle}`);
    comparePair(prev, cur);
  }
}

/** 对比断裂前后两条日志的 systemPrompt 与 messages */
function comparePair(prevLog, curLog) {
  // 1. systemPrompt 对比
  const pSys = prevLog.systemPrompt || '';
  const cSys = curLog.systemPrompt || '';
  console.log(`\n── systemPrompt 对比 ──`);
  console.log(`  前长度: ${pSys.length}, 后长度: ${cSys.length}`);
  if (pSys === cSys) {
    console.log('  ✓ systemPrompt 完全一致');
  } else {
    console.log('  ✗ systemPrompt 不一致!');
    // 找第一个差异位置
    const minLen = Math.min(pSys.length, cSys.length);
    let diffAt = -1;
    for (let i = 0; i < minLen; i++) {
      if (pSys[i] !== cSys[i]) { diffAt = i; break; }
    }
    if (diffAt >= 0) {
      console.log(`  第一个差异位置: ${diffAt}`);
      console.log(`  前: ...${pSys.slice(Math.max(0, diffAt - 40), diffAt + 60)}...`);
      console.log(`  后: ...${cSys.slice(Math.max(0, diffAt - 40), diffAt + 60)}...`);
    } else {
      console.log(`  前更长（差异在尾部）: 前尾 ...${pSys.slice(minLen - 30)}`);
      console.log(`                      后尾 ...${cSys.slice(minLen - 30)}`);
    }
  }

  // 2. messages 对比（需要重建：新 worker 的 messages 是增量，前一条的 messages 需要累积——简化：对比各自最后 N 条）
  console.log(`\n── messages 对比（各自最后 6 条）──`);
  for (const [p, c] of zipTail((prevLog.messages || []).slice(-6), (curLog.messages || []).slice(-6))) {
    console.log('  ' + formatMsgPair(p, c));
  }
}

/** 将两个数组尾部对齐后逐项配对，较短者前面补 undefined */
function zipTail(a, b) {
  const maxLen = Math.max(a.length, b.length);
  return Array.from({ length: maxLen }, (_, i) => [
    a[a.length - maxLen + i],
    b[b.length - maxLen + i],
  ]);
}

function msgFingerprint(m) {
  if (!m) return '(无)';
  const parts = [`${m.role}`];
  if (m.content !== undefined) parts.push(`content=${String(m.content).length}B`);
  if (m.toolCallId) parts.push(`id=${String(m.toolCallId).slice(-8)}`);
  if (m.toolResult !== undefined) parts.push(`tr=${String(m.toolResult).length}B`);
  if (m.toolCalls) parts.push(`tools=${m.toolCalls.map(t => `${t.name}:${t.id.slice(-4)}`).join(',')}`);
  return parts.join(' ');
}

function formatMsgPair(p, c) {
  const fp = msgFingerprint(p);
  const fc = msgFingerprint(c);
  if (fp === fc) return `  ✓ ${fp}`;
  return `✗ 前[${fp}]\n    后[${fc}]`;
}

// 摘要：打印全部记录的 cache_read 趋势
console.log('\n=== cache_read 趋势（按时间）===');
const recent = filtered.slice(-30); // 最近 30 条
recent.forEach(log => {
  const t = new Date(log.timestamp).toLocaleTimeString();
  console.log(`  ${t} in=${String(log.inputTokens).padStart(6)} cache=${String(log.cacheReadTokens || 0).padStart(6)} msgs=${String(log.messages?.length || 0).padStart(3)} ${(log.model || '').slice(0, 20)}`);
});
