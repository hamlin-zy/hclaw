// 失效测试扫描：产出「已知假绿」清单（设计文档 §6.4）
// 用法: node scripts/audit-stale-tests.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const TESTS = path.join(ROOT, 'tests')

function walk(dir, out = []) {
    for (const e of readdirSync(dir)) {
        const p = path.join(dir, e)
        if (statSync(p).isDirectory()) walk(p, out)
        else if (/\.(ts|tsx|mjs)$/.test(e)) out.push(p)
    }
    return out
}

/** 读取 JSONC（tsconfig 含 // 注释与尾逗号），无需外部依赖。
 *  逐字符扫描以尊重字符串字面量，避免误删 "src/*" 之类的路径。 */
function readJsonc(p) {
    const raw = readFileSync(p, 'utf8')
    let out = ''
    let inStr = false, esc = false, lineC = false, blockC = false
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i], n = raw[i + 1]
        if (lineC) { if (c === '\n') { lineC = false; out += c } continue }
        if (blockC) { if (c === '*' && n === '/') { blockC = false; i++ } continue }
        if (inStr) {
            out += c
            if (esc) esc = false
            else if (c === '\\') esc = true
            else if (c === '"') inStr = false
            continue
        }
        if (c === '"') { inStr = true; out += c; continue }
        if (c === '/' && n === '/') { lineC = true; i++; continue }
        if (c === '/' && n === '*') { blockC = true; i++; continue }
        out += c
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const tsconfig = readJsonc(path.join(ROOT, 'tsconfig.json'))
const paths = tsconfig.compilerOptions?.paths || {}
const aliasToDir = {}
for (const [k, v] of Object.entries(paths)) {
    const key = k.replace(/\/\*$/, '')
    const val = String(v[0]).replace(/\/\*$/, '')
    aliasToDir[key] = path.join(ROOT, val)
}

/** 把 import specifier 解析为磁盘上的候选路径（不含扩展名） */
function resolveSpec(spec, fromFile) {
    let base = null
    for (const [alias, dir] of Object.entries(aliasToDir)) {
        if (spec === alias || spec.startsWith(alias + '/')) {
            base = path.join(dir, spec.slice(alias.length).replace(/^\//, ''))
            break
        }
    }
    if (!base) {
        if (!spec.startsWith('.')) return []            // 裸包名，交给 node_modules
        base = path.resolve(path.dirname(fromFile), spec)
    }
    return ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx']
        .map(ext => base + ext)
}

const hits = { mockUnresolved: [], tautology: [] }

for (const file of walk(TESTS)) {
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')

    // 规则①: vi.mock 目标解析不到实体
    for (const m of src.matchAll(/vi\.mock\(\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]
        const cands = resolveSpec(spec, file)
        const ok = cands.length === 0 || cands.some(c => existsSync(c))
        if (!ok) {
            const line = src.slice(0, m.index).split('\n').length
            hits.mockUnresolved.push({
                file: path.relative(ROOT, file).replace(/\\/g, '/'), line, spec,
                tried: cands.map(c => path.relative(ROOT, c).replace(/\\/g, '/')),
            })
        }
    }

    // 规则②: 恒真断言
    lines.forEach((l, i) => {
        if (/expect\(\s*(true|1|'[^']*'|"[^"]*")\s*\)\s*\.\s*toBe\(\s*\1\s*\)/.test(l)
            || /expect\(\s*(true|1)\s*\)\s*\.\s*toBeTruthy\(\)/.test(l)) {
            hits.tautology.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line: i + 1, text: l.trim() })
        }
    })
}

const out = []
out.push('# 已知假绿清单（Phase 0.4 产出）', '')
out.push('> 规则③「断言引用的符号在 src 中已不存在」由 `npx tsc --noEmit` 覆盖（tsconfig include 含 tests/**），不在此重复。', '')
out.push(`## 规则① vi.mock 目标解析不到实体（${hits.mockUnresolved.length}）`, '')
for (const h of hits.mockUnresolved) {
    out.push(`- \`${h.file}:${h.line}\` → \`${h.spec}\``)
    out.push(`  - 试过：${h.tried.slice(0, 3).join(' , ')}`)
}
out.push('', `## 规则② 恒真断言（${hits.tautology.length}）`, '')
for (const h of hits.tautology) out.push(`- \`${h.file}:${h.line}\` — \`${h.text}\``)
out.push('')

mkdirSync(path.join(ROOT, 'tmp'), { recursive: true })
writeFileSync(path.join(ROOT, 'tmp/stale-tests.md'), out.join('\n'), 'utf8')
console.log(out.join('\n'))
