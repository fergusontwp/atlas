import { textStyle } from "../printTextStyle.js";
import { measureText, drawText } from "./text.js";
export default {
  id: "date", label: "Date", defaultSlot: "footer", defaultState: { on: false }, controls: [{ type: "text-style", key: "textStyle", profile: "date", label: "Text style" }],
  measure({ box, state, date }) { return measureText(date, box, textStyle(state.textStyle, "date")); },
  draw(drawing, box, state, { measurement }) { drawText(drawing, box, measurement); },
};
