import { textStyle } from "../printTextStyle.js";
import { measureText, drawText } from "./text.js";
export default {
  id: "title", label: "Title", defaultSlot: "header", defaultState: { on: false, text: "", subtitle: "" },
  controls: [{ key: "text", label: "Title", type: "text" }, { type: "text-style", key: "textStyle", profile: "title", label: "Title style" },
    { key: "subtitle", label: "Subtitle", type: "text" }, { type: "text-style", key: "subtitleStyle", profile: "subtitle", label: "Subtitle style" }],
  measure({ box, state }) {
    const title = measureText(state.text, box, textStyle(state.textStyle, "title")), subtitle = measureText(state.subtitle, box, textStyle(state.subtitleStyle, "subtitle"));
    return { height: title.height + subtitle.height, overflow: title.overflow || subtitle.overflow, title, subtitle };
  },
  draw(drawing, box, state, { measurement }) {
    drawText(drawing, box, measurement.title);
    drawText(drawing, { ...box, y: box.y + measurement.title.height, height: Math.max(0, box.height - measurement.title.height) }, measurement.subtitle);
  },
};
