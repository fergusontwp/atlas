import { textStyle } from "../printTextStyle.js";
import { PRINT } from "../config.js";
import { measureText, drawText } from "./text.js";
export default {
  id: "notes", label: "Notes / disclaimer", defaultSlot: "footer", defaultState: { on: true, text: PRINT.DEFAULT_DISCLAIMER },
  controls: [{ key: "text", label: "Notes / disclaimer", type: "multiline" }, { type: "text-style", key: "textStyle", profile: "notes", label: "Text style" }],
  measure({ box, state }) { return measureText(state.text, box, textStyle(state.textStyle, "notes")); },
  draw(drawing, box, state, { measurement }) { drawText(drawing, box, measurement); },
};
