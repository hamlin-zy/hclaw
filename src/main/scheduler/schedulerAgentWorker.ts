/**
 * Scheduler Agent Worker — 在独立线程中执行定时任务
 *
 * Phase 1 优化: 替代主进程直跑 agentLoop，定时任务不再阻塞 UI 事件循环
 *
 * 通信协议:
 *   接收: { cmd: 'run', task: TaskConfig, signal?: AbortSignal }
 *   发送: { type: 'task:stream', scheduleId, content }  — 流式输出（可选）
 *          { type: 'task:result', scheduleId, success, output, error } — 最终结果
 *          { type: 'task:error', scheduleId, error } — 执行异常
 *          { type: 'agent:start', scheduleId, convId } — Agent 启动事件
 *          { type: 'agent:done', scheduleId, convId, success } — Agent 结束事件
 */
import {parentPort} from 'worker_threads'
import {agentLoop} from '../agent/loop'
import {registerBuiltinTools} from '../agent/tools/index'
import {setConfigBridge} from '../agent/common/configBridge'

// 防止 worker 因未捕获异常而崩溃，导致任务静默丢失
process.on('unhandledRejection', (reason) => {
    console.error('[SchedulerAgentWorker] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
    console.error('[SchedulerAgentWorker] uncaughtException:', err.message, err.stack)
})

interface TaskConfig {
    scheduleId: string
    convId: string
    taskType: string
    messages: Array<{ role: 'user'; content: string }>
    modelConfig: any
    workingDir: string
    agentDef?: any
    providers?: any[]
    scheme?: any
    /** 系统设置（含 maxTurns 等配置） */
    settings?: import('@shared/types').SystemSettings
}

let currentAbort: AbortController | null = null

parentPort?.on('message', async (msg: {
    cmd: string
    task?: TaskConfig
    abort?: string
}) => {
    if (msg.cmd === 'run' && msg.task) {
        await runTask(msg.task)
    }
    if (msg.cmd === 'abort' && msg.abort) {
        currentAbort?.abort()
    }
})

async function runTask(task: TaskConfig): Promise<void> {
    let output = ''
    let hasError = false
    let errorMsg = ''

    const ac = new AbortController()
    currentAbort = ac

    try {
        registerBuiltinTools()

        // Worker 线程独立 V8 隔离环境，必须初始化 ConfigBridge
        // 否则 agentLoop 内部 getConfigBridge() 会抛异常
        if (task.providers || task.scheme) {
            setConfigBridge({
                getScheme: () => task.scheme || null,
                getProviders: () => task.providers || [],
                onConfigChange: () => () => {},
            })
            console.log(`[SchedulerAgentWorker][runTask] ConfigBridge initialized providers=${task.providers?.length} scheme=${task.scheme?.id || '(none)'}`)
        } else {
            console.warn(`[SchedulerAgentWorker][runTask] WARNING: no providers/scheme in task, ConfigBridge NOT initialized!`)
        }

        const title = typeof task.messages[0]?.content === 'string'
            ? task.messages[0].content.slice(0, 50)
            : 'Scheduled Task'

        console.log(`[SchedulerAgentWorker][runTask] START scheduleId=${task.scheduleId} convId=${task.convId} type=${task.taskType} title="${title}" messages.length=${task.messages.length} agentDef=${task.agentDef?.name || '(none)'} workingDir=${task.workingDir}`)
        console.log(`[SchedulerAgentWorker][runTask] modelConfig provider=${task.modelConfig?.provider} model=${task.modelConfig?.model}`)
        console.log(`[SchedulerAgentWorker][runTask] firstMessage="${task.messages[0]?.content?.slice(0, 200)}"`)

        // 发送 Agent 启动事件
        parentPort?.postMessage({type: 'agent:start', scheduleId: task.scheduleId, convId: task.convId})

        let loopCount = 0
        for await (const event of agentLoop({
            sessionId: task.scheduleId,
            messages: task.messages,
            modelConfig: task.modelConfig,
            workingDir: task.workingDir,
            settings: task.settings,
            maxTurns: task.settings?.agent?.maxTurns ?? task.agentDef?.maxTurns ?? 500,
            agentType: task.agentDef?.name || 'General',
            agentDefinition: task.agentDef,
            conversationTitle: title,
            abortSignal: ac.signal,
        })) {
            loopCount++
            if (event.type === 'text') {
                const content = (event as any).content || ''
                output += content
                parentPort?.postMessage({type: 'task:stream', scheduleId: task.scheduleId, content})
            } else if (event.type === 'error') {
                hasError = true
                errorMsg = (event as any).error || ''
                console.error(`[SchedulerAgentWorker][runTask] agentLoop ERROR event: ${errorMsg}`)
            } else if (event.type === 'done') {
                console.log(`[SchedulerAgentWorker][runTask] agentLoop done after ${loopCount} events`)
                break
            }
        }

        console.log(`[SchedulerAgentWorker][runTask] agentLoop EXITED loopCount=${loopCount} output.length=${output.length}`)
    } catch (err: any) {
        hasError = true
        errorMsg = err.message || String(err)
        console.error(`[SchedulerAgentWorker][runTask] agentLoop EXCEPTION: ${errorMsg}\n${err.stack || '(no stack)'}`)
    } finally {
        currentAbort = null

        console.log(`[SchedulerAgentWorker][runTask] FINAL hasError=${hasError} errorMsg="${errorMsg?.slice(0, 300)}" output.length=${output.length}`)

        // 发送 Agent 结束事件
        parentPort?.postMessage({
            type: 'agent:done',
            scheduleId: task.scheduleId,
            convId: task.convId,
            success: !hasError,
        })
    }

    parentPort?.postMessage({
        type: 'task:result',
        scheduleId: task.scheduleId,
        success: !hasError,
        output: output.trim(),
        error: errorMsg,
    })
}
