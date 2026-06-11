import React from 'react'
import ReactDOM from 'react-dom/client'
import LlmLogsWindow from './components/LlmLogsWindow'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <LlmLogsWindow/>
    </React.StrictMode>,
)
