import { useEffect, useState } from 'react';

// The wordmark only makes sense in its own font: wait for it (briefly) instead of flashing a fallback.
let fontReady = typeof document === 'undefined' || !document.fonts || document.fonts.check('1em "Instrument Serif"');
const whenFont = fontReady
  ? Promise.resolve()
  : Promise.race([document.fonts.load('1em "Instrument Serif"').then(() => undefined), new Promise<void>((r) => setTimeout(r, 1500))]).then(() => {
      fontReady = true;
    });

/**
 * "Walleti" — "Wallet" followed by an exclamation mark whose dot is the brand's lime period.
 * It's the font's own "!", with the lime period laid exactly over its dot.
 */
export function Wordmark({ size, className = '' }: { size?: number; className?: string }) {
  const [ready, setReady] = useState(fontReady);
  useEffect(() => {
    if (!ready) void whenFont.then(() => setReady(true));
  }, [ready]);
  return (
    <div className={'wordmark ' + (ready ? 'wm-ready ' : 'wm-wait ') + className} style={size ? { fontSize: size } : undefined} aria-label="Walleti" role="img">
      <span aria-hidden="true">Wallet</span>
      <span className="wm-i" aria-hidden="true">!<i>.</i></span>
    </div>
  );
}
