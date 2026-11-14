import { useEffect, useRef } from 'react'
import * as echarts from 'echarts'

/** Mount an ECharts instance that updates when `option` changes. */
export function useChart(option: echarts.EChartsOption) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<echarts.ECharts | null>(null)

  useEffect(() => {
    if (!ref.current) return
    // (re)initialise when there is no live instance, or when it was disposed
    // (React StrictMode remount) or bound to a container that was replaced
    const c = chartRef.current
    if (!c || c.isDisposed() || c.getDom() !== ref.current) {
      if (c && !c.isDisposed()) c.dispose()
      chartRef.current = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    }
    chartRef.current?.setOption(option, true)
    const onResize = () => chartRef.current?.resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [option])

  useEffect(() => () => {
    chartRef.current?.dispose()
    chartRef.current = null
  }, [])

  return ref
}
