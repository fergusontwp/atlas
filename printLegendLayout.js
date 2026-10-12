import { textStyle } from "./printTextStyle.js";
import { textBlock } from "./pdfFonts.js";
import { PRINT } from "./config.js";

// Whole entries flow down columns in SDK order. A heading repeats on continued columns.
export function legendLayout(layers, excluded, box, style = textStyle(null, "legend")) {
  const { MIN_COLUMN_PT, GAP_PT, SWATCH_PT } = PRINT.LEGEND;
  const columns = Math.max(1, Math.floor((box.width + GAP_PT) / (MIN_COLUMN_PT + GAP_PT)));
  const width = Math.max(0, (box.width - GAP_PT * (columns - 1)) / columns);
  const rows = [], active = layers.filter((layer) => !excluded.includes(layer.id));
  const total = active.reduce((n, layer) => n + layer.entries.length, 0);
  let column = 0, y = 0, shown = 0;
  for (const layer of active) {
    let needsHeading = true;
    for (const entry of layer.entries) {
      const heading = textBlock(layer.title, Math.max(1, width), style);
      const label = textBlock(entry.label, Math.max(1, width - SWATCH_PT - 5), style);
      const height = Math.max(SWATCH_PT, label.height) + 4;
      let headingHeight = needsHeading ? heading.height + 3 : 0;
      if (y + headingHeight + height > box.height) {
        column++; y = 0; needsHeading = true; headingHeight = heading.height + 3;
      }
      if (column >= columns || headingHeight + height > box.height || width <= SWATCH_PT + 5 || heading.overflow || label.overflow) return { rows, total, shown, cut: total - shown };
      const x = box.x + column * (width + GAP_PT);
      if (needsHeading) rows.push({ heading, box: { x, y: box.y + y, width, height: heading.height } });
      y += headingHeight;
      rows.push({ entry, label, box: { x, y: box.y + y, width, height } });
      y += height; shown++; needsHeading = false;
    }
    y += GAP_PT;
  }
  return { rows, total, shown, cut: total - shown };
}
