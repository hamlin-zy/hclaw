import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

// 冷启动观测：渲染进程 bundle 执行起点（可选链兜底，无 electronAPI 环境不崩）
window.electronAPI?.startup?.mark?.('renderer:bundle-start')

const root = ReactDOM.createRoot(document.getElementById('root')!)
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// 冷启动观测：连续两帧 rAF 后认定 React 首帧已绘制
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.electronAPI?.startup?.mark?.('renderer:react-painted')
  })
})
