import './styles.css'

import { createRoot } from 'react-dom/client'

import { App } from './App'
import { fontsReady } from './fonts'

// The type first: what the 3D writes on its labels is drawn once, in whatever face is there.
void fontsReady().then(() => createRoot(document.getElementById('root')!).render(<App />))
