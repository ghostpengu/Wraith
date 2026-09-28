import test from "node:test";
import assert from "node:assert/strict";
import { shouldWaitForCursorCorrection } from "../src/terminalOutput.ts";

test("holds a visible cursor left on a status row", () => {
  const statusFrame = "working\x1b[K\x1b[?25h\x1b[?2026l";
  assert.equal(shouldWaitForCursorCorrection(statusFrame), true);

  const corrected = `${statusFrame}\x1b[?25l\x1b[28;3H\x1b[?25h`;
  assert.equal(shouldWaitForCursorCorrection(corrected), false);
});

test("renders a cursor shown directly after positioning without delay", () => {
  assert.equal(shouldWaitForCursorCorrection("\x1b[28;3H\x1b[?25h"), false);
  assert.equal(shouldWaitForCursorCorrection("hello world"), false);
});

test("holds a cursor-show escape split across PTY reads", () => {
  assert.equal(shouldWaitForCursorCorrection("working\x1b[?25"), true);
});
