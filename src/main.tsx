import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

declare const __BUILD__: string;

// Browsers and GitHub Pages cache the page for a while: check for a newer deploy when the tab
// opens or comes back into view, and reload once to get it.
async function checkForUpdate() {
  if (location.protocol === 'file:') return;
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    const { build } = await r.json();
    if (build && build !== __BUILD__ && sessionStorage.getItem('wallet:reloaded') !== build) {
      sessionStorage.setItem('wallet:reloaded', build);
      location.reload();
    }
  } catch {
    /* offline or no version file */
  }
}
void checkForUpdate();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void checkForUpdate());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
