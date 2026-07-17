import { describe, expect, it } from "vitest";

import {
  createEmptyMaskBitmap,
  paintMaskSegment
} from "../src/features/mask/bitmap";
import {
  canRedoMask,
  canUndoMask,
  commitMaskHistory,
  createMaskHistory,
  redoMaskHistory,
  undoMaskHistory
} from "../src/features/mask/history";

function paintedMask(x: number) {
  const mask = createEmptyMaskBitmap(8, 8);
  paintMaskSegment(mask, { x, y: 4 }, { x, y: 4 }, 2, "brush");
  return mask;
}

describe("bounded mask history", () => {
  it("bounds snapshots and disables unavailable directions", () => {
    let history = createMaskHistory(createEmptyMaskBitmap(8, 8), 2);
    expect(canUndoMask(history)).toBe(false);
    expect(canRedoMask(history)).toBe(false);
    history = commitMaskHistory(history, paintedMask(1));
    history = commitMaskHistory(history, paintedMask(3));
    history = commitMaskHistory(history, paintedMask(6));
    expect(history.past).toHaveLength(2);
    expect(canUndoMask(history)).toBe(true);
  });

  it("restores undo and redo snapshots without sharing mutable alpha data", () => {
    const first = paintedMask(1);
    const second = paintedMask(6);
    let history = commitMaskHistory(createMaskHistory(first), second);
    history = undoMaskHistory(history);
    expect(history.present.alpha).toEqual(first.alpha);
    history.present.alpha.fill(0);
    history = redoMaskHistory(history);
    expect(history.present.alpha).toEqual(second.alpha);
  });

  it("invalidates the obsolete redo branch after a new edit", () => {
    let history = createMaskHistory(createEmptyMaskBitmap(8, 8));
    history = commitMaskHistory(history, paintedMask(1));
    history = commitMaskHistory(history, paintedMask(3));
    history = undoMaskHistory(history);
    expect(canRedoMask(history)).toBe(true);
    history = commitMaskHistory(history, paintedMask(7));
    expect(canRedoMask(history)).toBe(false);
  });
});
