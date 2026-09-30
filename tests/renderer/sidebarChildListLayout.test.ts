/**
 * 子会话列表容器（child-list）宽度契约
 *
 * 根因（2026-09-30 实测复现）：`child-list` 一旦用 `items-start`，flex column 的
 * cross-axis 起点对齐会让子项宽度退化为 fit-content —— Chrome 实测取到的是内容
 * max-content（子会话行长标题把行撑到 418/506px，而侧栏仅 220px），行内 ChatItem 的
 * `flex-1 min-w-0 truncate` 链条整体失效：标题不截断、行尾时间/运行指示器被推出侧栏。
 * 默认 stretch 才能让行宽受容器约束（实测行宽 180px、标题截断、行尾元素可见）。
 *
 * 同类手法（源码级契约断言）见 borderSystem.test.ts / tokenCompliance.*.test.ts。
 * jsdom 无布局引擎，无法直接断言几何 —— 故把「容器必须让子项撑满」这一因固化为源码断言。
 */

import {describe, expect, it} from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SIDEBAR_SRC = path.resolve(__dirname, '../../src/renderer/components/ConversationSidebar.tsx')

describe('子会话列表容器宽度契约（child-list）', () => {
    it('child-list 必须是 flex-col 且不得含 items-start', () => {
        const src = fs.readFileSync(SIDEBAR_SRC, 'utf-8')
        const declLines = src.split('\n').filter(line => line.includes('data-name="child-list"'))

        expect(declLines).toHaveLength(1)
        const decl = declLines[0]
        expect(decl).toContain('flex-col')
        expect(decl).not.toContain('items-start')
    })
})
