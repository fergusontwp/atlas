import { sketchPath } from "./printSketchMath.js";
import { PRINT } from "./config.js";
import { PRINT_FONT_FAMILY, glyphRuns, textWidth } from "./pdfFonts.js";

// Same page-point/top-left drawing contract as pdfWriter.js. Helvetica advances govern every glyph.
export function createCanvasDrawing(canvas, pixelsPerPoint, images) {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(pixelsPerPoint, 0, 0, pixelsPerPoint, 0, 0);
  const style = (options) => {
    ctx.lineWidth = options.width ?? 1; ctx.lineJoin = options.join ?? "miter"; ctx.lineCap = options.cap ?? "butt";
    ctx.strokeStyle = options.stroke ?? "#000000"; ctx.fillStyle = options.fill ?? "#000000";
  };
  return {
    rect({ x, y, width, height }, options = {}) {
      style(options);
      if (options.fill) ctx.fillRect(x, y, width, height);
      if (options.stroke) ctx.strokeRect(x, y, width, height);
    },
    line(x1, y1, x2, y2, options = {}) {
      style(options); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    },
    path(points, options = {}) {
      if (!points.length) return;
      ctx.save(); ctx.globalAlpha = options.opacity ?? 1;
      style(options); ctx.beginPath();
      if (options.smooth) for (const p of sketchPath(points)) {
        if (p.type === "move") ctx.moveTo(p.x, p.y); else ctx.bezierCurveTo(p.x1, p.y1, p.x2, p.y2, p.x, p.y);
      }
      else { ctx.moveTo(points[0].x, points[0].y); points.slice(1).forEach(({ x, y }) => ctx.lineTo(x, y)); }
      if (options.close) ctx.closePath();
      if (options.fill) ctx.fill();
      if (options.stroke) ctx.stroke(); ctx.restore();
    },
    clip(box, draw) { ctx.save(); try { ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip(); draw(); } finally { ctx.restore(); } },
    text(value, x, y, { size = 11, bold = false, italic = false, underline = false, fill = "#000000", align = "left", halo, haloWidth = 3 } = {}) {
      if (!["left", "center", "right"].includes(align)) throw new Error("Invalid print text alignment.");
      const advance = textWidth(value, size, bold, italic), left = x - (align === "center" ? advance / 2 : align === "right" ? advance : 0);
      ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${size}px ${PRINT_FONT_FAMILY}`;
      ctx.textBaseline = "alphabetic"; ctx.fillStyle = fill;
      const runs = glyphRuns(value, size, bold, italic);
      if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = haloWidth; ctx.lineJoin = "round"; runs.forEach((run) => ctx.strokeText(run.char, left + run.x, y)); }
      runs.forEach((run) => ctx.fillText(run.char, left + run.x, y));
      if (underline && advance) { ctx.beginPath(); ctx.strokeStyle = fill; ctx.lineCap = "butt";
        ctx.lineWidth = Math.max(PRINT.TEXT.MIN_UNDERLINE_PT, size * PRINT.TEXT.UNDERLINE_WIDTH);
        ctx.moveTo(left, y + size * PRINT.TEXT.UNDERLINE_OFFSET); ctx.lineTo(left + advance, y + size * PRINT.TEXT.UNDERLINE_OFFSET); ctx.stroke(); }
    },
    image(id, box) { ctx.drawImage(images.get(id), box.x, box.y, box.width, box.height); },
  };
}
