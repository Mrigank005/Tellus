import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'
import { prefersReducedMotion } from '../styles/tokens'

/** Short, calm motion for every chart; off when the visitor prefers reduced motion. */
function withMotion(option: echarts.EChartsOption): echarts.EChartsOption {
  if (prefersReducedMotion()) return { animation: false, ...option }
  return { animationDuration: 300, animationDurationUpdate: 300, animationEasing: 'cubicOut', animationEasingUpdate: 'cubicOut', ...option }
}

/**
 * Mount an ECharts instance that updates when `option` changes.
 * - Resizes with its container (tabs, columns), not only the window.
 * - Waits for a non-zero size before initialising (hidden tabs).
 * - Disposes on unmount and when the container element is replaced.
 * Build `option` with `chartBase(theme)` and include `theme` in the memo deps so it re-renders on theme change.
 */
export function useChart(option: echarts.EChartsOption) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)
  const optionRef = useRef(option)
  const roRef = useRef<ResizeObserver | null>(null)
  const observedRef = useRef<Element | null>(null)
  optionRef.current = option

  // (re)bind the chart to the current container and paint the latest option
  const paint = () => {
    const el = ref.current
    if (!el) return
    let c = chartRef.current
    if (c && (c.isDisposed() || c.getDom() !== el)) {
      if (!c.isDisposed()) c.dispose()
      c = chartRef.current = null
    }
    if (!c) {
      if (el.clientWidth === 0 || el.clientHeight === 0) return // wait for the observer
      c = chartRef.current = echarts.init(el, undefined, { renderer: 'canvas' })
    }
    c.setOption(withMotion(optionRef.current), true)
    c.resize()
  }

  useEffect(() => {
    const el = ref.current
    if (el && observedRef.current !== el && typeof ResizeObserver !== 'undefined') {
      roRef.current?.disconnect()
      roRef.current = new ResizeObserver(() => {
        const chart = chartRef.current
        if (chart && !chart.isDisposed() && chart.getDom() === ref.current) chart.resize()
        else paint()
      })
      roRef.current.observe(el)
      observedRef.current = el
    }
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [option])

  useEffect(() => {
    const onResize = () => chartRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      roRef.current?.disconnect()
      roRef.current = null
      observedRef.current = null
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [])

  return ref
}
