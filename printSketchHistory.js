// History owns array snapshots; committed stroke objects are never edited.
import { PRINT } from "./config.js";
export function createSketchHistory() {
  let strokes = [], undo = [], redo = [];
  function set(next) { undo.push(strokes); if (undo.length > PRINT.SKETCH.HISTORY_LIMIT) undo.shift(); strokes = next; redo = []; }
  return {
    add(stroke) { set([...strokes, stroke]); },
    remove(index) { if (Number.isInteger(index) && index >= 0 && index < strokes.length) set(strokes.filter((_, i) => i !== index)); },
    clear() { if (strokes.length) set([]); },
    undo() { if (undo.length) { redo.push(strokes); strokes = undo.pop(); } },
    redo() { if (redo.length) { undo.push(strokes); strokes = redo.pop(); } },
    get strokes() { return [...strokes]; }, get canUndo() { return !!undo.length; }, get canRedo() { return !!redo.length; },
  };
}
