import { Clock, Gavel, RocketLaunch, Trophy } from '@phosphor-icons/react'
import { AnimatedValue } from './AnimatedValue'

type Outcome = {
  id: string
  label: string
  poolK: number
  changePct: number
  payoutX: number
}

const outcomes: Outcome[] = [
  { id: 'yes', label: 'Yes', poolK: 150.0, changePct: 33, payoutX: 1.2 },
  { id: 'no', label: 'No', poolK: 60.0, changePct: -15, payoutX: 4.5 },
]

export function PredictionMarketCard() {
  return (
    <div className="bg-bgSurface border border-borderMain rounded-2xl p-5 shadow-lg shadow-black/20 group hover:border-gray-600 transition-colors duration-300">
      <div className="flex gap-4 mb-5 items-start">
        <div className="w-12 h-12 rounded-xl bg-blue-900/40 flex-shrink-0 flex items-center justify-center border border-blue-800/50 group-hover:scale-105 transition-transform duration-300">
          <RocketLaunch weight="fill" className="text-blue-400" size={24} />
        </div>

        <div className="flex-1">
          <h3 className="font-semibold text-base leading-snug text-textPrimary">
            SpaceX Starship reaches orbit successfully on flight 4?
          </h3>
          <div className="flex items-center gap-2 mt-1 text-accentPurple text-xs">
            <Clock weight="bold" size={14} /> 5d left
          </div>
        </div>

        <div className="relative group/hammer">
          <Gavel
            weight="fill"
            className="text-textSecondary text-lg cursor-help hover:text-accentPurple transition-colors"
          />
          <div className="absolute right-0 bottom-full mb-2 w-56 p-3 bg-bgMain border border-borderMain rounded-xl shadow-xl opacity-0 invisible group-hover/hammer:opacity-100 group-hover/hammer:visible transition-all duration-200 z-10">
            <p className="text-xs text-textSecondary leading-relaxed">
              Resolution rules: Market resolves when official SpaceX announcement
              confirms orbit status. Uses credible sources only.
            </p>
          </div>
        </div>
      </div>

      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-textSecondary text-left border-b border-borderMain/50">
            <th className="pb-2 font-medium w-[35%] font-sans">Outcome</th>
            <th className="pb-2 font-medium text-right font-sans">Pool</th>
            <th className="pb-2 font-medium text-right font-sans">24H</th>
            <th className="pb-2 font-medium text-right font-sans">Payout</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-borderMain/30">
          {outcomes.map((o) => (
            <tr
              key={o.id}
              className="group/row cursor-pointer hover:bg-bgSurface/50 transition-colors duration-200"
            >
              <td className="py-4 px-2 font-medium pr-2 text-textPrimary transition-opacity duration-200 group-hover/row:opacity-30">
                {o.label}
              </td>
              <td className="py-4 text-right font-mono text-textSecondary transition-opacity duration-200 group-hover/row:opacity-30">
                <AnimatedValue type="currency_k" initialValue={o.poolK} />
              </td>
              <td
                className={[
                  'py-4 text-right font-mono flex justify-end items-center gap-1 transition-opacity duration-200 group-hover/row:opacity-30',
                  o.changePct >= 0 ? 'text-accentGreen' : 'text-accentRed',
                ].join(' ')}
              >
                <AnimatedValue type="percent" initialValue={o.changePct} />
              </td>
              <td className="py-4 px-2 text-right font-mono text-accentGreen font-semibold transition-opacity duration-200 group-hover/row:opacity-30 relative">
                <AnimatedValue type="multiplier" initialValue={o.payoutX} />
                <div className="absolute inset-0 hidden group-hover/row:flex items-center justify-end p-1 opacity-100">
                  <button className="h-7 px-3 bg-[#8b5fd4] text-white text-xs font-semibold rounded shadow-lg shadow-accentPurple/40 transition-all cursor-pointer active:scale-95">
                    Trade
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between text-textSecondary text-xs font-medium mt-5 pt-4 border-t border-borderMain/50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5" title="24H Volume">
            <span>Vol.</span>
            <AnimatedValue
              type="volume"
              initialValue={890_100}
              className="font-mono text-textPrimary"
            />
          </div>
          <div className="flex items-center gap-1.5" title="Total Pool">
            <Trophy weight="fill" className="text-accentPurple text-sm" />
            <AnimatedValue
              type="currency_k"
              initialValue={210.0}
              className="font-mono text-textPrimary"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

