import { useMemo } from 'react';
import { qrMatrix, qrPath } from '../../lib/qr';

/**
 * A QR code as inline SVG: one path for the dark modules on a white square, with the standard
 * four-module quiet zone. Always black on white, whatever the theme: scanners expect that.
 * Renders nothing when the text does not fit in a QR code.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    try {
      return qrPath(qrMatrix(text));
    } catch {
      return null;
    }
  }, [text]);
  if (!path) return null;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${path.size} ${path.size}`}
      width="100%"
      height="100%"
      shapeRendering="crispEdges"
      style={{ display: 'block' }}
    >
      <rect width={path.size} height={path.size} fill="#FFFFFF" />
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
