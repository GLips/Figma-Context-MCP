export type AnimatedValueType = 'currency_k' | 'volume' | 'percent' | 'multiplier'

export function formatNumber(num: number, type: AnimatedValueType) {
  if (type === 'currency_k') return `$${num.toFixed(1)}k`
  if (type === 'volume') return `$${Math.floor(num).toLocaleString('en-US')}`
  if (type === 'percent') {
    const arrow = num >= 0 ? '↗' : '↘'
    return `${arrow} ${Math.abs(Math.round(num))}%`
  }
  if (type === 'multiplier') return `${num.toFixed(2)}x`
  return String(num)
}

