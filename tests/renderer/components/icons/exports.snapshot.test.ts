import { describe, it, expect } from 'vitest'
import * as icons from '@/renderer/components/icons'

describe('icons 导出面', () => {
    it('导出名集合稳定（C14 简化不得增删导出）', () => {
        expect(Object.keys(icons).sort()).toMatchSnapshot()
    })
})
