import { sketchPath } from "./printSketchMath.js";
// A one-page PDF writer and drawing backend. No DOM, SDK, or compression dependency.
// Images arrive encoded: white-flattened JPEG map, optional Flate RGB legend swatches.
import { PRINT } from "./config.js";
import { pdfLiteral, normalizePrintText, textWidth } from "./pdfFonts.js";

const encoder = new TextEncoder(), bytes = (value) => encoder.encode(value);
const join = (parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
const number = (value) => {
  if (!Number.isFinite(value)) throw new Error("Invalid PDF coordinate.");
  return String(Number(value.toFixed(6)));
};
const color = (value) => {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Invalid PDF color.");
  return [1, 3, 5].map((i) => number(parseInt(value.slice(i, i + 2), 16) / 255)).join(" ");
};
const stream = (dictionary, data) => join([bytes(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, bytes("\nendstream")]);
// Info strings use Unicode UTF-16BE, not the font's WinAnsi character codes.
const metadataText = (value) => "<feff" + Array.from(normalizePrintText(value), (char) => char.charCodeAt(0).toString(16).padStart(4, "0")).join("") + ">";

export function createPdfDrawing({ width, height, title = "", images = [] }) {
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) throw new Error("Invalid PDF page size.");
  const ids = new Map(), commands = [], extraFonts = new Set(), transparencies = new Map();
  images.forEach((image, index) => {
    if (ids.has(image.id) || !image.id || !(image.data instanceof Uint8Array) || !image.data.length
      || ![image.width, image.height].every((n) => Number.isInteger(n) && n > 0)
      || !["DCTDecode", "FlateDecode"].includes(image.filter)) throw new Error("Invalid PDF image.");
    ids.set(image.id, index);
  });
  const point = (x, y) => `${number(x)} ${number(height - y)}`;
  const styleCommand = ({ fill, stroke, width: lineWidth = 1, opacity = 1, cap = "butt", join: lineJoin = "miter" }) => {
    if (!Number.isFinite(lineWidth) || lineWidth < 0) throw new Error("Invalid PDF line width.");
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !["butt", "round", "square"].includes(cap) || !["miter", "round", "bevel"].includes(lineJoin)) throw new Error("Invalid PDF path style.");
    let alpha = "";
    if (opacity !== 1) { if (!transparencies.has(opacity)) transparencies.set(opacity, `G${transparencies.size}`); alpha = `/${transparencies.get(opacity)} gs\n`; }
    return alpha + `${["butt", "round", "square"].indexOf(cap)} J ${["miter", "round", "bevel"].indexOf(lineJoin)} j\n` + (fill ? `${color(fill)} rg\n` : "") + (stroke ? `${color(stroke)} RG ${number(lineWidth)} w\n` : "");
  };
  const drawing = {
    path(points, style = {}) {
      if (points.length < 2) throw new Error("A PDF path needs two points.");
      const path = style.smooth ? sketchPath(points).map((p) => p.type === "move" ? `${point(p.x, p.y)} m` : `${point(p.x1, p.y1)} ${point(p.x2, p.y2)} ${point(p.x, p.y)} c`).join("\n")
        : points.map((p, i) => point(p.x, p.y) + (i ? " l" : " m")).join("\n");
      commands.push("q\n" + styleCommand(style) + path + (style.close ? "\nh" : "")
        + "\n" + (style.fill && style.stroke ? "B" : style.fill ? "f" : "S") + "\nQ\n");
    },
    line(x1, y1, x2, y2, style = {}) { drawing.path([{ x: x1, y: y1 }, { x: x2, y: y2 }], { stroke: "#000000", ...style }); },
    rect(box, style = {}) {
      if (![box.width, box.height].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("Invalid PDF rectangle.");
      commands.push("q\n" + styleCommand(style) + `${point(box.x, box.y + box.height)} ${number(box.width)} ${number(box.height)} re\n`
        + (style.fill && style.stroke ? "B" : style.fill ? "f" : "S") + "\nQ\n");
    },
    clip(box, draw) {
      if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 0 || box.height < 0) throw new Error("Invalid PDF clip.");
      commands.push(`q ${point(box.x, box.y + box.height)} ${number(box.width)} ${number(box.height)} re W n\n`);
      try { draw(); } finally { commands.push("Q\n"); }
    },
    text(value, x, y, { size = 11, bold = false, italic = false, underline = false, fill = "#000000", align = "left", halo, haloWidth = 3 } = {}) {
      const text = normalizePrintText(value);
      if (text.includes("\n")) throw new Error("Draw wrapped PDF text one line at a time.");
      if (!["left", "center", "right"].includes(align)) throw new Error("Invalid PDF text alignment.");
      const advance = textWidth(text, size, bold, italic);
      const left = x - (align === "center" ? advance / 2 : align === "right" ? advance : 0);
      const font = italic ? (bold ? "F4" : "F3") : (bold ? "F2" : "F1");
      if (italic) extraFonts.add(font);
      const command = (mode) => `BT /${font} ${number(size)} Tf ${mode} Tr 1 0 0 1 ${point(left, y)} Tm ${pdfLiteral(text)} Tj ET\n`;
      // Stroke first, then fill, matching canvas halos without fattening the dark glyphs.
      if (halo && (!Number.isFinite(haloWidth) || haloWidth < 0)) throw new Error("Invalid PDF halo width.");
      commands.push(`q ${color(fill)} rg\n` + (halo ? `${color(halo)} RG ${number(haloWidth)} w 1 j\n${command(1)}` : "") + command(0) + "Q\n");
      if (underline && advance) drawing.line(left, y + size * PRINT.TEXT.UNDERLINE_OFFSET, left + advance, y + size * PRINT.TEXT.UNDERLINE_OFFSET,
        { stroke: fill, width: Math.max(PRINT.TEXT.MIN_UNDERLINE_PT, size * PRINT.TEXT.UNDERLINE_WIDTH) });
    },
    image(id, box) {
      if (!ids.has(id)) throw new Error("Missing PDF image.");
      if (![box.width, box.height].every((n) => Number.isFinite(n) && n > 0)) throw new Error("Invalid PDF image box.");
      commands.push(`q ${number(box.width)} 0 0 ${number(box.height)} ${point(box.x, box.y + box.height)} cm /I${ids.get(id)} Do Q\n`);
    },
    finish() {
      const imageResources = images.map((image, i) => `/I${i} ${7 + i} 0 R`).join(" ");
      const fonts = [...extraFonts].sort(), fontStart = 7 + images.length;
      const fontResources = fonts.map((font, i) => `/${font} ${fontStart + i} 0 R`).join(" ");
      const alphaStart = fontStart + fonts.length, alphaValues = [...transparencies];
      const alphaResources = alphaValues.map(([value, name], i) => `/${name} ${alphaStart + i} 0 R`).join(" ");
      const infoId = alphaStart + alphaValues.length;
      const objects = [
        bytes("<< /Type /Catalog /Pages 2 0 R >>"),
        bytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        bytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R ${fontResources} >> /XObject << ${imageResources} >> /ExtGState << ${alphaResources} >> >> /Contents 6 0 R >>`),
        bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
        bytes("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
        stream("", bytes(commands.join(""))),
        ...images.map((image) => stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${image.filter}`, image.data)),
        ...fonts.map((font) => bytes(`<< /Type /Font /Subtype /Type1 /BaseFont /${font === "F3" ? "Helvetica-Oblique" : "Helvetica-BoldOblique"} /Encoding /WinAnsiEncoding >>`)),
        ...alphaValues.map(([value]) => bytes(`<< /Type /ExtGState /CA ${number(value)} /ca ${number(value)} >>`)),
        bytes(`<< /Title ${metadataText(title)} /Producer (Atlas) >>`),
      ];
      const parts = [join([bytes("%PDF-1.4\n%"), Uint8Array.of(226, 227, 207, 211), bytes("\n")])], offsets = [0];
      let length = parts[0].length;
      objects.forEach((object, i) => {
        offsets.push(length);
        const part = join([bytes(`${i + 1} 0 obj\n`), object, bytes("\nendobj\n")]);
        parts.push(part); length += part.length;
      });
      const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
      parts.push(bytes(xref + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
      return join(parts);
    },
  };
  return drawing;
}
