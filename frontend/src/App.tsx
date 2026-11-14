import { Component, type ReactNode } from 'react'
import { useStore } from './state/store'
import StartScreen from './components/StartScreen'
import ConfigureScreen from './components/ConfigureScreen'
import WorkspaceScreen from './components/WorkspaceScreen'
import VariableLibrary from './components/VariableLibrary'
import TourOverlay from './components/TourOverlay'
import CheckOurWork from './components/CheckOurWork'

/** Keep a component crash from blanking the whole application. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="container" style={{ maxWidth: 640, marginTop: 60 }}>
          <div className="card">
            <h3>Something went wrong in this view</h3>
            <p className="muted small">{String(this.state.error?.message ?? this.state.error)}</p>
            <button className="primary" onClick={() => { this.setState({ error: null }); location.reload() }}>
              Reload Tellus
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const screen = useStore((s) => s.screen)
  const go = useStore((s) => s.go)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => go('start')}>
          <h1><span className="sig">Tel</span>lus</h1>
          <small>What is Earth telling us?</small>
        </div>
        <div className="spacer" />
        <nav>
          <button className={`navbtn ${screen === 'start' ? 'active' : ''}`} onClick={() => go('start')}>Start</button>
          <button className={`navbtn ${screen === 'configure' ? 'active' : ''}`} onClick={() => go('configure')}>Investigate</button>
          <button className={`navbtn ${screen === 'library' ? 'active' : ''}`} onClick={() => go('library')}>Variable Library</button>
          <button className={`navbtn ${screen === 'check' ? 'active' : ''}`} onClick={() => go('check')}>Check our work</button>
        </nav>
      </header>
      <div className="main">
        <ErrorBoundary>
          {screen === 'start' && <StartScreen />}
          {screen === 'configure' && <ConfigureScreen />}
          {screen === 'workspace' && <WorkspaceScreen />}
          {screen === 'library' && <VariableLibrary />}
          {screen === 'check' && <CheckOurWork />}
        </ErrorBoundary>
      </div>
      <TourOverlay />
      <footer className="footer">
        Data: NASA POWER (MERRA-2) · GPCP V2.3 (NOAA PSL) — analysis runs entirely in your
        browser. Colour shows the direction and size of change, never whether it is “good” or “bad”.
      </footer>
    </div>
  )
}
