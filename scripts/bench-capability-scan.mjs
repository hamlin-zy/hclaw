#!/usr/bin/env node
/**
 * 一次性只读度量脚本：统计能力扫描各阶段的 fs 调用次数与 wall time。
 *
 * 用法：
 *   node scripts/bench-capability-scan.mjs
 *
 * 说明（保真度声明）：
 * - scanSkillExtensions 通过 node 原生 type-stripping 直接加载「真实源码」
 *   （src/main/agent/skills/extensions.ts 复制为 scripts/.tmp-bench/extensions.mts），
 *   因此这一项的度量与等价性对比是对真实实现的直接调用。
 * - scanAllAgents / loadSkillsFromDirectory / loadSkillsFromPlugins / loadAllPlugins
 *   的静态依赖闭包包含 Electron 运行时（config→repositories→sqlite、PluginRegistry），
 *   无法在纯 node 下 import，故这里按其真实遍历逻辑做「等价复刻」：
 *   fs 调用的种类、次数与顺序尽量与源实现逐步对应。
 * - 脚本只读，不修改任何业务文件；.tmp-bench 为临时产物。
 */

import fsSync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {fileURLToPath} from 'node:url'
import {performance} from 'node:perf_hooks'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const HCLAW_DIR = path.join(os.homedir(), '.hclaw')
const PLUGINS_DIR = path.join(HCLAW_DIR, 'plugins')
const AGENTS_DIR = path.join(HCLAW_DIR, 'agents')
const HOME_AGENTS_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills')

// ─── fs 调用计数（monkey-patch） ─────────────────────────────
const COUNTED = ['readdir', 'stat', 'readFile', 'access', 'lstat']
const counters = Object.fromEntries(COUNTED.map(n => [n, 0]))

const patchOnce = new WeakSet()
function instrument(target) {
    if (!target || patchOnce.has(target)) return
    patchOnce.add(target)
    for (const name of COUNTED) {
        const orig = target[name]
        if (typeof orig !== 'function') continue
        target[name] = function (...args) {
            counters[name]++
            return orig.apply(this, args)
        }
    }
}
instrument(fsp)
try { instrument(fsSync.promises) } catch { /* 忽略读取失败 */ }

function resetCounters() {
    for (const n of COUNTED) counters[n] = 0
}
function snapshotCounters() {
    const total = COUNTED.reduce((s, n) => s + counters[n], 0)
    return {...counters, total}
}

async function timeStage(fn, repeats = 3) {
    await fn()                       // 预热（丢弃）
    let fs = null
    let extra = null
    let best = Infinity
    for (let i = 0; i < repeats; i++) {
        resetCounters()
        const t0 = performance.now()
        extra = await fn()
        const t1 = performance.now()
        fs = snapshotCounters()
        best = Math.min(best, t1 - t0)
    }
    return {fs, ms: +best.toFixed(2), extra}
}

// ─── 真实模块加载（extensions.ts → .mts） ────────────────────
const TMP_DIR = path.join(__dirname, '.tmp-bench')
fsSync.mkdirSync(TMP_DIR, {recursive: true})
const EXT_SRC = path.join(ROOT, 'src', 'main', 'agent', 'skills', 'extensions.ts')
const EXT_MTS = path.join(TMP_DIR, 'extensions.mts')
// ESM 内建命名空间不会反映对 fs/promises 模块对象的 monkey-patch，
// 故在复制源码时把 fs 绑定替换为全局注入的「已插桩」实例，算法本身保持逐字节不变。
const extSource = fsSync.readFileSync(EXT_SRC, 'utf-8')
    .replace("import * as fs from 'fs/promises'", 'const fs = globalThis.__hclawBenchFsp')
globalThis.__hclawBenchFsp = fsp
fsSync.writeFileSync(EXT_MTS, extSource, 'utf-8')
const extModule = await import(new URL(`file://${EXT_MTS.replace(/\\/g, '/')}`).href)
const realScanSkillExtensions = extModule.scanSkillExtensions

// ─── 旧实现（基线等价复刻，逐行对齐改动前的 extensions.ts） ──
const SCRIPT_EXTENSIONS = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.py': 'python', '.sh': 'bash', '.ps1': 'other', '.bash': 'bash',
}

async function legacyWalkDir(dir, excludeDirs = []) {
    const excluded = new Set(excludeDirs)
    const results = []
    const walk = async (current) => {
        try {
            for (const entry of await fsp.readdir(current, {withFileTypes: true})) {
                const full = path.join(current, entry.name)
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && !excluded.has(entry.name)) await walk(full)
                else if (entry.isFile()) results.push(full)
            }
        } catch { /* 忽略读取失败 */ }
    }
    await walk(dir)
    return results
}

async function legacyScanExtDir(skillDir, subDir, filter, map, excludeDirs = []) {
    const fullDir = path.join(skillDir, subDir)
    try {
        await fsp.access(fullDir)
    } catch {
        return []
    }
    const files = await legacyWalkDir(fullDir, excludeDirs)
    return files.filter(f => filter(path.extname(f).toLowerCase())).map(f => map(f, path.relative(skillDir, f)))
}

const legacyInferCategory = (relPath) => {
    const parts = relPath.replace(/\\/g, '/').split('/')
    return parts.length > 2 ? parts[1] : undefined
}

async function legacyScanSkillExtensions(skillDir) {
    try {
        await fsp.access(skillDir)
    } catch {
        return {references: [], scripts: []}
    }
    const [references, scripts, rootDocs] = await Promise.all([
        legacyScanExtDir(skillDir, 'references', e => e === '.md' || e === '.txt', (f, rel) => ({
            name: path.basename(f, path.extname(f)), filePath: rel, category: legacyInferCategory(rel),
        })),
        legacyScanExtDir(skillDir, 'scripts', e => e in SCRIPT_EXTENSIONS, (f, rel) => ({
            name: path.basename(f), filePath: rel, language: SCRIPT_EXTENSIONS[path.extname(f).toLowerCase()],
        })),
        legacyScanExtDir(skillDir, '', e => e === '.md' || e in SCRIPT_EXTENSIONS, (f, rel) => ({
            name: path.basename(f), filePath: rel, language: SCRIPT_EXTENSIONS[path.extname(f).toLowerCase()] ?? 'other',
        }), ['references', 'scripts']),
    ])
    return {references, scripts, rootDocs}
}

const IMPLS = {
    legacy: legacyScanSkillExtensions,
    current: realScanSkillExtensions,
}

// ─── agentLoader 等价复刻 ───────────────────────────────────
const SUPPORTED_EXTENSIONS = new Set(['.md'])
const SKIPPED_FILES = new Set(['readme.md', 'contributing.md', 'contributing_zh-cn.md', 'license', 'executive-brief.md', 'quickstart.md', 'agents.md', 'readme', 'skill.md'])
const SKIPPED_DIRS = new Set(['.git', '.github', 'scripts', 'node_modules', 'docs', 'tests', 'schemas', 'site', 'reference', 'references'])

async function agentWalkDir(dir) {
    const results = []
    async function walk(currentDir) {
        try {
            await fsp.access(currentDir)
        } catch {
            return
        }
        const entries = await fsp.readdir(currentDir, {withFileTypes: true})
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (SKIPPED_DIRS.has(entry.name)) continue
                await walk(path.join(currentDir, entry.name))
            } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                const fullPath = path.join(currentDir, entry.name)
                results.push({filePath: fullPath, relativePath: path.relative(dir, fullPath)})
            }
        }
    }
    await walk(dir)
    return results
}

function shouldSkipFile(filePath, relativePath) {
    const baseName = path.basename(filePath).toLowerCase()
    if (SKIPPED_FILES.has(baseName)) return true
    if (path.parse(filePath).name.toLowerCase() === 'skill') return true
    if (relativePath.startsWith('scripts' + path.sep) || relativePath.startsWith('scripts/')) return true
    return false
}

async function scanAgentDirectory(dir) {
    const templates = []
    try {
        const files = await agentWalkDir(dir)
        for (const {filePath, relativePath} of files) {
            if (shouldSkipFile(filePath, relativePath)) continue
            try {
                const content = await fsp.readFile(filePath, 'utf-8')
                const ext = path.extname(filePath).toLowerCase()
                if (ext === '.md' && !content.startsWith('---')) continue
                // YAML 解析为纯 CPU，无 fs 调用，度量中省略
                templates.push({filePath, relativePath})
            } catch { /* 忽略读取失败 */ }
        }
    } catch { /* 忽略读取失败 */ }
    return templates
}

async function getPluginAgentDirs(pluginPath) {
    const dirs = []
    try {
        const entries = await fsp.readdir(pluginPath, {withFileTypes: true})
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            if (SKIPPED_DIRS.has(entry.name)) continue
            if (!/agent/i.test(entry.name)) continue
            if (entry.name.startsWith('.') && entry.name !== '.agents') continue
            dirs.push({dir: path.join(pluginPath, entry.name), prefix: `${entry.name}/`})
        }
    } catch { /* 忽略读取失败 */ }
    return dirs
}

async function scanAgentsFromPlugin(pluginName) {
    const pluginPath = path.join(PLUGINS_DIR, pluginName)
    const agentDirs = await getPluginAgentDirs(pluginPath)
    const templates = []
    for (const {dir} of agentDirs) templates.push(...await scanAgentDirectory(dir))
    return {templates, sourceDir: pluginPath}
}

async function scanAgentsFromPlugins() {
    try {
        await fsp.access(PLUGINS_DIR)
    } catch {
        return []
    }
    const entries = await fsp.readdir(PLUGINS_DIR, {withFileTypes: true})
    const results = await Promise.all(entries.filter(e => e.isDirectory()).map(e => scanAgentsFromPlugin(e.name)))
    return results.filter(r => r.templates.length > 0)
}

async function scanAllAgents() {
    const all = []
    if (fsSync.existsSync(AGENTS_DIR)) all.push(...await scanAgentDirectory(AGENTS_DIR))
    const pluginResults = await scanAgentsFromPlugins()
    all.push(...pluginResults.flatMap(r => r.templates))
    return all
}

// ─── skills loader 等价复刻 ─────────────────────────────────
const SKILL_FILE = 'SKILL.md'
const SKIP_DIRS = new Set(['docs', 'tests', 'node_modules', '.git', '.github', 'schemas', 'scripts', 'site'])

async function findPluginSkillDirs(pluginPath) {
    const skillDirs = []
    async function walk(dir) {
        try {
            const entries = await fsp.readdir(dir, {withFileTypes: true})
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue
                if (SKIP_DIRS.has(entry.name)) continue
                if (!entry.isDirectory()) continue
                const fullPath = path.join(dir, entry.name)
                const skillFile = path.join(fullPath, SKILL_FILE)
                try {
                    await fsp.access(skillFile)
                    skillDirs.push(fullPath)
                } catch {
                    await walk(fullPath)
                }
            }
        } catch { /* 忽略读取失败 */ }
    }
    await walk(pluginPath)
    return skillDirs
}

async function loadSkillsFromPath(dir, source, basePath, scanFn) {
    let loaded = 0
    const base = basePath || dir
    try {
        const entries = await fsp.readdir(dir, {withFileTypes: true})
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.name.startsWith('.')) continue
            if (entry.isFile()) {
                if (entry.name === SKILL_FILE) {
                    try {
                        await fsp.readFile(fullPath, 'utf-8')
                        await scanFn(dir)
                        loaded++
                    } catch { /* 忽略读取失败 */ }
                }
                continue
            }
            if (entry.isDirectory()) {
                const skillFile = path.join(fullPath, SKILL_FILE)
                try {
                    await fsp.access(skillFile)
                } catch {
                    loaded += await loadSkillsFromPath(fullPath, source, base, scanFn)
                    continue
                }
                try {
                    await fsp.readFile(skillFile, 'utf-8')
                    await scanFn(fullPath)
                    loaded++
                } catch { /* 忽略读取失败 */ }
            }
        }
    } catch { /* 忽略读取失败 */ }
    return loaded
}

async function loadBuiltinSkills(scanFn) {
    const candidates = [path.join(ROOT, 'src', 'main', 'defaults', 'skills')]
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'defaults', 'skills'))
    for (const dir of candidates) {
        try {
            await fsp.access(dir)
            const count = await loadSkillsFromPath(dir, 'builtin', undefined, scanFn)
            if (count > 0) return count
        } catch { /* 忽略读取失败 */ }
    }
    return 0
}

async function loadSkillsFromDirectory(scanFn, skillsDir) {
    const baseDir = skillsDir || path.join(HCLAW_DIR, 'skills')
    let loaded = 0
    const publicDir = path.join(baseDir, 'public')
    if (fsSync.existsSync(publicDir)) loaded += await loadSkillsFromPath(publicDir, 'user', undefined, scanFn)
    const customDir = path.join(baseDir, 'custom')
    if (fsSync.existsSync(customDir)) loaded += await loadSkillsFromPath(customDir, 'user', undefined, scanFn)
    if (fsSync.existsSync(HOME_AGENTS_SKILLS_DIR)) loaded += await loadSkillsFromPath(HOME_AGENTS_SKILLS_DIR, 'user', undefined, scanFn)
    loaded += await loadBuiltinSkills(scanFn)
    return loaded
}

async function loadSkillsFromPlugins(scanFn) {
    try {
        await fsp.access(PLUGINS_DIR)
    } catch {
        return 0
    }
    let loaded = 0
    try {
        const entries = await fsp.readdir(PLUGINS_DIR, {withFileTypes: true})
        const pluginDirs = entries.filter(e => e.isDirectory())
        const results = await Promise.all(pluginDirs.map(async (entry) => {
            const pluginPath = path.join(PLUGINS_DIR, entry.name)
            const skillDirs = await findPluginSkillDirs(pluginPath)
            if (skillDirs.length === 0) return 0
            let n = 0
            for (const skillDir of skillDirs) {
                try {
                    await fsp.readFile(path.join(skillDir, SKILL_FILE), 'utf-8')
                    await scanFn(skillDir)
                    n++
                } catch { /* 忽略读取失败 */ }
            }
            return n
        }))
        loaded = results.reduce((s, c) => s + c, 0)
    } catch { /* 忽略读取失败 */ }
    return loaded
}

// ─── plugin/loader.ts 等价复刻 ──────────────────────────────
async function parseCommands(pluginPath) {
    const commandsDir = path.join(pluginPath, 'commands')
    const commands = []
    try {
        await fsp.access(commandsDir)
    } catch {
        return commands
    }
    const files = await fsp.readdir(commandsDir)
    const mdFiles = files.filter(f => f.endsWith('.md'))
    const results = await Promise.all(mdFiles.map(async (file) => {
        try {
            await fsp.readFile(path.join(commandsDir, file), 'utf-8')
            return file
        } catch {
            return null
        }
    }))
    return results.filter(Boolean)
}

async function parseMcpServers(pluginPath) {
    const mcpPath = path.join(pluginPath, 'mcp', 'servers.json')
    try {
        await fsp.access(mcpPath)
    } catch {
        return []
    }
    try {
        await fsp.readFile(mcpPath, 'utf-8')
        return []
    } catch {
        return []
    }
}

async function loadPlugin(pluginPath) {
    const claudePluginManifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json')
    const rootManifestPath = path.join(pluginPath, 'plugin.json')
    let manifestPath
    try {
        await fsp.access(claudePluginManifestPath)
        manifestPath = claudePluginManifestPath
    } catch {
        try {
            await fsp.access(rootManifestPath)
            manifestPath = rootManifestPath
        } catch {
            throw new Error('no manifest')
        }
    }
    await fsp.readFile(manifestPath, 'utf-8')
    const commands = await parseCommands(pluginPath)
    await parseMcpServers(pluginPath)
    return {commands}
}

async function loadAllPlugins(pluginsDir) {
    try {
        await fsp.access(pluginsDir)
    } catch {
        return []
    }
    const entries = await fsp.readdir(pluginsDir, {withFileTypes: true})
    const pluginDirs = entries.filter(e => e.isDirectory())
    const loadPromises = pluginDirs.map(async (entry) => {
        const pluginPath = path.join(pluginsDir, entry.name)
        const claudePluginManifestPath = path.join(pluginPath, '.claude-plugin', 'plugin.json')
        const rootManifestPath = path.join(pluginPath, 'plugin.json')
        let hasManifest = false
        try {
            await fsp.access(claudePluginManifestPath)
            hasManifest = true
        } catch {
            try {
                await fsp.access(rootManifestPath)
                hasManifest = true
            } catch { /* 忽略读取失败 */ }
        }
        if (!hasManifest) return null
        try {
            return await loadPlugin(pluginPath)
        } catch {
            return null
        }
    })
    const results = await Promise.all(loadPromises)
    return results.filter(p => p !== null)
}

// ─── 技能目录枚举（等价性对比用） ───────────────────────────
async function collectSkillDirsUnder(dir) {
    const out = []
    async function walk(d) {
        try {
            const entries = await fsp.readdir(d, {withFileTypes: true})
            for (const e of entries) {
                if (e.name.startsWith('.')) continue
                if (SKIP_DIRS.has(e.name)) continue
                if (!e.isDirectory()) continue
                const full = path.join(d, e.name)
                try {
                    await fsp.access(path.join(full, SKILL_FILE))
                    out.push(full)
                } catch {
                    await walk(full)
                }
            }
        } catch { /* 忽略读取失败 */ }
    }
    await walk(dir)
    return out
}

async function allSkillDirs() {
    const dirs = []
    for (const base of [path.join(HCLAW_DIR, 'skills', 'public'), path.join(HCLAW_DIR, 'skills', 'custom'), HOME_AGENTS_SKILLS_DIR]) {
        if (fsSync.existsSync(base)) dirs.push(...await collectSkillDirsUnder(base))
    }
    for (const p of fsSync.existsSync(PLUGINS_DIR) ? fsSync.readdirSync(PLUGINS_DIR) : []) {
        const pp = path.join(PLUGINS_DIR, p)
        try {
            if (fsSync.statSync(pp).isDirectory()) dirs.push(...await findPluginSkillDirs(pp))
        } catch { /* 忽略读取失败 */ }
    }
    return dirs
}

// ─── 等价性校验 ─────────────────────────────────────────────
function normalize(ext) {
    return {references: ext.references || [], scripts: ext.scripts || [], rootDocs: ext.rootDocs || []}
}

async function verifyEquivalence() {
    const dirs = await allSkillDirs()
    let checked = 0
    const mismatches = []
    for (const dir of dirs) {
        const a = normalize(await legacyScanSkillExtensions(dir))
        const b = normalize(await realScanSkillExtensions(dir))
        checked++
        const ja = JSON.stringify(a)
        const jb = JSON.stringify(b)
        if (ja !== jb) {
            mismatches.push({
                dir,
                references: a.references.length === b.references.length ? 'ok' : `${a.references.length}->${b.references.length}`,
                scripts: a.scripts.length === b.scripts.length ? 'ok' : `${a.scripts.length}->${b.scripts.length}`,
                rootDocs: a.rootDocs.length === b.rootDocs.length ? 'ok' : `${a.rootDocs.length}->${b.rootDocs.length}`,
                detail: ja === jb ? '' : 'diff',
            })
        }
    }
    return {checkedDirs: checked, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 10)}
}

// ─── 主流程 ─────────────────────────────────────────────────
const report = {env: {hclawDir: HCLAW_DIR, node: process.version}}

// 静态阶段（与 extensions 优化无关）
report.agents = await timeStage(async () => ({count: (await scanAllAgents()).length}))
report.plugins = await timeStage(async () => ({count: (await loadAllPlugins(PLUGINS_DIR)).length}))

// skills 阶段：分别用 legacy / current 两种 scanSkillExtensions
report.skillsDir = {}
report.skillsPlugins = {}
for (const impl of ['legacy', 'current']) {
    const scanFn = IMPLS[impl]
    report.skillsDir[impl] = await timeStage(async () => ({count: await loadSkillsFromDirectory(scanFn)}))
    report.skillsPlugins[impl] = await timeStage(async () => ({count: await loadSkillsFromPlugins(scanFn)}))
}

// extensions 单模块：全部技能目录累计
report.extensions = {}
const sampleDirs = await allSkillDirs()
for (const impl of ['legacy', 'current']) {
    const scanFn = IMPLS[impl]
    resetCounters()
    const t0 = performance.now()
    for (const d of sampleDirs) await scanFn(d)
    const t1 = performance.now()
    report.extensions[impl] = {dirs: sampleDirs.length, fs: snapshotCounters(), ms: +(t1 - t0).toFixed(2)}
}

report.equivalence = await verifyEquivalence()

console.log(JSON.stringify(report, null, 2))

// 清理临时产物
try { fsSync.rmSync(TMP_DIR, {recursive: true, force: true}) } catch { /* 忽略读取失败 */ }
