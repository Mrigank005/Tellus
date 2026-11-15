import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'
import './styles/journey.css'
import './styles/journey-story.css'
import './styles/desk.css'
import './styles/charts.css'
import './styles/pages.css'
import './state/theme'
import { useStore } from './state/store'

// dev only: lets headless checks drive screens, e.g. window.__tellus.setState({ screen: 'workspace' })
if (import.meta.env.DEV) (window as unknown as { __tellus: typeof useStore }).__tellus = useStore

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
