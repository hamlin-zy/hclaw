/**
 * AgentManager 消息备份工具
 */

import * as fs from 'fs'
import * as path from 'path'
import {homedir} from 'node:os'

/**
 * 备份旧消息到磁盘 JSON 文件（压缩前保护历史不丢失）
 */
export function backupOldMessagesToDisk(
  conversationId: string,
  messages: unknown[],
): void {
  try {
    const backupDir = path.join(homedir(), '.hclaw', 'backups', conversationId)
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, {recursive: true})
    }
    const backupFile = path.join(backupDir, `pre-compact-${Date.now()}.json`)
    const backupData = JSON.stringify({
      backedUpAt: Date.now(),
      conversationId,
      messageCount: messages.length,
      messages,
    }, null, 2)
    fs.writeFileSync(backupFile, backupData, 'utf-8')
  } catch {
    // 静默失败，不阻塞压缩流程
  }
}