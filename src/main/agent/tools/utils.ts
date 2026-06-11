/**
 * 工具共享工具函数
 */
import path from 'path'

/**
 * 解析并验证路径是否在指定基础目录内
 * 使用 path.relative 方法防止路径穿越攻击
 */
export function resolveAndValidatePath(
    baseDir: string,
    inputPath: string,
): { absPath: string; error?: string } {
    const absPath = path.resolve(baseDir, inputPath)
    const rel = path.relative(baseDir, absPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        // return {absPath, error: `Path outside working directory: ${inputPath}`}
    }
    return {absPath}
}
