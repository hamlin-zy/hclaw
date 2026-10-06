// 本文件不得 import 任何模块（no-circular）：
// 它是能力开关侧（agent/ipc/skills、agent/ipc/agents）与仓库侧（repo/ipc）之间的单向中继，
// 一旦引入依赖（哪怕只是类型），就会把 repo/* 与 agent/* 重新连成环。
// 故此处只用全局可见的语言内建能力（无 import / 无 require）。

/** 能力启用态变更监听器：由 repo 侧注册（refreshRepoMeta），不关心返回值 */
export type CapabilityStateListener = () => void | Promise<void>

/** 当前监听器（单变量：全局只有一个 repo 侧消费者，重复注册按覆盖语义处理） */
let listener: CapabilityStateListener | null = null

/** 注册监听器（传 null 等价于清除） */
export function setCapabilityStateListener(next: CapabilityStateListener | null): void {
  listener = next
}

/** 清除监听器（测试隔离：防上一用例的监听器泄漏进下一用例） */
export function clearCapabilityStateListener(): void {
  listener = null
}

/** 通知能力启用态已变更。未注册监听器时安静返回；监听器抛错由调用方处理。 */
export function notifyCapabilityStateChanged(): Promise<void> {
  if (!listener) return Promise.resolve()
  return Promise.resolve(listener())
}
