import {ipcMain, BrowserWindow} from 'electron';
import {createConversationRepository, createMessageBlockRepository} from './repositories';
import {computeConversationUsageStats} from './usageStats'
import {attachCosts} from '@shared/llmUsage'
import {modelMetaPriceSource} from './modelMetaRegistry'
import {buildCustomPriceEntries} from './utils/customPriceEntries'
import {getMainWindow} from './window'
import type {BlockDeltaPatch, ConversationMeta, ConversationSummary, Message, MessageBlock} from '@shared/types';
import {collectDescendants} from '@shared/utils/conversationTree'

/** 向除发送方外的所有窗口广播事件（跨窗口同步共用） */
function broadcastToOtherWindows(sender: Electron.WebContents, channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents === sender) continue;
        win.webContents.send(channel, payload);
    }
}

/** 注册会话管理相关 IPC handlers */
export function initConversationIPC(): void {
    const convRepo = () => createConversationRepository();
    const blockRepo = () => createMessageBlockRepository();

    // ── Conversation CRUD ───────────────────────────────
    ipcMain.handle('conversation-create', (_e, convId: string, meta: Record<string, unknown>) => {
        try {
            const ok = convRepo().create(convId, meta as unknown as ConversationMeta);
            // 跨窗口同步：渲染端（含 MCP「帮我检查」等独立 dialog 窗口）建会话后，
            // 主窗口需感知并刷新侧栏。发送方自身排除，避免重复插入。
            if (ok && _e.sender) {
                const m = meta as Partial<ConversationMeta>;
                broadcastToOtherWindows(_e.sender, 'conversation-created', {
                    id: convId,
                    title: m.title ?? '新对话',
                    workspacePath: m.workspacePath ?? '',
                    createdAt: m.createdAt,
                    updatedAt: m.updatedAt,
                    source: 'renderer-create',
                });
            }
            return ok;
        } catch {
            return false;
        }
  });

    ipcMain.handle('conversation-read-meta', (_e, convId: string) => {
        try {
            return convRepo().readMeta(convId);
        } catch {
            return null;
        }
  });

    ipcMain.handle('conversation-read-messages', (_e, convId: string) => {
        try {
            return convRepo().readMessages(convId);
        } catch (err) {
            console.error('[IPC] conversation-read-messages failed:', err);
            return [];
        }
  });

    ipcMain.handle('conversation-write-messages', (_e, convId: string, messages: unknown[]) => {
        try {
            return convRepo().writeMessages(convId, messages as Message[]);
        } catch {
            return false;
        }
  });

    // ── 增量落库：流式期间只写单条变化消息（性能优化，避免全量重写 + IPC 传输） ──
    ipcMain.handle('conversation-write-messages-delta', (_e, convId: string, message: unknown) => {
        try {
            return convRepo().writeMessagesDelta(convId, message as Message);
        } catch {
            return false;
        }
  });

    ipcMain.handle('conversation-write-block-delta', (_e, convId: string, msgId: string, patch: unknown) => {
        try {
            return convRepo().writeBlockDelta(convId, msgId, patch as BlockDeltaPatch);
        } catch {
            return false;
        }
  });

    ipcMain.handle('conversation-update-meta', (_e, convId: string, updates: Record<string, unknown>) => {
        try {
            const result = convRepo().updateMeta(convId, updates as Partial<ConversationMeta>);
            // 通知渲染器更新会话预览等元数据
            if (result) {
                const win = getMainWindow()
                if (win && !win.isDestroyed()) {
                    win.webContents.send('conversation-updated', {
                        id: convId,
                        ...updates,
                        updatedAt: Date.now(),
                    })
                }
            }
            return result;
        } catch {
            return false;
        }
  });

    ipcMain.handle('conversation-set-message-ended', (_e, convId: string, messageId: string, endedAt: number) => {
        try {
            return convRepo().setMessageEnded(convId, messageId, endedAt);
        } catch {
            return false;
        }
  });

    ipcMain.handle('conversation-delete', (_e, convId: string) => {
        try {
            const ok = convRepo().delete(convId);
            // 跨窗口同步：任意窗口（含 conversations 配置窗口）删除会话后，
            // 通知其他窗口从侧栏移除该条目，避免残留已删除会话
            if (ok && _e.sender) {
                broadcastToOtherWindows(_e.sender, 'conversation-deleted', {ids: [convId]});
            }
            return ok;
        } catch {
            return false;
        }
  });

    ipcMain.handle('conversation-delete-message', (_e, convId: string, messageId: string) => {
        try {
            return convRepo().deleteMessage(convId, messageId);
        } catch (err) {
            console.error('[IPC] conversation-delete-message failed:', err);
            return false;
        }
  });

  ipcMain.handle('conversation-list', () => {
      try {
          return convRepo().list();
      } catch {
          return [];
      }
  });

  ipcMain.handle('conversation-list-by-workspace', (_e, workspacePath: string) => {
      try {
          return convRepo().listByWorkspace(workspacePath);
      } catch (err) {
          console.error('[IPC] conversation-list-by-workspace failed:', err);
          return [];
      }
  });

    // ── Block handlers ──────────────────────────────────
    ipcMain.handle('blocks-write', (_e, convId: string, block: unknown) => {
        try {
            blockRepo().writeBlock(convId, block as MessageBlock);
            return true;
        } catch (err) {
            console.error('[IPC] blocks-write failed:', err);
            return false;
        }
    });

    ipcMain.handle('blocks-update', (_e, blockId: string, updates: unknown) => {
        try {
            blockRepo().updateBlock(blockId, updates as Partial<MessageBlock>);
            return true;
        } catch (err) {
            console.error('[IPC] blocks-update failed:', err);
            return false;
        }
    });

    ipcMain.handle('blocks-read-by-message', (_e, messageId: string) => {
        try {
            return blockRepo().readBlocksByMessage(messageId);
        } catch (err) {
            console.error('[IPC] blocks-read-by-message failed:', err);
            return [];
        }
    });

    // ── 批量操作 ────────────────────────────────────────
    ipcMain.handle('conversation-list-with-stats', (_e, workspacePath: string) => {
        try {
            return convRepo().listWithStats(workspacePath);
        } catch (err) {
            console.error('[IPC] conversation-list-with-stats failed:', err);
            return [];
        }
    });

    ipcMain.handle('conversation-delete-batch', (_e, ids: string[]) => {
        try {
            const ok = Array.isArray(ids) && ids.length > 0 && convRepo().deleteBatch(ids);
            // 跨窗口同步：批量删除同样通知其他窗口移除条目
            if (ok && _e.sender) {
                broadcastToOtherWindows(_e.sender, 'conversation-deleted', {ids});
            }
            return ok;
        } catch (err) {
            console.error('[IPC] conversation-delete-batch failed:', err);
            return false;
        }
    });

    // ── Usage stats ──────────────────────────────────────
    ipcMain.handle('conversation-usage-stats', (_e, convId: string) => {
        try {
            if (!convId) return null
            const convRepoInstance = convRepo()
            const allConvs = convRepoInstance.list() as ConversationSummary[]
            // ★ 必须先展开后代 id 集合再读取：compute 内部按展开后的 id 从 map 取数，
            //   只传起点会话会导致所有后代的 llm_stats / tool 计数归零
            const scopeIds = collectDescendants(allConvs, [convId])
            const {llmStatsByConv, toolCallCountByConv} = convRepoInstance.readUsageRaw(scopeIds)
            const stats = computeConversationUsageStats(
                allConvs,
                llmStatsByConv,
                toolCallCountByConv,
                convId,
            )
            // ★ 分组成本接线：computeConversationUsageStats 为纯函数（无价格依赖），
            //   breakdown 的 costUsd 恒 0，此处按行粒度补价：自定义 (providerId, model) →
            //   providerName → 实时价（modelMetaPriceSource 兜底），与独立窗口共用口径。
            stats.breakdown = attachCosts(stats.breakdown, modelMetaPriceSource, buildCustomPriceEntries())
            return stats
        } catch (err) {
            console.error('[IPC] conversation-usage-stats failed:', err)
            return null
        }
    })

    // ── Paginated reads ────────────────────────────────
    const handle = <T>(name: string, fn: () => T): T => {
        try {
            return fn()
        } catch (err) {
            console.error(`[IPC] ${name} failed:`, err);
            return {messages: [], totalCount: 0} as T
        }
    }
    ipcMain.handle('conversation-read-tail', (_e, convId: string, count: number) =>
        handle('conversation-read-tail', () => convRepo().readMessagesTail(convId, count)))
    ipcMain.handle('conversation-read-before', (_e, convId: string, beforeTimestamp: number, count: number) =>
        handle('conversation-read-before', () => convRepo().readMessagesBefore(convId, beforeTimestamp, count)))
}
