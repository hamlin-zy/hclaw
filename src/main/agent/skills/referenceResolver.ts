/**
 * 技能引用解析器
 * 
 * 从 SKILL.md 正文中解析 references/ 和 scripts/ 引用，
 * 支持 DeerFlow 风格的 `references/xxx.md` 语法。
 */

import * as fs from 'fs'
import * as path from 'path'
import type {ReferenceRef, ScriptCall} from './types'

// ─── 常量 ──────────────────────────────────────────────

const REF_PATTERN_BACKTICK = /`references\/([^`]+)`/g
const REF_PATTERN_PLAIN = /references\/([^\s,\]\)]+\.md)/gi

const SCRIPT_PATTERNS: Array<{ pattern: RegExp; lang: string }> = [
  {pattern: /\$\s*node\s+\.\/scripts\/([^\s'"]+)(?:\s+'([^']*)')?/g, lang: 'node'},
  {pattern: /\$\s*python\s+\.\/scripts\/([^\s"]+)(?:\s+"([^"]*)")?/g, lang: 'python'},
  {pattern: /\$\s*(?:bash\s+)?\.\/scripts\/([^\s'"]+)/g, lang: 'bash'},
  {pattern: /^\s*\.\/scripts\/([^\s'"]+)/gm, lang: 'bash'},
]

// ─── 目录遍历 ─────────────────────────────────────────

const walkDirSync = (dir: string): string[] => {
    const results: string[] = []
    const walk = (current: string): void => {
        try {
            for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
                const full = path.join(current, entry.name)
                if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full)
                else if (entry.isFile()) results.push(full)
            }
        } catch {
        }
    }
    walk(dir)
    return results
}

// ─── 引用解析 ─────────────────────────────────────────

export function extractReferences(content: string): ReferenceRef[] {
  const refs: ReferenceRef[] = []
  const seen = new Set<string>()
    const addRef = (refPath: string) => {
        refPath = refPath.trim()
        if (!refPath || seen.has(refPath)) return
    refs.push(parseReferenceSpec(refPath))
    seen.add(refPath)
  }

    let match
    while ((match = REF_PATTERN_BACKTICK.exec(content)) !== null) addRef(match[1])
    REF_PATTERN_PLAIN.lastIndex = 0
    while ((match = REF_PATTERN_PLAIN.exec(content)) !== null) addRef(match[1])
  return refs
}

const parseReferenceSpec = (spec: string): ReferenceRef => {
  const lineMatch = spec.match(/^(.+?)#L(\d+)$/i)
    return lineMatch
        ? {path: lineMatch[1].trim(), line: parseInt(lineMatch[2], 10), loaded: false}
        : {path: spec, loaded: false}
}

// ─── 脚本解析 ─────────────────────────────────────────

export function extractScriptCalls(content: string): ScriptCall[] {
  const calls: ScriptCall[] = []
  const seen = new Set<string>()

    for (const {pattern} of SCRIPT_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(content)) !== null) {
      const scriptName = match[1].trim()
        if (!scriptName || seen.has(scriptName) || !scriptName.match(/\.(js|py|sh|bash)$/i)) continue
        calls.push({script: scriptName, args: match[2]?.trim() || '', raw: match[0]})
      seen.add(scriptName)
    }
  }
  return calls
}

export function parseScriptArgs(argsStr: string): Record<string, unknown> {
  if (!argsStr) return {}
  try {
    let cleaned = argsStr.trim()
      if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
      cleaned = cleaned.slice(1, -1)
    }
    return JSON.parse(cleaned)
  } catch {
    return {input: argsStr.trim()}
  }
}

// ─── 路径解析 ─────────────────────────────────────────

const isValidPath = (spec: string): boolean =>
    !spec.includes('..') && !path.isAbsolute(spec)

const resolvePath = (skillDir: string, refSpec: string, subDir: string): string | null => {
    if (!isValidPath(refSpec)) return null
    const base = path.join(skillDir, subDir)
  const candidates = [
      path.join(base, refSpec),
      path.join(base, refSpec.endsWith('.md') ? refSpec : refSpec + '.md'),
  ]
    return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
}

export const resolveReferencePath = (skillDir: string, refSpec: string): string | null =>
    resolvePath(skillDir, refSpec, 'references') ?? resolvePath(skillDir, refSpec, '')

export const resolveScriptPath = (skillDir: string, scriptName: string): string | null => {
    if (!isValidPath(scriptName)) return null
    const candidates = [path.join(skillDir, 'scripts', scriptName), path.join(skillDir, scriptName)]
    return candidates.find(c => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null
}

// ─── 内容加载 ─────────────────────────────────────────

export function loadReferenceContent(refPath: string, options?: {
  maxLines?: number
  includeToc?: boolean
  extractLine?: number
}): string {
    if (!fs.existsSync(refPath)) throw new Error(`Reference not found: ${refPath}`)

  let content = fs.readFileSync(refPath, 'utf-8')

  if (options?.extractLine) {
    const lines = content.split('\n')
      const start = Math.max(0, options.extractLine - 5)
      const end = Math.min(lines.length, options.extractLine + 20)
    content = lines.slice(start, end).join('\n')
      if (start > 0) content = `... (line ${start}+)\n\n${content}`
      if (end < lines.length) content += `\n\n... (line ${end}-)`
  }

  if (options?.includeToc) {
      const toc = generateToc(content)
      if (toc) content = `${toc}\n\n---\n\n${content}`
  }

  if (options?.maxLines) {
    const lines = content.split('\n')
    if (lines.length > options.maxLines) {
        content = [...lines.slice(0, options.maxLines), '\n...', `\n> **Total ${lines.length} lines, showing first ${options.maxLines}**`].join('\n')
    }
  }

  return content
}

const generateToc = (content: string): string | null => {
    const headings = content.split('\n')
        .map((line, i) => ({...line.match(/^(#{1,6})\s+(.+)/)?.groups, line: i + 1}))
        .filter((h): h is { level: string; text: string; line: number } => !!h)
    if (headings.length < 2) return null

    return ['## Table of Contents', '',
        ...headings.map(h => `${'  '.repeat(h.level.length - 1)}- [${h.text}](#${h.text.toLowerCase().replace(/[^\w]+/g, '-')}) (line ${h.line})`)
    ].join('\n')
}

export const getReferenceInfo = (refPath: string): { size: number; lines: number; description?: string } | null => {
  try {
      if (!fs.existsSync(refPath)) return null
    const stat = fs.statSync(refPath)
      const lines = fs.readFileSync(refPath, 'utf-8').split('\n')
    const firstLine = lines[0]?.trim()
      return {
          size: stat.size,
          lines: lines.length,
          description: firstLine && firstLine !== '---' ? firstLine.replace(/^#+\s*/, '').trim() : undefined
      }
  } catch {
    return null
  }
}

// ─── 工具函数 ─────────────────────────────────────────

export function formatReferenceList(refs: ReferenceRef[]): string {
  if (refs.length === 0) return ''
    return ['### Available References', '',
        ...refs.map(r => `- ${r.loaded ? '✅' : '📄'} \`${r.path}\`${r.line ? ` (line ${r.line})` : ''}`)
    ].join('\n')
}

export function validateReferences(skillDir: string, refs: ReferenceRef[]): {
    valid: ReferenceRef[];
    invalid: string[]
} {
  const valid: ReferenceRef[] = []
  const invalid: string[] = []
  for (const ref of refs) {
      resolveReferencePath(skillDir, ref.path) ? valid.push({
          ...ref,
          content: undefined,
          loaded: false
      }) : invalid.push(ref.path)
  }
  return {valid, invalid}
}

export const referenceExists = (skillDir: string, refName: string): boolean => resolveReferencePath(skillDir, refName) !== null

export function listReferences(skillDir: string): string[] {
    const refDir = path.join(skillDir, 'references')
    if (!fs.existsSync(refDir)) return []
    return walkDirSync(refDir).filter(f => f.endsWith('.md') || f.endsWith('.txt')).map(f => path.relative(refDir, f))
}
