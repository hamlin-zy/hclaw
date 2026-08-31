/**
 * MemoStore — 备忘录主进程持久化模块
 * spec §4：~/.hclaw/data/memo/<hash16>/memos.json，原子写，损坏容错，附件按 memoId 归档
 *
 * CRUD 写操作同步执行：内存单例 + Node 单线程 + 原子写（tmp+rename）天然满足 spec 的
 * "串行"约束；enqueue 串行队列机制仅保留给未来异步流程（附件迁移/会话创建）。
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import {randomUUID} from 'crypto'
import type {MemoItem, MemoAttachment, MemoCapability} from '@shared/types/memo'
import {getHclawDir} from '../config'
import {logger} from '../agent/logger'

const MEMO_ROOT = () => path.join(getHclawDir(), 'data', 'memo')
const PENDING_DIR = () => path.join(MEMO_ROOT(), '_pending')

function hashWorkspace(workspacePath: string): string {
    return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)
}

function memoDir(workspacePath: string): string {
    return path.join(MEMO_ROOT(), hashWorkspace(workspacePath))
}

function memoFile(workspacePath: string): string {
    return path.join(memoDir(workspacePath), 'memos.json')
}

class MemoStore {
    private readAll(workspacePath: string): MemoItem[] {
        const file = memoFile(workspacePath)
        if (!fs.existsSync(file)) return []
        try {
            // 旧数据无 title/pinned/sortIndex 字段 → 归一化默认值（向后兼容，不迁移写回）
            const items = JSON.parse(fs.readFileSync(file, 'utf8')) as MemoItem[]
            return items.map(item => ({
                ...item,
                title: item.title ?? '',
                pinned: item.pinned ?? false,
                sortIndex: item.sortIndex ?? 0,
            }))
        } catch {
            const backup = `${file}.corrupt-${Date.now()}`
            try {
                fs.renameSync(file, backup)
            } catch (err) {
                logger.error('[MemoStore] corrupt backup failed', {file, error: String(err)})
            }
            logger.warn('[MemoStore] memos.json corrupted, backed up', {file, backup})
            return []
        }
    }

    /** 原子写：同目录 tmp + rename */
    private writeAll(workspacePath: string, items: MemoItem[]): void {
        const file = memoFile(workspacePath)
        fs.mkdirSync(path.dirname(file), {recursive: true})
        const tmp = `${file}.tmp-${randomUUID()}`
        fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8')
        fs.renameSync(tmp, file)
    }

    list(workspacePath: string): MemoItem[] {
        return this.readAll(workspacePath)
    }

    create(input: {workspacePath: string; title: string; content: string; capability?: MemoCapability; attachments?: MemoAttachment[]}): MemoItem {
        const title = input.title?.trim() ?? ''
        const content = input.content?.trim() ?? ''
        const attachments = input.attachments ?? []
        if (!title) throw new Error('MEMO_EMPTY')
        if (!content && attachments.length === 0) throw new Error('MEMO_EMPTY')
        const now = Date.now()
        const item: MemoItem = {
            id: `memo-${randomUUID()}`,
            workspacePath: input.workspacePath,
            title,
            content,
            createdAt: now,
            updatedAt: now,
            capability: input.capability,
            attachments,
            status: 'active',
            pinned: false,
            sortIndex: 0,
        }
        // 暂存附件迁移到 attachments/<memoId>/（与写 memos.json 同一同步事务）
        item.attachments = item.attachments.map(att => this.migratePending(att, item.id, input.workspacePath))
        const items = this.readAll(input.workspacePath)
        items.unshift(item)
        this.writeAll(input.workspacePath, items)
        return item
    }

    /** 遍历所有工作区 hash 目录定位条目 */
    private locate(id: string): {workspacePath: string; item: MemoItem} | null {
        const root = MEMO_ROOT()
        if (!fs.existsSync(root)) return null
        for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
            if (!entry.isDirectory()) continue
            const file = path.join(root, entry.name, 'memos.json')
            if (!fs.existsSync(file)) continue
            try {
                const items = JSON.parse(fs.readFileSync(file, 'utf8')) as MemoItem[]
                const item = items.find(m => m.id === id)
                if (item) return {workspacePath: item.workspacePath, item: {...item, title: item.title ?? ''}}
            } catch {
                // 损坏目录跳过，不在定位路径上做容错写
            }
        }
        return null
    }

    findById(id: string): MemoItem | undefined {
        return this.locate(id)?.item
    }

    update(id: string, patch: Partial<Pick<MemoItem, 'title' | 'content' | 'capability' | 'attachments' | 'status' | 'relatedConvId' | 'pinned' | 'sortIndex'>>): MemoItem {
        const hit = this.locate(id)
        if (!hit) throw new Error('MEMO_NOT_FOUND')
        const {workspacePath} = hit
        const items = this.readAll(workspacePath)
        const idx = items.findIndex(m => m.id === id)
        if (idx === -1) throw new Error('MEMO_NOT_FOUND')
        const updated: MemoItem = {...items[idx], ...patch, updatedAt: Date.now()}
        // 标记为已处理时自动取消置顶（processed 组内无置顶语义）
        if (patch.status === 'processed') updated.pinned = false
        if (patch.title !== undefined) {
            const title = patch.title.trim()
            if (!title) throw new Error('MEMO_EMPTY')
            updated.title = title
        }
        if (patch.content !== undefined) updated.content = patch.content.trim()
        if (patch.attachments !== undefined) {
            updated.attachments = patch.attachments.map(att => this.migratePending(att, id, workspacePath))
        }
        items[idx] = updated
        this.writeAll(workspacePath, items)
        return updated
    }

    remove(id: string): void {
        const hit = this.locate(id)
        if (!hit) return
        const {workspacePath} = hit
        const items = this.readAll(workspacePath).filter(m => m.id !== id)
        this.writeAll(workspacePath, items)
        // 清理该条目的附件归档目录
        const attDir = path.join(memoDir(workspacePath), 'attachments', id)
        fs.rmSync(attDir, {recursive: true, force: true})
    }

    /** storedPath 位于 _pending 的附件迁移到 attachments/<memoId>/，否则原样返回 */
    private migratePending(att: MemoAttachment, memoId: string, workspacePath: string): MemoAttachment {
        const pendingRoot = PENDING_DIR()
        const resolved = path.resolve(att.storedPath)
        if (!resolved.startsWith(path.resolve(pendingRoot) + path.sep)) return att
        const destDir = path.join(memoDir(workspacePath), 'attachments', memoId)
        fs.mkdirSync(destDir, {recursive: true})
        // 防路径穿越：fileName 只取 basename；源文件已被迁移走（重复提交旧 attachments）则仅更新 storedPath
        const dest = path.join(destDir, path.basename(att.fileName))
        if (!fs.existsSync(resolved)) {
            logger.warn('[MemoStore] pending file missing on migrate, skip rename', {storedPath: resolved, memoId})
            return {...att, storedPath: dest}
        }
        fs.renameSync(resolved, dest)
        return {...att, storedPath: dest}
    }

    /** 上传附件：有 memoId 直接入库归档目录，无 memoId 先暂存到 _pending/<attId>/ */
    async uploadAttachment(input: {memoId?: string; fileName: string; srcPath: string; mime: string}): Promise<MemoAttachment> {
        const id = `att-${randomUUID()}`
        const kind: MemoAttachment['kind'] = input.mime.startsWith('image/') ? 'image' : 'file'
        let destDir: string
        if (input.memoId) {
            const hit = this.locate(input.memoId)
            if (!hit) throw new Error('MEMO_NOT_FOUND')
            destDir = path.join(memoDir(hit.workspacePath), 'attachments', input.memoId)
        } else {
            destDir = path.join(PENDING_DIR(), id)
        }
        fs.mkdirSync(destDir, {recursive: true})
        // 防路径穿越：fileName 只取 basename，禁止 ..\..\x 或绝对路径逃逸 destDir
        const safeName = path.basename(input.fileName)
        const storedPath = path.join(destDir, safeName)
        fs.copyFileSync(input.srcPath, storedPath)
        return {id, fileName: safeName, storedPath, mime: input.mime, kind}
    }

    /** 删除 _pending/<attId>/ 暂存目录 */
    async discardPending(attachmentIds: string[]): Promise<void> {
        for (const attId of attachmentIds) {
            // 防路径穿越：attId 仅允许 att-<uuid> 形式，不匹配则忽略
            if (!/^att-[0-9a-f-]+$/i.test(attId)) {
                logger.warn('[MemoStore] discardPending invalid attId, ignored', {attId})
                continue
            }
            fs.rmSync(path.join(PENDING_DIR(), attId), {recursive: true, force: true})
        }
    }

    /** 应用启动时调用：清理 _pending 中超 24h 的残留目录 */
    cleanupStalePending(): void {
        const root = PENDING_DIR()
        if (!fs.existsSync(root)) return
        const staleMs = 24 * 60 * 60 * 1000
        for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
            if (!entry.isDirectory()) continue
            const full = path.join(root, entry.name)
            try {
                if (Date.now() - fs.statSync(full).mtimeMs > staleMs) {
                    fs.rmSync(full, {recursive: true, force: true})
                }
            } catch (err) {
                logger.warn('[MemoStore] cleanupStalePending entry failed', {entry: entry.name, error: String(err)})
            }
        }
    }
    /**
     * 从备忘录创建会话（复用 session_handoff 链路，spec §6）：
     * ①模型配置检查 ②能力前缀+commandId（单次解析，失败降级纯正文）
     * ③repo.create+writeMessages（不设 handoffFromConvId）④session_created 广播
     * （★ 先于 agentManager.start，保证渲染端先建会话再收流事件）⑤agentManager.start
     * ⑥全部成功才标记 processed+relatedConvId。
     * 失败时抛错且 memoStore 状态不变（start 失败时清理刚建的会话 meta）。
     */
    async createSessionFromMemo(memoId: string): Promise<{convId: string}> {
        const item = this.findById(memoId)
        if (!item) throw new Error('MEMO_NOT_FOUND')

        // ① 模型配置检查
        const {runtimeConfigManager} = await import('../agent/runtimeConfigManager')
        if (!runtimeConfigManager.getPrimaryProvider().isValid) {
            throw new Error('模型配置未初始化')
        }

        // ② 能力前缀 + commandId（与 sessionHandoffTool 同源：单次解析，结果同时决定前缀与透传）
        let commandId: string | undefined
        if (item.capability) {
            try {
                const {resolveEntityCommand} = await import('../agent/entityCommandResolver')
                commandId = resolveEntityCommand(item.capability.name)?.commandId
            } catch (err) {
                logger.warn('[MemoStore] capability resolve failed, fallback to plain content', {memoId, error: String(err)})
            }
        }
        const capabilityOk = Boolean(item.capability && commandId)
        const content = capabilityOk ? `/${item.capability!.name}\n${item.content}` : item.content
        // 会话 title 使用 memo.title；旧数据 title 为空时回退 content 前 50 字符
        const title = item.title.trim() || item.content.slice(0, 50) || '备忘录处理'
        // 附件 → 双用途（同 sessionHandoffTool）：
        // 1) metadata.attachments 结构化存储 → MessageList 附件卡片渲染
        // 2) startAgentCore 经 messageAttachments 构建首轮多模态 content（图片 base64 块 + 路径标注）
        const {toMessageAttachments} = await import('../agent/utils/userContentBuilder')
        const rawAttachments = item.attachments.map(a => ({path: a.storedPath, name: a.fileName}))
        const messageAttachments = toMessageAttachments(rawAttachments)
        const now = Date.now()

        // ③ 创建会话 meta（无 handoffFromConvId：备忘录来源为独立顶层会话）
        const {createConversationRepository} = await import('../repositories')
        const repo = createConversationRepository()
        const convId = `conv-${randomUUID()}`
        if (!repo.create(convId, {
            id: convId,
            title,
            workspacePath: item.workspacePath,
            createdAt: now,
            updatedAt: now,
            preview: '',
            status: 'active' as const,
        })) {
            throw new Error('创建会话失败')
        }
        // ★ 落库统一由 startAgentCore 处理（Phase 2 收敛后 user 消息唯一写入方）；
        //   此处不再自行 writeMessages，否则 startAgentCore 会再落一条 → 会话出现两条重复。
        //   metadata（commandId）经 messageMetadata 透传，落库时随消息写入。

        // ④ 通知渲染进程（复用 session_created 通道，字段对齐 sessionHandoffTool）
        // ★ 必须在 agentManager.start 之前发送：start() 会立即向渲染进程转发 begin
        //   流事件（manager.impl.ts forwardToRenderer），若 session_created 后到，
        //   渲染端 handleSessionCreated 的 createDefaultConvData 重置会抹掉已建立的
        //   streamingMessageId，随后切换会话的 DB 加载覆盖内存占位且合并被跳过
        //   → 新会话出现孤儿空白助手气泡。handoff 链路无此问题（worker→main 队列
        //   保证 session_created 先于流事件），此处显式恢复同一时序不变量。
        try {
            const {getMainWindow} = await import('../window')
            const win = getMainWindow()
            if (win && !win.isDestroyed()) {
                win.webContents.send('session_created', {id: convId, title, workspacePath: item.workspacePath})
            }
        } catch (err) {
            logger.warn('[MemoStore] session_created notify failed', {convId, error: String(err)})
        }

        // ⑤ 启动 Worker（统一入口 startAgentCore：从 DB 读回已落库的 user 消息
        //    并经 convertUserHistoryMessage 重建，再 push params.message；
        //    memo 落库的 userMsg.content 是纯文本 content（附件在 metadata.attachments），
        //    故传纯文本 message + messageAttachments，与渲染端「先落库纯文本再传
        //    message + messageAttachments」场景完全同构 → DB content === params.message，
        //    isDuplicatePendingUserMessage 去重生效；多模态首轮 content 由 core 经
        //    messageAttachments 构建，与原 buildUserHistoryContent 路径等价）
        const {startAgentCore} = await import('../agent/startAgentCore')
        try {
            await startAgentCore({
                conversationId: convId,
                message: content,
                ...(messageAttachments.length ? {messageAttachments} : {}),
                ...(commandId ? {messageMetadata: {commandId}} : {}),
                conversationTitle: title,
            }, 'memo')
        } catch (err) {
            // 失败清理：删除刚建的会话 meta，memo 状态不动
            try {
                repo.delete(convId)
            } catch {
                // best effort
            }
            throw err
        }

        // ⑥ 全部成功 → 标记 processed
        this.update(memoId, {status: 'processed', relatedConvId: convId})
        return {convId}
    }
}

export const memoStore = new MemoStore()
