import { measureText, drawText } from "./text.js";
export default {
  id: "attribution", label: "Basemap credits", defaultSlot: "footer", defaultState: { on: true }, required: true, controls: [],
  measure({ box, attribution }) { return measureText(attribution, box, 7); },
  draw(drawing, box, state, { measurement }) { drawText(drawing, box, measurement); },
};
