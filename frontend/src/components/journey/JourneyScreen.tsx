import JourneyHero from './JourneyHero'
import JourneyAsk from './JourneyAsk'
import JourneyRead from './JourneyRead'
import JourneyReal from './JourneyReal'
import JourneyLedger from './JourneyLedger'
import JourneyNext from './JourneyNext'

/**
 * The start page as a journey, one question per screen:
 * Hero (Earth keeps a diary) -> Ask (sentence builder + tapestry) -> Read (verdict as a story)
 * -> Real (is it real or weather?) -> Ledger (we checked our work) -> Next (field desk + Ask Tellus).
 * Every section reads the current question from the zustand store (variableId, regionId, season, windowId).
 */
export default function JourneyScreen() {
  return (
    <div className="journey">
      <JourneyHero />
      <JourneyAsk />
      <JourneyRead />
      <JourneyReal />
      <JourneyLedger />
      <JourneyNext />
    </div>
  )
}
