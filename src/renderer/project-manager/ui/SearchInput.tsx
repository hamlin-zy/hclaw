// 带搜索图标的输入框 + 清除按钮（spec §4）
// onSubmit 为显式触发：Enter 或点击提交按钮。不做输入即过滤——Commit 过滤要走 IPC 重拉 git log。
import React from 'react'
import {Search, X} from 'lucide-react'

interface SearchInputProps {
  value: string
  onChange: (v: string) => void
  placeholder: string
  ariaLabel: string
  /** 传入才渲染提交按钮；Enter 也只在传入时生效 */
  onSubmit?: () => void
  /** 提交按钮的可访问名，默认「搜索」 */
  submitLabel?: string
  testId?: string
}

export function SearchInput({value, onChange, placeholder, ariaLabel, onSubmit, submitLabel = '搜索', testId}: SearchInputProps) {
  return (
    /* 焦点环由圆角外壳 .pm-search（radius 4px）承担：内层 .pm-search-input 是 globals.css 里的
       隐形 input（background: transparent; border: 0），radius=0 会把 INPUT_FOCUS 的 ring
       渲染成直角描边并溢出圆角外壳（与 CapabilityPicker 同型）。契约豁免见 inputFocusSeam.test.ts。 */
    <div className="pm-search focus-within:ring-1 focus-within:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]" data-testid={testId}>
      <Search className="pm-search-icon" size={12} aria-hidden="true" />
      <input
        className="pm-search-input"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onSubmit?.()
        }}
      />
      {value !== '' && (
        <button type="button" className="pm-search-clear" aria-label="清除" onClick={() => onChange('')}>
          <X size={12} aria-hidden="true" />
        </button>
      )}
      {onSubmit && (
        <button type="button" className="pm-search-submit" aria-label={submitLabel} onClick={onSubmit}>
          <Search size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
