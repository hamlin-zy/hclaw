/**
 * 技能扩展资源扫描器
 *
 * 扫描技能目录，发现 references/ 和 scripts/ 扩展结构。
 * 同时收集技能目录根部的辅助文件（如 superpowers 风格的 .md/.sh/.ts），
 * 使 SKILL.md 正文引用的同目录文件可被 LLM 直接发现。
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import type {SkillExtensions, SkillReference, SkillScript} from '@shared/skillTypes'

const SCRIPT_EXTENSIONS: Record<string, SkillScript['language']> = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.py': 'python', '.sh': 'bash', '.ps1': 'other', '.bash': 'bash',
}

/** 单次遍历的归类目标：技能根 / references 子树 / scripts 子树 */
type WalkMode = 'root' | 'references' | 'scripts'

/** 从路径推断分类 */
const inferCategory = (relPath: string): string | undefined => {
    const parts = relPath.replace(/\\/g, '/').split('/')
    return parts.length > 2 ? parts[1] : undefined
}

/**
 * 扫描技能扩展资源。
 *
 * 仅从技能根做「一次」递归遍历，按路径归类到 references / scripts / 根三类
 * （此前是 references、scripts、技能根三次并行递归 walk）。
 * 归类语义与原实现逐项等价：
 * - references/scripts 列表 = 技能根「一级」同名子树的递归内容（其内部再出现同名目录不特殊处理）；
 * - 根列表 = 技能根其余内容，且任意深度遇到名为 references/scripts 的目录一律整棵跳过；
 * - 隐藏目录与 node_modules 在所有子树中始终跳过；**隐藏文件照收**（与原 walkDir 一致，
 *   其隐藏判定只作用于目录分支）；目录读取失败静默忽略。
 */
export async function scanSkillExtensions(skillDir: string): Promise<SkillExtensions> {
    try {
        await fs.access(skillDir)
    } catch {
        return {references: [], scripts: []}
    }

    const referencePaths: string[] = []
    const scriptPaths: string[] = []
    const rootPaths: string[] = []

    /** depth：当前节点相对技能根的层级，技能根自身为 0、其直接子项为 1 */
    const walk = async (current: string, mode: WalkMode, depth: number): Promise<void> => {
        // 目录读取失败（无权限/已删除）时跳过
        const entries = await fs.readdir(current, {withFileTypes: true}).catch(() => null)
        if (!entries) return
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                // 隐藏目录与 node_modules 在所有子树中始终跳过（原 walkDir 语义）
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
                if (mode === 'root') {
                    const isExtDir = entry.name === 'references' || entry.name === 'scripts'
                    if (isExtDir) {
                        // 仅技能根的一级同名子目录分流（此时 depth 为当前节点层级，技能根为 0）；
                        // 更深层的同名目录与原 excludeDirs 语义一致，整棵跳过
                        if (depth === 0) await walk(full, entry.name as WalkMode, depth + 1)
                    } else {
                        await walk(full, 'root', depth + 1)
                    }
                } else {
                    await walk(full, mode, depth + 1)
                }
            } else if (entry.isFile()) {
                if (mode === 'references') referencePaths.push(full)
                else if (mode === 'scripts') scriptPaths.push(full)
                else rootPaths.push(full)
            }
        }
    }

    await walk(skillDir, 'root', 0)

    const references: SkillReference[] = referencePaths
        .filter(f => {
            const ext = path.extname(f).toLowerCase()
            return ext === '.md' || ext === '.txt'
        })
        .map(f => {
            const rel = path.relative(skillDir, f)
            return {
                name: path.basename(f, path.extname(f)),
                filePath: rel,
                category: inferCategory(rel),
            }
        })

    const scripts: SkillScript[] = scriptPaths
        .filter(f => path.extname(f).toLowerCase() in SCRIPT_EXTENSIONS)
        .map(f => ({
            name: path.basename(f),
            filePath: path.relative(skillDir, f),
            language: SCRIPT_EXTENSIONS[path.extname(f).toLowerCase()],
        }))

    const rootDocs: SkillScript[] = rootPaths
        .filter(f => {
            const ext = path.extname(f).toLowerCase()
            return ext === '.md' || ext in SCRIPT_EXTENSIONS
        })
        .map(f => ({
            name: path.basename(f),
            filePath: path.relative(skillDir, f),
            language: SCRIPT_EXTENSIONS[path.extname(f).toLowerCase()] ?? 'other',
        }))

    return {references, scripts, rootDocs}
}

export const getSupportedScriptExtensions = (): string[] => Object.keys(SCRIPT_EXTENSIONS)
export const isSupportedScript = (filename: string): boolean => path.extname(filename).toLowerCase() in SCRIPT_EXTENSIONS
