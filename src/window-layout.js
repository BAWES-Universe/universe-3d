/** Window geometry only: no frame ownership, navigation or stored preferences. */
export const CONTENT_DESKTOP_WIDTH = 1024;
export const CONTENT_RESIZE_STEP = 32;
export function contentWindowLayout({viewportWidth, viewportHeight, gameWidth = viewportWidth, authoredWidth = 60, customWidth = null, maximized = false}) {
  const width = Math.max(1, Number(viewportWidth) || 1024);
  const height = Math.max(1, Number(viewportHeight) || 768);
  const canMaximize = Number(gameWidth) >= CONTENT_DESKTOP_WIDTH;
  const fullSheet = width <= 650 || (height <= 540 && width <= 900);
  const minWidth = Math.min(200, width);
  const maxWidth = Math.max(minWidth, width - 50);
  const clamp = value => Math.round(Math.max(minWidth, Math.min(value, maxWidth)));
  // Keep the established authored default/control lane until someone deliberately resizes.
  const defaultWidth = Math.max(minWidth, Math.min(width * Math.max(30, Math.min(90, Number(authoredWidth) || 60)) / 100, width - 360));
  const isMaximized = maximized && canMaximize;
  return {
    width: isMaximized || fullSheet ? width : clamp(customWidth ?? defaultWidth),
    height, minWidth, maxWidth, defaultWidth: clamp(defaultWidth), fullSheet,
    canMaximize, maximized: isMaximized, canResize: !isMaximized && !fullSheet,
  };
}
