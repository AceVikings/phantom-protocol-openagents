import Nav from './components/Nav'
import Hero from './components/Hero'
import Stats from './components/Stats'
import Architecture from './components/Architecture'
import HowItWorks from './components/HowItWorks'
import CTA from './components/CTA'
import Footer from './components/Footer'
import './App.css'

function App() {
  return (
    <div className="grain-overlay bg-zinc-950 text-zinc-100 min-h-[100dvh] font-sans overflow-x-hidden">
      <Nav />
      <Hero />
      <Stats />
      <Architecture />
      <HowItWorks />
      <CTA />
      <Footer />
    </div>
  )
}

export default App
