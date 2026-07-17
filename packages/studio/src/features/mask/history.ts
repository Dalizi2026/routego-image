import {
  cloneMaskBitmap,
  maskBitmapsEqual,
  type MaskBitmap
} from "./bitmap";

export interface MaskHistory {
  readonly limit: number;
  readonly past: readonly MaskBitmap[];
  readonly present: MaskBitmap;
  readonly future: readonly MaskBitmap[];
}

export function createMaskHistory(initial: MaskBitmap, limit = 12): MaskHistory {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("Mask history limit must be between 1 and 50.");
  }
  return {
    limit,
    past: [],
    present: cloneMaskBitmap(initial),
    future: []
  };
}

export function commitMaskHistory(history: MaskHistory, next: MaskBitmap): MaskHistory {
  if (maskBitmapsEqual(history.present, next)) {
    return history;
  }
  return {
    limit: history.limit,
    past: [...history.past, cloneMaskBitmap(history.present)].slice(-history.limit),
    present: cloneMaskBitmap(next),
    future: []
  };
}

export function canUndoMask(history: MaskHistory): boolean {
  return history.past.length > 0;
}

export function canRedoMask(history: MaskHistory): boolean {
  return history.future.length > 0;
}

export function undoMaskHistory(history: MaskHistory): MaskHistory {
  const previous = history.past.at(-1);
  if (!previous) {
    return history;
  }
  return {
    limit: history.limit,
    past: history.past.slice(0, -1),
    present: cloneMaskBitmap(previous),
    future: [cloneMaskBitmap(history.present), ...history.future].slice(0, history.limit)
  };
}

export function redoMaskHistory(history: MaskHistory): MaskHistory {
  const next = history.future[0];
  if (!next) {
    return history;
  }
  return {
    limit: history.limit,
    past: [...history.past, cloneMaskBitmap(history.present)].slice(-history.limit),
    present: cloneMaskBitmap(next),
    future: history.future.slice(1)
  };
}
