// The app's name and logo (docs/features/024-squareyield/spec.md) and the Cyfouri signature. The mark is inline
// SVG: square and dot in the text colour, the yield arrow in --pos, so it follows the light / dark theme.
// scripts/brand-icons.py draws the PNG icons from the same geometry.
import type { CSSProperties } from 'react';

import { assetUrl } from '../../data/config';

export const APP_NAME = 'SquareYield';

/** An open square (the m²), a dot inside, and the arrow of the yield leaving its top-right corner. */
export const SquareYieldMark = ({ size = 26 }: { size?: number }) => (
  <svg className="cy-sy-mark" width={size} height={size} viewBox="0 0 32 32" fill="none" strokeWidth="2.6" aria-hidden focusable="false">
    <path d="M17 6.5H5.5v20h20V15" stroke="currentColor" />
    <rect x="10.7" y="15.7" width="2.6" height="2.6" fill="currentColor" />
    <path d="M15.5 16.5 27 5M19.5 5H27v7.5" stroke="var(--pos)" />
  </svg>
);

/** The maker's signature: the Cyfouri logo with CYFOURI under it (not the app's name). */
export const CyfouriSign = () => (
  <span className="cy-brand-sign" title="Une app CYFOURI">
    {/* the logo url follows the site base path (GitHub Pages sub-path, native site URL) */}
    <span className="cy-brand-mark" aria-hidden style={{ '--logo': `url(${assetUrl('brand/logo-mark.png')})` } as CSSProperties} />
    <span className="cy-brand-by">CYFOURI</span>
  </span>
);
