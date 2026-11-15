import { Icon } from '../Icon'
import { useStore } from '../../state/store'
import AskSentence from './AskSentence'
import AskTapestry from './AskTapestry'
import { scrollToSection } from './JourneyHero'

/** Ask: finish a sentence, see the whole planet's real trend map for that question. */
export default function JourneyAsk() {
  const go = useStore((s) => s.go)
  return (
    <section className="screen" id="ask" aria-labelledby="h-ask">
      <div className="wrap">
        <h2 className="title" id="h-ask">Ask the planet one question.</h2>
        <p className="lede">Finish the sentence. Tellus picks the right NASA record for it and does the statistics for you.</p>
        <AskSentence />
        <div className="ask-actions">
          <button type="button" className="btn" onClick={() => scrollToSection('read')}>
            Read the answer <Icon name="arrow" className="arrow" />
          </button>
          <button type="button" className="btn ghost" onClick={() => go('workspace')}>Open this in the field desk</button>
        </div>
        <AskTapestry />
      </div>
    </section>
  )
}
