import { useJourneyVerdict } from './StoryVerdict'
import RigorPanel from './RigorPanel'

export default function JourneyReal() {
  const { v, pending } = useJourneyVerdict()
  return (
    <section className="screen st-section" id="real" aria-labelledby="h-real" aria-busy={pending}>
      <div className="wrap">
        <h2 className="title" id="h-real">Is it real, or just weather?</h2>
        <p className="lede">
          A run of unusual years can happen by luck. So shuffle the years: if their order did not matter, a real
          trend would show up in the shuffled records too. Watch what happens.
        </p>
        <RigorPanel v={v} />
      </div>
    </section>
  )
}
