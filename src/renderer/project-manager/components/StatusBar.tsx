import {useWorkspaceStore} from '../stores/workspaceStore'
import {useGitStatusStore} from '../stores/gitStatusStore'

export function StatusBar({branchName}: {branchName: string}) {
  const ws = useWorkspaceStore(s => s.workspacePath)
  const summary = useGitStatusStore(s => s.summary)
  const name = ws.split(/[\\/]/).pop()
  return (
    <div className="pm-status-bar">
      <span className="pm-status-bar-path" title={ws}>{name}{branchName && `  ◉ ${branchName}`}</span>
      <span>{summary ? `${Object.keys(summary.statusMap).length} files changed · ${summary.additions}+ ${summary.deletions}-` : ''}</span>
      <span>{summary ? new Date(summary.updatedAt).toLocaleTimeString() : ''}</span>
    </div>
  )
}
