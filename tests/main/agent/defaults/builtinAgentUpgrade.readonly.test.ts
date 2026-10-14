import {describe, expect, it} from 'vitest'
import {runMigrations} from '@/main/agent/defaults/builtinAgentUpgrade'

const FM = (body: string) => `---\nname: Explore Agent\ntools: [glob, grep]\ndisallowedTools: [agent]\n---\n${body}`

describe('explore.md readOnly 迁移', () => {
    it('frontmatter 无 readOnly → 追加 readOnly: true', () => {
        const r = runMigrations('explore.md', FM('正文'))
        expect(r.applied).toContain('explore-readonly-flag')
        expect(r.content).toMatch(/readOnly:\s*true/)
    })

    it('已有 readOnly: true → noop（幂等）', () => {
        const content = `---\nname: X\nreadOnly: true\n---\n正文`
        const r = runMigrations('explore.md', content)
        expect(r.applied).not.toContain('explore-readonly-flag')
        expect(r.content).toBe(content)
    })

    it('code-reviewer.md 同样迁移', () => {
        const r = runMigrations('code-reviewer.md', `---\nname: Code Reviewer Agent\n---\n正文`)
        expect(r.applied).toContain('code-reviewer-readonly-flag')
    })
})
