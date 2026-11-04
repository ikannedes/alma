import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Sin StrictMode: en desarrollo duplicaría start()/waitPending() contra el relay.
createRoot(document.getElementById('root')!).render(<App />);
