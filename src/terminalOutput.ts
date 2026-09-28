const CURSOR_SHOW = "\x1b[?25h";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_MOVE = /\x1b\[[0-9;]*[ABCDEFGHfd]/;
const MOVE_IMMEDIATELY_BEFORE_SHOW = /\x1b\[[0-9;]*[ABCDEFGHfd]$/;

/**
 * A Windows PTY can emit a TUI's "show cursor" before the move back to its
 * input row. Hold that incomplete frame briefly so xterm never paints the
 * cursor at the intermediate position.
 */
export function shouldWaitForCursorCorrection(data: string): boolean {
  for (let length = 1; length < CURSOR_SHOW.length; length += 1) {
    if (data.endsWith(CURSOR_SHOW.slice(0, length))) return true;
  }

  const showAt = data.lastIndexOf(CURSOR_SHOW);
  if (showAt < 0) return false;
  const afterShow = data.slice(showAt + CURSOR_SHOW.length);
  if (afterShow.includes(CURSOR_HIDE) || CURSOR_MOVE.test(afterShow)) return false;

  const beforeShow = data.slice(Math.max(0, showAt - 24), showAt);
  return !MOVE_IMMEDIATELY_BEFORE_SHOW.test(beforeShow);
}
