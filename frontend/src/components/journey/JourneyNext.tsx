import { Icon } from '../Icon'
import CopilotPanel from '../CopilotPanel'
import { DETECTIVE_CASES, useStore, type DetectiveCase } from '../../state/store'
import { TOURS } from '../../state/tours'

/** Tour ids that do not match their case id. */
const TOUR_OF_CASE: Record<string, string> = { 'polar-amplification': 'polar-express' }
const tourFor = (c: DetectiveCase) => (TOURS[c.id] ? c.id : TOUR_OF_CASE[c.id] && TOURS[TOUR_OF_CASE[c.id]] ? TOUR_OF_CASE[c.id] : null)

const DESK_GIVES = [
  'Draw any region on the map, or pick from the preset places.',
  'Put two places side by side and test whether their trends really differ.',
  'See the monthly record, not just the yearly one.',
  'Check the answer holds across different start and end years.',
  'Export the evidence behind every number.',
]

function openCase(c: DetectiveCase, withTour: boolean) {
  useStore.setState({
    variableId: c.variableId,
    season: c.season,
    windowId: c.windowId,
    regionId: c.regionId,
    compareRegionId: c.compareRegionId ?? null,
    customPolygon: null,
    mode: 'place',
    ...(withTour ? { tourId: tourFor(c) } : {}),
  })
  useStore.getState().go('workspace')
}

export default function JourneyNext() {
  const go = useStore((s) => s.go)
  return (
    <section className="screen st-section" id="next" aria-labelledby="h-next">
      <div className="wrap">
        <h2 className="title" id="h-next">Now it&rsquo;s your turn.</h2>
        <p className="lede">
          The field desk holds every place and every NASA record in Tellus. Open a case below to start with a question
          already asked, or go in with your own.
        </p>

        <div className="st-next-grid">
          <div className="st-desk">
            <h3>What the field desk adds</h3>
            <ul className="st-adds">
              {DESK_GIVES.map((t) => <li key={t}>{t}</li>)}
            </ul>
            <button className="btn" type="button" onClick={() => go('workspace')}>
              Open the field desk<Icon name="arrow" className="arrow" />
            </button>
          </div>

          <div className="st-cases">
            <h3 className="st-cases-h">Four cases to crack</h3>
            <ol className="st-case-list">
              {DETECTIVE_CASES.map((c) => (
                <li className="st-case" key={c.id}>
                  <div className="st-case-text">
                    <h4>{c.title}</h4>
                    <p className="st-case-q">{c.question}</p>
                  </div>
                  <div className="st-case-actions">
                    {tourFor(c) && (
                      <button className="btn sm ghost" type="button" onClick={() => openCase(c, true)}>
                        Watch the tour
                      </button>
                    )}
                    <button className="btn sm" type="button" onClick={() => openCase(c, false)}>
                      Open case<Icon name="arrow" className="arrow" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="st-ask" id="ask-tellus">
          <CopilotPanel />
        </div>
      </div>
    </section>
  )
}
