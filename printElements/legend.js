import { textStyle } from "../printTextStyle.js";
import { PRINT } from "../config.js";
import { legendLayout } from "../printLegendLayout.js";
import { drawText } from "./text.js";
export default {
  id: "legend", label: "Legend", defaultSlot: "body", defaultState: { on: true, excluded: [] },
  controls: [{ type: "legend", label: "Layers in printed legend" }, { type: "text-style", key: "textStyle", profile: "legend", label: "Text style" }],
  measure({ box, state, legend = [], legendStatus }) {
    const entries = legendStatus && legendStatus !== "ready" ? [{ id: "legend-status", title: "Legend",
      entries: [{ label: legendStatus === "loading" ? "Legend unavailable (still loading)" : "Legend unavailable", unavailable: true }] }] : legend;
    return { height: 0, weight: 1, ...legendLayout(entries, state.excluded, box, textStyle(state.textStyle, "legend")) };
  },
  draw(drawing, box, state, { measurement }) {
    for (const row of measurement.rows) {
      if (row.heading) drawText(drawing, row.box, row.heading);
      else {
        const swatch = { x: row.box.x, y: row.box.y, width: PRINT.LEGEND.SWATCH_PT, height: PRINT.LEGEND.SWATCH_PT };
        if (row.entry.image) drawing.image(row.entry.image, swatch);
        else { drawing.rect(swatch, { stroke: "#777777", width: 0.5 }); drawing.line(swatch.x, swatch.y, swatch.x + swatch.width, swatch.y + swatch.height, { stroke: "#777777", width: 0.5 }); }
        drawText(drawing, { ...row.box, x: row.box.x + swatch.width + 5, width: row.box.width - swatch.width - 5 }, row.label);
      }
    }
  },
};
