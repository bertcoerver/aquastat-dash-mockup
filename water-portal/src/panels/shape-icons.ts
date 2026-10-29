/*
 * The icons of how a map is drawn (shape-switch.ts, basin/scheme-map.ts,
 * basin/effects-map.ts, local/local-maps.ts): in the legend's checklist, to the right of each map, each with
 * its name as its tooltip. Drawn on 16 × 16 in currentColor only, shaded by opacity.
 */
export type ShapeIcon = "fill" | "circles" | "bars" | "scheme" | "particles" | "rain" | "vapour" | "raster";

const ICONS: Record<ShapeIcon, string> = {
  // Areas of three shades in a frame.
  fill:
    `<path d="M2 2H9L7 8H2Z" fill="currentColor" fill-opacity=".3"/><path d="M9 2H14V10L7 8Z" fill="currentColor" fill-opacity=".65"/>` +
    `<path d="M2 8H7L14 10V14H2Z" fill="currentColor"/><rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor"/>`,
  // Three circles of growing size on a line.
  circles: `<g fill="currentColor"><circle cx="1.7" cy="8" r="1.2"/><circle cx="6.1" cy="8" r="2.1"/><circle cx="12.4" cy="8" r="3.1"/></g>`,
  // Three cylinders of growing height, their tops lighter.
  bars:
    `<g fill="currentColor">` +
    `<path d="M0.5 10.5V14.5A2 .9 0 0 0 4.5 14.5V10.5A2 .9 0 0 1 0.5 10.5Z"/><ellipse cx="2.5" cy="10.5" rx="2" ry=".9" opacity=".4"/>` +
    `<path d="M6 6.5V14.5A2 .9 0 0 0 10 14.5V6.5A2 .9 0 0 1 6 6.5Z"/><ellipse cx="8" cy="6.5" rx="2" ry=".9" opacity=".4"/>` +
    `<path d="M11.5 2V14.5A2 .9 0 0 0 15.5 14.5V2A2 .9 0 0 1 11.5 2Z"/><ellipse cx="13.5" cy="2" rx="2" ry=".9" opacity=".4"/></g>`,
  // A river tree, thickening downstream to its outlet.
  scheme:
    `<g stroke="currentColor" stroke-linecap="round" fill="none">` +
    `<path d="M1.5 1.5L4.5 4.5M6.5 1L4.5 4.5M1 7.5L5.5 8.5M9.5 1.5L11 6.5M15 4.5L11 6.5M2 13.5L9 11" stroke-width=".9"/>` +
    `<path d="M4.5 4.5L5.5 8.5M11 6.5L9 11" stroke-width="1.3"/><path d="M5.5 8.5L9 11" stroke-width="1.7"/>` +
    `<path d="M9 11L14 14.5" stroke-width="2.3"/></g>` +
    `<g fill="currentColor"><circle cx="4.5" cy="4.5" r="1"/><circle cx="11" cy="6.5" r="1"/><circle cx="5.5" cy="8.5" r="1.2"/>` +
    `<circle cx="9" cy="11" r="1.4"/><circle cx="14" cy="14.5" r="1.6"/></g>`,
  // A river winding towards us, widening as it comes nearer.
  particles:
    `<path d="M8.2 1C9.5 1.8 10.6 2.6 10.4 3.5C10.1 5 5.2 6.3 5 8C4.8 9.8 8.6 10.5 8.5 12C8.4 13.5 5.8 14.6 4.8 15.5H9.3C10.5 14.6 ` +
    `11.6 13.6 11.5 12C11.4 10.2 7.2 9.6 7 8C6.8 6.6 11.8 5.3 11.6 3.5C11.5 2.4 10 1.6 8.8 1Z" fill="currentColor"/>`,
  // A cloud with drops falling from it.
  rain:
    `<g fill="currentColor"><circle cx="5" cy="6" r="2.5"/><circle cx="9" cy="5" r="3.5"/><circle cx="12.5" cy="6.5" r="2"/>` +
    `<rect x="5" y="5" width="7.5" height="3.5"/></g>` +
    `<path d="M5.5 9.8L4.8 11.6M9 9.8L8.3 11.6M12.5 9.8L11.8 11.6M6.9 13.4L6.2 15.2M10.4 13.4L9.7 15.2" stroke="currentColor" ` +
    `stroke-linecap="round" stroke-width="1.1"/>`,
  // A grid of square pixels in shades (the Local view's rasters).
  raster:
    `<g fill="currentColor"><rect x="2" y="2" width="3.6" height="3.6" opacity=".3"/><rect x="6.2" y="2" width="3.6" height="3.6" opacity=".6"/>` +
    `<rect x="10.4" y="2" width="3.6" height="3.6"/><rect x="2" y="6.2" width="3.6" height="3.6" opacity=".6"/>` +
    `<rect x="6.2" y="6.2" width="3.6" height="3.6"/><rect x="10.4" y="6.2" width="3.6" height="3.6" opacity=".45"/>` +
    `<rect x="2" y="10.4" width="3.6" height="3.6"/><rect x="6.2" y="10.4" width="3.6" height="3.6" opacity=".45"/>` +
    `<rect x="10.4" y="10.4" width="3.6" height="3.6" opacity=".3"/></g>`,
  // Wisps rising.
  vapour:
    `<g stroke="currentColor" stroke-linecap="round" fill="none" stroke-width="1.5"><path d="M4 14.5C2.5 12.5 5.5 11 4 9S5.5 6 4 4.5"/>` +
    `<path d="M8 13C6.5 11 9.5 9.5 8 7.5S9.5 4.5 8 2"/><path d="M12 14.5C10.5 12.5 13.5 11 12 9S13.5 6 12 4.5"/></g>`,
};

export const iconSvg = (icon: ShapeIcon) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[icon]}</svg>`;
