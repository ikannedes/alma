import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
import { alma } from './alma/almaPlayer'

// El puente de Alma (barra "← Alma" y burbuja) desde el inicio, no hasta su primer turno
void alma()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
