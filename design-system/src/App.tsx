import { useEffect } from 'react'
import { PredictionMarketCard } from './components/PredictionMarketCard/PredictionMarketCard'

function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark')
  }, [])

  return (
    <div className="min-h-full w-full bg-bgMain text-textPrimary antialiased font-sans flex items-center justify-center p-6">
      <div className="w-full max-w-[380px]">
        <PredictionMarketCard />
      </div>
    </div>
  )
}

export default App
