// @vitest-environment jsdom
/**
 * UpdateNoticeDialog 变更内容展示测试
 *
 * 覆盖（Task 4）：
 * 1. 最新条目 title / tag 可见
 * 2. 跨版本时头部版本行显示范围文案（「跨越 N 个版本」）
 * 3. 旧版本 items 默认收起（不可见）
 * 4. 点击旧版本行后 items 展开
 * 5. 单版本时头部版本行保持 v{latestVersion}，且不渲染折叠区
 * 6. changelog 为空时不渲染展示区（防御）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { UpdateResult } from '@/shared/types/updater'
import { useUpdaterStore } from '@/renderer/stores/updaterStore'
import UpdateNoticeDialog from '@/renderer/components/dialogs/UpdateNoticeDialog'

const multiResult: UpdateResult = {
  status: 'update-available',
  currentVersion: '0.5.16',
  latestVersion: '0.5.18',
  changelog: [
    {
      version: 'v0.5.18',
      date: '2026-09-20',
      tag: '最新',
      title: '会话跳转与稳定性修复',
      items: ['子会话窗口支持加载更多', '修复输出截断'],
    },
    {
      version: 'v0.5.17',
      date: '2026-09-19',
      title: '用户习惯记忆系统',
      items: ['记忆系统上线'],
    },
  ],
  downloads: { github: 'https://github.com/hamlin-zy/hclaw/releases/tag/v0.5.18', baiduPan: 'https://pan.baidu.com/x' },
  checkedAt: 0,
}

const singleResult: UpdateResult = {
  ...multiResult,
  currentVersion: '0.5.17',
  changelog: [multiResult.changelog[0]],
}

const emptyResult: UpdateResult = {
  ...multiResult,
  changelog: [],
}

afterEach(() => {
  cleanup()
  useUpdaterStore.setState({ result: null })
})

describe('UpdateNoticeDialog 变更内容展示', () => {
  it('渲染最新条目 tag 与 title', () => {
    useUpdaterStore.setState({ result: multiResult })
    render(<UpdateNoticeDialog />)

    expect(screen.getByText('会话跳转与稳定性修复')).toBeTruthy()
    expect(screen.getByText('最新')).toBeTruthy()
    expect(screen.getByText('子会话窗口支持加载更多')).toBeTruthy()
  })

  it('跨版本时头部版本行显示范围文案', () => {
    useUpdaterStore.setState({ result: multiResult })
    render(<UpdateNoticeDialog />)

    expect(screen.getByText(/跨越 2 个版本/)).toBeTruthy()
    // 展示区不重复放版本范围行（只出现一处）
    expect(screen.getAllByText(/跨越 2 个版本/).length).toBe(1)
  })

  it('旧版本 items 默认不可见', () => {
    useUpdaterStore.setState({ result: multiResult })
    render(<UpdateNoticeDialog />)

    expect(screen.getByText('v0.5.17')).toBeTruthy()
    expect(screen.queryByText('记忆系统上线')).toBeNull()
  })

  it('点击旧版本行后展开该版本 items', () => {
    useUpdaterStore.setState({ result: multiResult })
    render(<UpdateNoticeDialog />)

    fireEvent.click(screen.getByText('v0.5.17'))
    expect(screen.getByText('记忆系统上线')).toBeTruthy()

    // 再点一次收起
    fireEvent.click(screen.getByText('v0.5.17'))
    expect(screen.queryByText('记忆系统上线')).toBeNull()
  })

  it('单版本时头部显示 v{latestVersion}，不渲染折叠区', () => {
    useUpdaterStore.setState({ result: singleResult })
    render(<UpdateNoticeDialog />)

    expect(screen.getByText('v0.5.18')).toBeTruthy()
    expect(screen.queryByText(/跨越/)).toBeNull()
    expect(document.querySelector('[data-name="update-version-row"]')).toBeNull()
  })

  it('changelog 为空时不渲染展示区', () => {
    useUpdaterStore.setState({ result: emptyResult })
    render(<UpdateNoticeDialog />)

    expect(screen.getByText('v0.5.18')).toBeTruthy()
    expect(screen.queryByText('会话跳转与稳定性修复')).toBeNull()
  })
})
