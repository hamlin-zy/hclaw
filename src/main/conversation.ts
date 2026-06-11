import {ipcMain} from 'electron';
import {createConversationRepository, createMessageBlockRepository} from './repositories';
import type {ConversationMeta, Message, MessageBlock} from '@shared/types';

/** 注册会话管理相关 IPC handlers */
export function initConversationIPC(): void {
    const convRepo = () => createConversationRepository();
    const blockRepo = () => createMessageBlockRepository();

    // ── Conversation CRUD ───────────────────────────────
    ipcMain.handle('conversation-create', (_e, convId: string, meta: Record<string, unknown>) => {
        try {
            return convRepo().create(convId, meta as unknown as ConversationMeta);
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

    ipcMain.handle('conversation-update-meta', (_e, convId: string, updates: Record<string, unknown>) => {
        try {
            const result = convRepo().updateMeta(convId, updates as Partial<ConversationMeta>);
            // 通知渲染器更新会话预览等元数据
            if (result) {
                const {getMainWindow} = require('./window')
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
            return convRepo().delete(convId);
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
            return Array.isArray(ids) && ids.length > 0 && convRepo().deleteBatch(ids);
        } catch (err) {
            console.error('[IPC] conversation-delete-batch failed:', err);
            return false;
        }
    });

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
