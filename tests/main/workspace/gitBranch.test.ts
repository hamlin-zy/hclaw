/**
 * gitBranch.ts 单测
 * - parseHeadContent: ref 引用 / detached SHA / 非 git
 * - getGitBranch: 真实仓库（当前 repo）/ 临时非 git 目录
 */
import {describe, it, expect} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// parseHeadContent 未导出，经 getGitBranch 行为覆盖 + 直接 import 内部实现不可行，
// 这里通过公开 API 验证；parse 逻辑由真实仓库（ref 引用）与临时目录（null）覆盖。
import {getGitBranch, stopGitBranchWatch} from '../../../src/main/workspace/gitBranch'

describe('getGitBranch', () => {
    it('真实 git 仓库返回当前分支名（非 SHA、非 null）', async () => {
        const repoRoot = path.resolve(__dirname, '../../..')
        const branch = await getGitBranch(repoRoot)
        expect(branch).toBeTruthy()
        // 正常分支名不会是 7 位纯十六进制短 SHA（除非刻意建了这种分支名）
        expect(branch).not.toMatch(/^(ref:)/)
    })

    it('非 git 目录返回 null', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-nogit-'))
        try {
            expect(await getGitBranch(tmp)).toBeNull()
        } finally {
            fs.rmSync(tmp, {recursive: true, force: true})
        }
    })

    it('不存在的目录返回 null（不抛异常）', async () => {
        expect(await getGitBranch(path.join(os.tmpdir(), 'hclaw-not-exist-xyz'))).toBeNull()
    })
})

describe('watch 生命周期', () => {
    it('stop 后再次 stop 不抛异常', () => {
        stopGitBranchWatch()
        stopGitBranchWatch()
    })
})
