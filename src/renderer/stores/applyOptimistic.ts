/**
 * applyOptimistic — 乐观更新工具（通用件）
 *
 * 语义：先改内存（mutate）→ 持久化（persist）→ 失败用 snapshot() 回滚。
 * 错误统一规范化为字符串，与 renderer 各 store / IPC 的 error 形态一致。
 */

interface ApplyOptimisticArgs<R> {
    /**
     * 回滚动作：失败时调用，把内存恢复到修改前的状态。
     * 实现方需在 mutate **之前**捕获旧值，并在此真正写回（`set({...})`）。
     */
    snapshot: () => void
    /** 乐观写入：把内存改成目标状态（闭包内已捕获目标值） */
    mutate: () => void
    /** 持久化：抛错，或 resolve 出 {ok:false} 均视为失败 */
    persist: () => Promise<R> | Promise<{ok: boolean; error?: string}>
}

export type ApplyOptimisticResult<R> = {ok: true; data: R} | {ok: false; error: string}

/** 任意抛出物 → 字符串（Error.message → 字符串本身 → {message|error} → String()） */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message || String(err)
    if (typeof err === 'string') return err
    if (err && typeof err === 'object') {
        const {message, error} = err as {message?: unknown; error?: unknown}
        if (typeof message === 'string' && message) return message
        if (typeof error === 'string' && error) return error
    }
    return String(err)
}

/**
 * IPC 风格的失败结果。仓库里两种约定并存：`{ok:false}` 与 `{success:false}`，
 * 两者都视为失败 —— 只认 `{ok:false}` 会让 `{success:false}` 被误判为成功、
 * 跳过回滚（agentTemplateStore 曾因此回滚失效）。
 */
type FailedResult = {ok: false; error?: string} | {success: false; error?: string}

function isFailedResult(value: unknown): value is FailedResult {
    if (!value || typeof value !== 'object') return false
    const v = value as {ok?: unknown; success?: unknown}
    return v.ok === false || v.success === false
}

export async function applyOptimistic<R>({
    snapshot,
    mutate,
    persist,
}: ApplyOptimisticArgs<R>): Promise<ApplyOptimisticResult<R>> {
    mutate()

    let result: R | {ok: boolean; error?: string}
    try {
        result = await persist()
    } catch (err) {
        snapshot()
        return {ok: false, error: toErrorMessage(err)}
    }

    if (isFailedResult(result)) {
        snapshot()
        return {ok: false, error: result.error || '持久化失败'}
    }

    return {ok: true, data: result as R}
}
