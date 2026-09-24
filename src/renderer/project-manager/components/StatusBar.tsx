import {useState} from 'react'
import {useWorkspaceStore} from '../stores/workspaceStore'
import {useGitStatusStore} from '../stores/gitStatusStore'
import {KeyboardIcon} from '../../components/icons'
import {ShortcutHelpDialog} from '../ui/ShortcutHelpDialog'

export function StatusBar({branchName}: {branchName: string}) {
  const ws = useWorkspaceStore(s => s.workspacePath)
  const summary = useGitStatusStore(s => s.summary)
  const [helpOpen, setHelpOpen] = useState(false)
  const name = ws.split(/[\\/]/).pop()
  return (
    <div className="pm-status-bar">
      <span className="pm-status-bar-path select-text" title={ws}>{name}{branchName && `  ◉ ${branchName}`}</span>
      <span>{summary ? `已更改 ${Object.keys(summary.statusMap).length} 个文件 · +${summary.additions} · −${summary.deletions}` : ''}</span>
      <div className="pm-status-bar-right">
        <span>{summary ? new Date(summary.updatedAt).toLocaleTimeString() : ''}</span>
        <button
          type="button"
          className="pm-status-bar-shortcut-btn"
          title="快捷键说明"
          aria-label="快捷键说明"
          onClick={() => setHelpOpen(true)}
        >
          <KeyboardIcon className="w-3.5 h-3.5"/>
        </button>
      </div>
      {helpOpen && <ShortcutHelpDialog open onClose={() => setHelpOpen(false)}/>}
    </div>
  )
}
