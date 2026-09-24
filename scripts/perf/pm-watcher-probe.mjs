#!/usr/bin/env node
/**
 * PM watcher 首开性能探针
 *
 * 量化「chokidar 对工作区全量递归扫描」对**同进程**的影响，并与**独立进程**对照：
 *   - 并发下 `listDirectory('.')`（等价 pm:list-directory 的根目录读取）延迟
 *   - 事件循环 max lag
 *
 * 背景（见 docs/superpowers/specs/2026-09-23-pm-watcher-perf-design.md 第 1 节）：扫描打满
 * 进程级共享的 libuv fs 线程池（UV_THREADPOOL_SIZE，默认 4）与事件循环，同进程里排在扫描之后的
 * listDirectory 要等 5.5 s（实测），主进程事件循环 max lag 1.3 s。
 *
 * ⚠️ 度量口径（务必先读，否则会误读表格）：
 *   - 被测请求是**本脚本自建的 listDirectory 等价实现**（`listDirectoryLike`：1 次 readdir
 *     + 每子目录 1 次 readdir + 每文件 1 次 stat + 每层 1 次 `git check-ignore --stdin -z` 子进程），
 *     与 src/main/project-manager/fileSystem.ts 的 listDirectory 同构；不用裸 readdir 度量，
 *     因为裸 readdir 会低估真实首屏请求约 4.4 倍（实测 1456 ms vs 6437 ms）。
 *   - fork 模式用 `spawn(process.execPath)` 模拟 worker 进程，**不经过真实 Electron utilityProcess
 *     与 IPC 链路**。因此结论只用于「同进程 vs 跨进程」的**相对对照**，不等于端到端首屏耗时。
 *
 * 用法：
 *   node scripts/perf/pm-watcher-probe.mjs [--ws <工作区路径>] [--mode same|fork|both]
 *
 * 退出码：fork 模式不达标（非首样本 max > 200 ms 或 median > 100 ms）时非零。
 *         首个样本含 git 子进程冷启动，单列展示、不参与判定；same 模式只作对照，恒不判负。
 */

import chokidar from 'chokidar'
import {readdir, stat} from 'fs/promises'
import {join} from 'path'
import {monitorEventLoopDelay} from 'perf_hooks'
import {spawn} from 'child_process'
import {once} from 'events'
import {fileURLToPath} from 'url'
import process from 'process'

const __filename = fileURLToPath(import.meta.url)

/** 与 src/main/project-manager/watcherCore.ts 的 chokidar 选项保持一致 */
const WATCH_OPTIONS = {
  ignored: [
    /(^|[\\/])\.git([\\/]|$)/,
    /(^|[\\/])node_modules([\\/]|$)/,
    /(^|[\\/])\.vite([\\/]|$)/,
    /(^|[\\/])\.cache([\\/]|$)/,
    /(^|[\\/])\.trash([\\/]|$)/,
  ],
  depth: 15,
  ignoreInitial: true,
  awaitWriteFinish: {stabilityThreshold: 500},
}

/** 与 src/main/project-manager/fileSystem.ts 的 BLACKLIST 一致 */
const BLACKLIST = new Set(['.git', 'node_modules', '.vite', '.cache', '.trash'])

/** 采样间隔（ms）：每次采样就是一次「并发下的 listDirectory」 */
const SAMPLE_INTERVAL = 200
/** 等待首扫 ready 的上限（ms） */
const READY_TIMEOUT = 180_000
/**
 * 验收阈值（仅约束跨进程模式，且只看**非首样本**——首样本含 `git check-ignore` 子进程冷启动）：
 * max ≤ 200 ms 且 median ≤ 100 ms。裸 readdir 时代那套「max ≤ 100 ms」的宽松余量是靠轻指标换来的，
 * 换成真实语义后余量本就更紧，故阈值相应上调。
 */
const THRESHOLD_LIST_MAX_MS = 200
const THRESHOLD_LIST_MEDIAN_MS = 100

/** 探针进程内是否启用 git check-ignore（git 不可用 / 非仓库 → 跳过并在输出中标注） */
let gitCheckIgnoreEnabled = false

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ─── 子进程角色：只负责跑 chokidar 扫描（模拟 utilityProcess 里的 worker）────────

if (process.argv.includes('--child')) {
  const ws = process.argv[process.argv.indexOf('--ws') + 1]
  const watcher = chokidar.watch(ws, WATCH_OPTIONS)
  process.send?.({type: 'child-ready'})
  watcher.on('ready', () => process.send?.({type: 'scan-ready'}))
  watcher.on('error', (err) => process.send?.({type: 'child-error', message: String(err)}))
  process.on('message', (message) => {
    if (message?.type === 'shutdown') {
      watcher.close().then(() => process.exit(0), () => process.exit(0))
    }
  })
} else {
  await main()
}

// ─── 主角色 ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const ws = readArg(args, '--ws') ?? process.cwd()
  const mode = readArg(args, '--mode') ?? 'both'
  if (!['same', 'fork', 'both'].includes(mode)) {
    console.error(`未知 --mode: ${mode}（可选 same | fork | both）`)
    process.exit(2)
  }

  gitCheckIgnoreEnabled = await detectGitRepo(ws)

  console.log(`工作区: ${ws}`)
  console.log('模式:  same = chokidar 与探针同进程（迁移前）; fork = chokidar 在独立进程（迁移后）')
  console.log('被测请求: listDirectory 等价实现（readdir + 子目录 readdir + 文件 stat + 每层 1 次 git check-ignore）\n')

  const results = []
  if (mode === 'same' || mode === 'both') results.push(await measure(ws, 'same'))
  if (mode === 'fork' || mode === 'both') results.push(await measure(ws, 'fork'))

  printTable(results)
  printNotes()

  const forked = results.find(r => r.mode === 'fork')
  if (forked) {
    const ok = forked.maxListMs <= THRESHOLD_LIST_MAX_MS && forked.medianListMs <= THRESHOLD_LIST_MEDIAN_MS
    if (!ok) {
      console.error(
        `\n[FAIL] 跨进程模式未达标：非首样本 max ${forked.maxListMs.toFixed(0)} ms（阈值 ≤ ${THRESHOLD_LIST_MAX_MS} ms）、` +
        `median ${forked.medianListMs.toFixed(1)} ms（阈值 ≤ ${THRESHOLD_LIST_MEDIAN_MS} ms）`)
      process.exit(1)
    }
    console.log(
      `\n[PASS] 跨进程模式达标：非首样本 max listDirectory ≤ ${THRESHOLD_LIST_MAX_MS} ms 且 median ≤ ${THRESHOLD_LIST_MEDIAN_MS} ms` +
      `（首样本 ${forked.firstListMs.toFixed(0)} ms 仅作参考，不计入判定）`)
  }
}

function readArg(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** git 可用且 ws 是工作树 → 启用 check-ignore；否则跳过（不抛错） */
function detectGitRepo(ws) {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ws, stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

/**
 * 与 fileSystem.ts 的 `collectIgnored` 等价：`git check-ignore --stdin -z` 批量标记整层。
 * 退出码语义：0 = 有命中；1 = 全部未忽略（正常结果）；128 = 非仓库 —— 非 0 一律按「全部未忽略」处理。
 */
function checkIgnored(ws, relPaths) {
  return new Promise((resolve) => {
    const ignored = new Set()
    if (!gitCheckIgnoreEnabled || relPaths.length === 0) { resolve(ignored); return }
    const child = spawn('git', ['check-ignore', '--stdin', '-z'], {cwd: ws})
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(ignored))   // git 不可用：按全部未忽略
    child.on('close', (code) => {
      if (code === 0) for (const raw of out.split('\0')) { if (raw) ignored.add(raw.replace(/\\/g, '/')) }
      resolve(ignored)
    })
    child.stdin.end(relPaths.join('\0') + '\0')
  })
}

/**
 * 与 `fileSystem.listDirectory(ws, '.')` 同构的一次请求（首屏真实语义）：
 * 1 次 readdir(+withFileTypes) + 每层 1 次 check-ignore 子进程 + 每子目录 1 次 readdir + 每文件 1 次 stat。
 * statusMap 不参与（pm:list-directory 已与 git status 解耦）。
 */
async function listDirectoryLike(ws) {
  const items = await readdir(ws, {withFileTypes: true})
  const visible = items.filter(item => !BLACKLIST.has(item.name))
  await checkIgnored(ws, visible.map(item => item.name))
  for (const item of visible) {
    if (item.isDirectory()) {
      try { await readdir(join(ws, item.name)) } catch { /* 无权限按空处理 */ }
    } else {
      try { await stat(join(ws, item.name)) } catch { /* 忽略 */ }
    }
  }
}

/**
 * 一轮测量：启动扫描（同进程 / 独立进程），在扫描期间持续采样
 * 「根目录 listDirectory 延迟」与「事件循环 lag」，直到 chokidar ready。
 *
 * 首个样本单独记录 out.firstListMs：它含 `git check-ignore` 子进程冷启动（首次 spawn + 进程镜像加载），
 * 不参与阈值判定，否则会把「冷启动开销」误判成「跨进程不达标」。max / median 一律基于非首样本。
 */
async function measure(ws, mode) {
  const lag = monitorEventLoopDelay({resolution: 10})
  lag.enable()

  let watcher = null
  let child = null
  const ready = mode === 'same'
    ? startSameProcessScan(ws, (w) => { watcher = w })
    : startChildProcessScan(ws, (c) => { child = c })

  // 采样循环：单次 listDirectory 等价请求就是一次「并发下的首屏请求」；用链式调度避免样本堆积
  const samples = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const start = performance.now()
      try {
        await listDirectoryLike(ws)
      } catch { /* 目录不可读：忽略，只测延迟 */ }
      samples.push(performance.now() - start)
      await sleep(SAMPLE_INTERVAL)
    }
  })()

  let readyMs
  try {
    readyMs = await ready
  } finally {
    sampling = false
    await sampler
    lag.disable()
    if (watcher) await watcher.close()
    if (child) {
      child.send({type: 'shutdown'})
      await Promise.race([once(child, 'exit'), sleep(5000)])
      child.kill()
    }
  }

  const steady = samples.slice(1)               // 非首样本：判定用
  const judged = steady.length > 0 ? steady : samples
  const sorted = [...judged].sort((a, b) => a - b)
  return {
    mode,
    readyMs,
    firstListMs: samples.length > 0 ? samples[0] : 0,
    maxListMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    medianListMs: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
    maxLagMs: lag.max / 1e6,
    meanLagMs: lag.mean / 1e6,
    samples: samples.length,
    judgedSamples: judged.length,
  }
}

/** 迁移前形态：chokidar 与探针同进程（error 必须挂，否则 chokidar 抛错会 uncaught 退出并给出误导结论） */
function startSameProcessScan(ws, onWatcher) {
  const watcher = chokidar.watch(ws, WATCH_OPTIONS)
  onWatcher(watcher)
  const t0 = performance.now()
  return new Promise((resolve, reject) => {
    watcher.once('ready', () => resolve(performance.now() - t0))
    watcher.on('error', (err) => reject(err))
  })
}

/** 迁移后形态：chokidar 在独立 Node 进程（等价进程模型，非 Electron utilityProcess 本体） */
function startChildProcessScan(ws, onChild) {
  const t0 = performance.now()
  const child = spawn(process.execPath, [__filename, '--child', '--ws', ws], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  onChild(child)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待子进程首扫超时（${READY_TIMEOUT} ms）`)), READY_TIMEOUT)
    child.on('message', (message) => {
      if (message?.type === 'scan-ready') {
        clearTimeout(timer)
        resolve(performance.now() - t0)
      } else if (message?.type === 'child-error') {
        clearTimeout(timer)
        reject(new Error(`子进程 chokidar 报错：${message.message}`))
      }
    })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`子进程提前退出：code=${code}`))
    })
  })
}

function printTable(results) {
  const rows = [
    ['模式', '首扫 ready (ms)', '首样本 (ms)', 'max 非首样本 (ms)', 'median 非首样本 (ms)', 'max event-loop lag (ms)', 'mean lag (ms)', '样本数'],
    ...results.map(r => [
      r.mode === 'same' ? 'same（迁移前）' : 'fork（迁移后）',
      r.readyMs.toFixed(0),
      r.firstListMs.toFixed(0),
      r.maxListMs.toFixed(0),
      r.medianListMs.toFixed(1),
      r.maxLagMs.toFixed(0),
      r.meanLagMs.toFixed(1),
      `${r.samples}(判 ${r.judgedSamples})`,
    ]),
  ]
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => displayWidth(r[c]))))
  console.log('')
  for (const [i, row] of rows.entries()) {
    console.log(row.map((cell, c) => pad(cell, widths[c])).join(' | '))
    if (i === 0) console.log(widths.map(w => '-'.repeat(w)).join('-+-'))
  }
}

function printNotes() {
  console.log('')
  console.log('说明：')
  console.log('  1. 被测请求是**脚本内自建的 listDirectory 等价实现**（readdir + 每子目录 readdir + 每文件 stat +')
  console.log('     每层一次 git check-ignore 子进程），与 fileSystem.listDirectory 同构，但**不经过真实 IPC /')
  console.log('     utilityProcess 链路**（fork 模式用 spawn(node) 模拟 worker）。结论只用于「同进程 vs 跨进程」')
  console.log('     的相对对照，不等价于端到端首屏耗时。')
  console.log(`  2. git check-ignore：${gitCheckIgnoreEnabled ? '已启用（工作区是 git 仓库）' : '已跳过（git 不可用或非仓库）——本层少一个子进程，绝对值会偏乐观'}`)
  console.log(`  3. 阈值（仅 fork 模式）：非首样本 max ≤ ${THRESHOLD_LIST_MAX_MS} ms 且 median ≤ ${THRESHOLD_LIST_MEDIAN_MS} ms；`)
  console.log('     首样本含 git 子进程冷启动，单列展示、不参与判定。same 模式只输出对照，不判负。')
}

function displayWidth(text) {
  return [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
}

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}
