import { type ReactNode } from 'react'
import { type AnimatedValueType } from './format'
import { useFluctuatingValue } from './useFluctuatingValue'

type Props = {
  type: AnimatedValueType
  initialValue: number
  className?: string
  /** Overrides the default formatter output (rare) */
  children?: ReactNode
}

export function AnimatedValue({ type, initialValue, className }: Props) {
  const { formatted, flash } = useFluctuatingValue(type, initialValue)

  return (
    <span
      className={[
        'anim-val',
        className ?? '',
        flash === 'green' ? 'text-flash-green' : '',
        flash === 'red' ? 'text-flash-red' : '',
      ].join(' ')}
    >
      {formatted}
    </span>
  )
}

