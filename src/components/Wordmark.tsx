/**
 * "Walleti" — the final i is upside down, so its dot lands on the baseline as the brand's lime period.
 */
export function Wordmark({ size, className = '' }: { size?: number; className?: string }) {
  return (
    <div className={'wordmark ' + className} style={size ? { fontSize: size } : undefined} aria-label="Walleti" role="img">
      <span aria-hidden="true">Wallet</span>
      <span className="wm-i" aria-hidden="true"><i /></span>
    </div>
  );
}
