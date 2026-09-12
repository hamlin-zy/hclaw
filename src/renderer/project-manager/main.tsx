import React from 'react'
import {createRoot} from 'react-dom/client'
import {ProjectManagerApp} from './ProjectManagerApp'
import '../styles/globals.css'

createRoot(document.getElementById('project-manager-root')!).render(
  <React.StrictMode><ProjectManagerApp /></React.StrictMode>,
)
