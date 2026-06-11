import React, {useEffect, useState} from 'react'
import type {ChannelUI} from '../../stores/channelStore'

interface Props {
  channel: ChannelUI
  onClose: () => void
  onSave: (config: Record<string, any>) => Promise<void>
}

const CONFIG_FIELDS: Record<string, Array<{
  key: string; label: string; type: 'text' | 'password' | 'select'
  options?: {value: string; label: string}[]
  placeholder?: string
}>> = {
  feishu: [
    {key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_xxxxxxxxxxxx'},
    {key: 'appSecret', label: 'App Secret', type: 'password'},
  ],
  wechat: [
    {key: 'note', label: '对接方式', type: 'text',
      placeholder: '使用 weixin-agent-sdk 扫码登录，启动后自动配置'},
  ],
}

export default function ChannelEditModal({channel, onClose, onSave}: Props) {
  const [config, setConfig] = useState<Record<string, any>>({...channel.config})
  const [saving, setSaving] = useState(false)
  const fields = CONFIG_FIELDS[channel.type] || []

  // 按 ESC 关闭弹窗
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  const handleSave = async () => {
    setSaving(true)
    try { await onSave(config) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="bg-[var(--bg-primary)] rounded-lg shadow-xl border border-[var(--border)]
        w-96 max-h-[80vh] overflow-y-auto p-4 space-y-3"
        onClick={e => e.stopPropagation()}>

        <div className="font-medium text-sm">{channel.name} 配置</div>

        {fields.map(f => (
          <div key={f.key}>
            <label className="block text-xs text-[var(--text-secondary)] mb-1">{f.label}</label>
            {f.type === 'select' ? (
              <select value={config[f.key] || ''}
                onChange={e => setConfig({...config, [f.key]: e.target.value})}
                className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)]
                  bg-[var(--bg-primary)] text-[var(--text-primary)]">
                {f.options?.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : (
              <input type={f.type}
                value={config[f.key] || ''}
                placeholder={f.placeholder}
                onChange={e => setConfig({...config, [f.key]: e.target.value})}
                className="w-full px-2 py-1.5 text-xs rounded border border-[var(--border)]
                  bg-[var(--bg-primary)] text-[var(--text-primary)]"/>
            )}
          </div>
        ))}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-[var(--border)]
              hover:bg-[var(--bg-secondary)]">
            取消
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-3 py-1.5 text-xs rounded bg-[var(--accent)] text-white
              hover:opacity-90 disabled:opacity-50">
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  )
}
