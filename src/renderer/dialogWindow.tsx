import React, {useEffect} from 'react'
import ReactDOM from 'react-dom/client'
import ConfigDialogWindow from './components/ConfigDialogWindow'
import {installSelectAllGuard} from './lib/selectionGuard'
import './styles/globals.css'

/** 配置类窗口根组件：本窗口含记忆管理 CodeMirror 编辑器，与主窗口 / PM 窗口共用同一选区守卫 */
function DialogWindowRoot() {
    // 抑制文档级 Ctrl+A 选区（豁免文本类 input/textarea，编辑器内一致拦截）。详见 ./lib/selectionGuard.ts
    useEffect(() => installSelectAllGuard(), [])

    return <ConfigDialogWindow/>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <DialogWindowRoot/>
    </React.StrictMode>,
)
