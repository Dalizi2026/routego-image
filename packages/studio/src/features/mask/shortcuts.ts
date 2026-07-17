export type MaskShortcutAction =
  | "brush"
  | "eraser"
  | "pan"
  | "undo"
  | "redo"
  | "fit"
  | "toggle-overlay"
  | "decrease-brush"
  | "increase-brush"
  | "close";

export interface MaskShortcutInput {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly editableTarget?: boolean;
}

export function resolveMaskShortcut(input: MaskShortcutInput): MaskShortcutAction | undefined {
  const key = input.key.toLowerCase();
  const command = input.ctrlKey === true || input.metaKey === true;
  if (key === "escape") {
    return "close";
  }
  if (input.editableTarget) {
    return undefined;
  }
  if (command && key === "z") {
    return input.shiftKey ? "redo" : "undo";
  }
  if (command && key === "y") {
    return "redo";
  }
  if (key === "b") {
    return "brush";
  }
  if (key === "e") {
    return "eraser";
  }
  if (key === "h") {
    return "pan";
  }
  if (key === "0" || key === "f") {
    return "fit";
  }
  if (key === "v") {
    return "toggle-overlay";
  }
  if (key === "[") {
    return "decrease-brush";
  }
  if (key === "]") {
    return "increase-brush";
  }
  return undefined;
}
