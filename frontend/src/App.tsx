import { Component, useEffect, type ReactNode } from 'react'
import { useStore, type Screen } from './state/store'
import { useTheme } from './state/theme'
import { Icon, IconSprite } from './components/Icon'
import JourneyScreen from './components/journey/JourneyScreen'
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
        <div className="wrap" style={{ maxWidth: 640, marginTop: 64 }}>
          <div className="panel">
            <h3>This page tripped over something</h3>
            <p className="note">{String(this.state.error?.message ?? this.state.error)}</p>
            <button className="btn" onClick={() => { this.setState({ error: null }); location.reload() }}>
              Reload Tellus
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

const NAV: { screen: Screen; label: string; keep?: boolean; also?: Screen[] }[] = [
  { screen: 'start', label: 'Start here' },
  { screen: 'workspace', label: 'Field desk', keep: true, also: ['configure'] },
  { screen: 'library', label: 'What we measure' },
  { screen: 'check', label: 'Check our work' },
]

export default function App() {
  const screen = useStore((s) => s.screen)
  const go = useStore((s) => s.go)
  const theme = useTheme((s) => s.theme)
  const toggleTheme = useTheme((s) => s.toggle)
  const overridden = useTheme((s) => s.overridden)

  // every screen change starts at the top of the new page
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }) }, [screen])

  return (
    <div className="app">
      <IconSprite />
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="wrap">
          <button className="brand" onClick={() => go('start')} aria-label="Tellus, back to the start">
            <Icon name="rings" />
            <b>Tellus</b>
            <small>What is Earth telling us?</small>
          </button>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <button
                key={n.screen}
                className={n.keep ? 'keep' : undefined}
                aria-current={screen === n.screen || n.also?.includes(screen) ? 'page' : undefined}
                onClick={() => go(n.screen)}
              >
                {n.label}
              </button>
            ))}
          </nav>
          <button
            className="theme-btn" onClick={toggleTheme} aria-pressed={theme === 'dusk'}
            title={overridden
              ? 'Your choice for now. Tellus goes back to your device setting when the device switches.'
              : `Following your device (${theme === 'dusk' ? 'dark' : 'light'}). Press to switch for now.`}
          >
            <Icon name={theme === 'dusk' ? 'sun' : 'moon'} />
            <span>{theme === 'dusk' ? 'Day' : 'Dusk'}</span>
          </button>
        </div>
      </header>
      <main className="main" id="main">
        <ErrorBoundary>
          {screen === 'start' && <JourneyScreen />}
          {screen === 'configure' && <ConfigureScreen />}
          {screen === 'workspace' && <WorkspaceScreen />}
          {screen === 'library' && <VariableLibrary />}
          {screen === 'check' && <CheckOurWork />}
        </ErrorBoundary>
      </main>
      <TourOverlay />
      <footer className="footer">
        <div className="wrap">
          <span>
            Data from NASA POWER (MERRA-2) and GPCP V2.3 (NOAA PSL). Every number is computed in your browser.
          </span>
          <span>Colour shows the direction and size of change, never whether it is good or bad.</span>
        </div>
      </footer>
    </div>
  )
}
