import { useEffect, useMemo, useRef, useState } from 'react'
import { formatNumber, type AnimatedValueType } from './format'

type Flash = 'none' | 'green' | 'red'

type Options = {
  /** matches "if (Math.random() > 0.6) return" from the spec */
  updateProbability?: number
  intervalMs?: number
}

export function useFluctuatingValue(
  type: AnimatedValueType,
  initialValue: number,
  options: Options = {},
) {
  const updateProbability = options.updateProbability ?? 0.4
  const intervalMs = options.intervalMs ?? 1800

  const original = useRef(initialValue)
  const [value, setValue] = useState(initialValue)
  const [flash, setFlash] = useState<Flash>('none')

  const formatted = useMemo(() => formatNumber(value, type), [type, value])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (Math.random() > updateProbability) return

      setValue((currentVal) => {
        let deltaPercentage = Math.random() * 0.03 - 0.015
        if (type === 'percent') deltaPercentage = Math.random() * 0.1 - 0.05
        if (type === 'multiplier') deltaPercentage = Math.random() * 0.02 - 0.01

        let next = currentVal + currentVal * deltaPercentage

        if (next > original.current * 1.15) next = original.current * 1.1
        if (next < original.current * 0.85 && type !== 'percent')
          next = original.current * 0.9

        const isPositive = next > currentVal
        const flashNext: Flash = isPositive ? 'green' : 'red'
        setFlash(flashNext)
        window.setTimeout(() => setFlash('none'), 300)

        return next
      })
    }, intervalMs)

    return () => window.clearInterval(id)
  }, [intervalMs, type, updateProbability])

  return {
    value,
    formatted,
    flash,
  }
}

