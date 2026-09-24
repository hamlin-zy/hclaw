// src/main/project-manager/watcherWorker.ts
import {createWatcherCore, type WatcherInMessage, type WatcherOutMessage} from './watcherCore'

/**
 * 项目管理窗口 watcher 的 utilityProcess 入口（极薄：只做端口接线）。
 *
 * 由 vite.main.config.mjs 的 `bundle-watcher-worker` 插件用 esbuild 单独打成 CJS 单文件
 * （`.vite/main/watcherWorker.cjs`），照抄仓内 channelWorker 的范式，规避
 * utilityProcess + ESM/asar 的兼容坑。
 *
 * ⚠️ 本文件**禁止 import electron**：worker 进程里不需要任何 electron API —— Electron 会把
 *    `process.parentPort` 直接注入 utilityProcess 的全局 process；而 vitest 环境没有 Electron，
 *    静态 import 会让测试无法加载。业务逻辑全在 watcherCore（同样不依赖 electron）。
 */

/** 只声明用到的部分：避免为了类型去 import electron */
interface ParentPortLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: {data: unknown}) => void): void
  start?: () => void
}

const port = (process as unknown as {parentPort?: ParentPortLike}).parentPort
if (!port) throw new Error('PM watcher worker must be run as an Electron utilityProcess')

const core = createWatcherCore((message: WatcherOutMessage) => port.postMessage(message))

port.on('message', event => {
  core.handleMessage(event.data as WatcherInMessage)
})
port.start?.()
// 主进程收到 ready 之后才下发积压的 watch（协议冻结）：避免 fork 后立刻 postMessage 的时序竞态
port.postMessage({type: 'ready'})
