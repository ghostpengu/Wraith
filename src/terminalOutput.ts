const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_MOVE = /\x1b\[[0-9;]*[ABCDEFGHfd]/;
const MOVE_IMMEDIATELY_BEFORE_SHOW = /\x1b\[[0-9;]*[ABCDEFGHfd]$/;

/**
 * Decide whether buffered PTY output is an incomplete frame that xterm should
 * not paint yet, because painting it would make the cursor flicker.
 */
export function shouldWaitForCursorCorrection(data: string): boolean {
  for (let length = 1; length < CURSOR_SHOW.length; length += 1) {
    if (data.endsWith(CURSOR_SHOW.slice(0, length))) return true;
  }

  // ConPTY sends a redraw's "hide cursor" and the "show cursor" that ends it
  // in separate reads (e.g. on every PSReadLine keystroke). Painting between
  // them blanks the cursor for a frame.
  const hideAt = data.lastIndexOf(CURSOR_HIDE);
  const showAt = data.lastIndexOf(CURSOR_SHOW);
  if (hideAt > showAt) return true;
  if (showAt < 0) return false;

  // A complete hide → draw → show frame leaves the cursor where the app put it.
  if (hideAt >= 0) return false;

  // A Windows PTY can emit a TUI's "show cursor" before the move back to its
  // input row. Hold that frame briefly so xterm never paints the cursor at the
  // intermediate position.
  const afterShow = data.slice(showAt + CURSOR_SHOW.length);
  if (CURSOR_MOVE.test(afterShow)) return false;

  const beforeShow = data.slice(Math.max(0, showAt - 24), showAt);
  return !MOVE_IMMEDIATELY_BEFORE_SHOW.test(beforeShow);
}
