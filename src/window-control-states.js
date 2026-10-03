/**
 * Reflect current window visibility on existing native triggers. This adapter
 * owns only data-window-control, aria-controls and aria-expanded; it does not
 * open windows, install input handlers, change focus or infer state from .active.
 *
 * @param {Array<{button: HTMLElement, controls: string, isOpen: () => boolean}>} bindings
 * @returns {() => number} Synchronize current visibility; return changed count.
 */
export function createWindowControlStates(bindings) {
  for (const { button, controls, isOpen } of bindings) {
    if (typeof button?.setAttribute !== 'function' || typeof controls !== 'string' || !controls.trim() || typeof isOpen !== 'function') {
      throw new TypeError('Window controls need a button, controlled element ID and isOpen getter');
    }
  }
  const states = bindings.map(({ button, controls, isOpen }) => {
    button.setAttribute('data-window-control', '');
    button.setAttribute('aria-controls', controls);
    button.setAttribute('aria-expanded', 'false');
    return { button, isOpen, open: false };
  });
  // Call once after initialization, then after transitions or from the frame
  // update. Unchanged visibility causes no DOM writes, including for 60fps polls.
  return function syncWindowControlStates() {
    let changed = 0;
    for (const state of states) {
      let open = false;
      try { open = Boolean(state.isOpen()); } catch { /* A disposed surface must not interrupt the world frame. */ }
      if (open === state.open) continue;
      state.button.setAttribute('aria-expanded', String(open));
      state.open = open;
      changed++;
    }
    return changed;
  };
}
