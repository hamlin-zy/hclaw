import * as fs from 'fs'
import * as path from 'path'
import {getHclawDir, isSafePath} from '../../config'

// ─── 校验工具 ──────────────────────────────────────

/** 校验有效的配置键名（可含路径分隔符如 archives/my-agent） */
function isValidName(name: unknown): name is string {
    return typeof name === 'string' && name.length > 0 && /^[\w\-./]+$/.test(name)
}

/** 校验有效的文件名（含 .json 后缀） */
function isValidFilename(filename: unknown): filename is string {
    return typeof filename === 'string' && filename.length > 0 && /^[\w\-./]+\.json$/.test(filename)
}

/** 校验有效的目录名 */
function isValidDir(dir: unknown): dir is string {
    return typeof dir === 'string' && dir.length > 0 && /^[\w\-./]+$/.test(dir)
}

/** 构建路径并做安全检查 */
function resolvePath(...segments: string[]): { fullPath: string; safe: boolean } {
    const fullPath = path.join(getHclawDir(), ...segments)
    return {fullPath, safe: isSafePath(fullPath)}
}

import {createQueryLogger} from './queryLogger'

const logQuery = createQueryLogger('FileConfigRepository')

function warn(prefix: string, msg: string, ...args: unknown[]): void {
    console.error(`[FileConfigRepository.${prefix}] ${msg}`, ...args)
}

// ─── 核心类 ────────────────────────────────────────

export class FileConfigRepository {
    async read<T = unknown>(name: string): Promise<T | null> {
        if (!isValidName(name)) {
            warn('read', `invalid name: ${name}`);
            return null
        }
        const start = Date.now()
        const {fullPath: filePath, safe} = resolvePath(`${name}.json`)
        if (!safe) {
            warn('read', `unsafe path: ${name}`);
            return null
        }
        const data = this._readFile<T>(filePath)
        logQuery('read', start, data !== null ? undefined : 'not-found')
        return data
    }

    async write<T = unknown>(name: string, data: T): Promise<boolean> {
        if (!isValidName(name)) {
            warn('write', `invalid name: ${name}`);
            return false
        }
        const start = Date.now()
        const {fullPath: filePath, safe} = resolvePath(`${name}.json`)
        if (!safe) {
            warn('write', `unsafe path: ${name}`);
            return false
        }
        if (!this._writeFile(filePath, data)) {
            warn('write', `write failed: ${name}`);
            return false
        }
        logQuery('write', start)
        return true
    }

    async readDir<T = unknown>(dir: string, filename: string): Promise<T | null> {
        if (!isValidDir(dir) || !isValidFilename(filename)) {
            warn('readDir', 'invalid params');
            return null
        }
        const start = Date.now()
        const {fullPath: filePath, safe} = resolvePath(dir, filename)
        if (!safe) {
            warn('readDir', `unsafe path: ${dir}/${filename}`);
            return null
        }
        const data = this._readFile<T>(filePath)
        logQuery('readDir', start, data !== null ? undefined : 'not-found')
        return data
    }

    async writeDir(dir: string, filename: string, data: unknown): Promise<boolean> {
        if (!isValidDir(dir) || !isValidFilename(filename)) {
            warn('writeDir', 'invalid params');
            return false
        }
        const start = Date.now()
        const {fullPath: dirPath, safe} = resolvePath(dir)
        if (!safe) {
            warn('writeDir', `unsafe dir: ${dir}`);
            return false
        }
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, {recursive: true})
        const filePath = path.join(dirPath, filename)
        if (!isSafePath(filePath)) {
            warn('writeDir', `unsafe path: ${dir}/${filename}`);
            return false
        }
        if (!this._writeFile(filePath, data)) {
            warn('writeDir', `write failed: ${dir}/${filename}`);
            return false
        }
        logQuery('writeDir', start)
        return true
    }

    async listDir(dir: string): Promise<Array<{ _filename: string } & Record<string, unknown>>> {
        if (!isValidDir(dir)) {
            warn('listDir', 'invalid dir param');
            return []
        }
        const start = Date.now()
        const {fullPath: dirPath, safe} = resolvePath(dir)
        if (!safe) {
            warn('listDir', `unsafe path: ${dir}`);
            return []
        }
        if (!fs.existsSync(dirPath)) return []
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'))
        const result = files.map(filename => {
            const data = this._readFile<Record<string, unknown>>(path.join(dirPath, filename))
            return data ? {_filename: filename, ...data} : null
        }).filter((item): item is NonNullable<typeof item> => item !== null)
        logQuery('listDir', start, `${result.length} files`)
        return result
    }

    async deleteDir(dir: string, filename: string): Promise<boolean> {
        if (!isValidDir(dir) || !isValidFilename(filename)) {
            warn('deleteDir', 'invalid params');
            return false
        }
        const start = Date.now()
        const {fullPath: filePath, safe} = resolvePath(dir, filename)
        if (!safe) {
            warn('deleteDir', `unsafe path: ${dir}/${filename}`);
            return false
        }
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
        logQuery('deleteDir', start)
        return true
    }

    // ─── 私有辅助 ─────────────────────────────────

    private _readFile<T>(filePath: string): T | null {
        try {
            return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T : null
        } catch {
            return null
        }
    }

    private _writeFile(filePath: string, data: unknown): boolean {
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
            return true
        } catch {
            return false
        }
    }
}
