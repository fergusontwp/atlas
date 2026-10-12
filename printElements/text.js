import { textBlock } from "../pdfFonts.js";
import { PRINT } from "../config.js";
export function measureText(text, box, size = 8, bold = false) {
  const style = typeof size === "object" ? size : { size, bold };
  const block = text ? textBlock(text, Math.max(1, box.width), { ...style, leading: style.size * PRINT.TEXT.LEADING })
    : { lines: [], height: 0, leading: style.size * PRINT.TEXT.LEADING, ...style };
  return { ...block, ...style };
}
export function drawText(drawing, box, block) {
  const x = box.x + (block.align === "center" ? box.width / 2 : block.align === "right" ? box.width : 0);
  block.lines.slice(0, Math.floor((box.height + 1e-7) / block.leading)).forEach((line, i) =>
    drawing.text(line, x, box.y + block.size + i * block.leading, { size: block.size, bold: block.bold,
      italic: block.italic, underline: block.underline, fill: block.color ?? "#000000", align: block.align ?? "left" }));
}
