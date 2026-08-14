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

/** 递归遍历目录（跳过隐藏目录、node_modules 与 excludeDirs） */
const walkDir = async (dir: string, excludeDirs: string[] = []): Promise<string[]> => {
    const excluded = new Set(excludeDirs)
    const results: string[] = []
    const walk = async (current: string): Promise<void> => {
        try {
            for (const entry of await fs.readdir(current, {withFileTypes: true})) {
                const full = path.join(current, entry.name)
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && !excluded.has(entry.name)) await walk(full)
                else if (entry.isFile()) results.push(full)
            }
        } catch {
            // 目录读取失败（无权限/已删除）时跳过
        }
    }
    await walk(dir)
    return results
}

/** 扫描单个扩展目录（excludeDirs：递归时排除的子目录名，用于根部辅助文件扫描避免与 references/scripts 重复） */
const scanExtDir = async <T>(
    skillDir: string,
    subDir: string,
    filter: (ext: string) => boolean,
    map: (filePath: string, relPath: string) => T,
    excludeDirs: string[] = []
): Promise<T[]> => {
    const fullDir = path.join(skillDir, subDir)
    try {
        await fs.access(fullDir)
    } catch {
        return []
    }
    const files = await walkDir(fullDir, excludeDirs)
    return files
        .filter(f => filter(path.extname(f).toLowerCase()))
        .map(f => map(f, path.relative(skillDir, f)))
}

/** 从路径推断分类 */
const inferCategory = (relPath: string): string | undefined => {
    const parts = relPath.replace(/\\/g, '/').split('/')
    return parts.length > 2 ? parts[1] : undefined
}

export async function scanSkillExtensions(skillDir: string): Promise<SkillExtensions> {
    try {
        await fs.access(skillDir)
    } catch {
        return {references: [], scripts: []}
    }
    const [references, scripts, rootDocs] = await Promise.all([
        scanExtDir<SkillReference>(skillDir, 'references', e => e === '.md' || e === '.txt', (f, rel) => ({
            name: path.basename(f, path.extname(f)),
            filePath: rel,
            category: inferCategory(rel),
        })),
        scanExtDir<SkillScript>(skillDir, 'scripts', e => e in SCRIPT_EXTENSIONS, (f, rel) => ({
            name: path.basename(f),
            filePath: rel,
            language: SCRIPT_EXTENSIONS[path.extname(f).toLowerCase()],
        })),
        scanExtDir<SkillScript>(skillDir, '', e => e === '.md' || e in SCRIPT_EXTENSIONS, (f, rel) => ({
            name: path.basename(f),
            filePath: rel,
            language: SCRIPT_EXTENSIONS[path.extname(f).toLowerCase()] ?? 'other',
        }), ['references', 'scripts']),
    ])
    return {references, scripts}
}

export const getSupportedScriptExtensions = (): string[] => Object.keys(SCRIPT_EXTENSIONS)
export const isSupportedScript = (filename: string): boolean => path.extname(filename).toLowerCase() in SCRIPT_EXTENSIONS
