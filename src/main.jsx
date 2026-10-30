import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ResultsDemo from './ResultsDemo.jsx'

const isResultsDemo = window.location.pathname === '/results-demo';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isResultsDemo ? <ResultsDemo /> : <App />}
  </StrictMode>,
)
