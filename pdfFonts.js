// Standard PDF Helvetica AFM advance widths, in 1/1000 em, indexed by WinAnsi byte.
// Canvas uses this table for positioning/wrapping too; never use browser measureText() for layout.
export const PRINT_FONT_FAMILY = "Helvetica, Arial, sans-serif";
const REGULAR = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 350,
  556, 350, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
  350, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 350, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const BOLD = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 350,
  556, 350, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 350, 611, 350,
  350, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 350, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

// Adobe AFM advances are identical for oblique and upright counterparts (including all WinAnsi glyphs).
// Keep distinct tables so font selection stays explicit in both drawing backends.
const OBLIQUE = REGULAR.slice(), BOLD_OBLIQUE = BOLD.slice();
export const HELVETICA_WIDTHS = Object.freeze({ regular: Object.freeze(REGULAR), bold: Object.freeze(BOLD),
  oblique: Object.freeze(OBLIQUE), boldOblique: Object.freeze(BOLD_OBLIQUE) });
const SPECIAL = new Map(Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ").map((char, i) => [char,
  [128,130,131,132,133,134,135,136,137,138,139,140,142,145,146,147,148,149,150,151,152,153,154,155,156,158,159][i]]));
const REPLACE = new Map([["−", "-"], ["→", "->"], ["←", "<-"], ["ﬁ", "fi"], ["ﬂ", "fl"], ["\u00a0", " "]]);
const byteOf = (char) => SPECIAL.get(char) ?? ((char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126)
  || (char.charCodeAt(0) >= 160 && char.charCodeAt(0) <= 255) ? char.charCodeAt(0) : null);

export function normalizePrintText(value) {
  let result = "";
  for (const char of String(value ?? "").replace(/\r\n?/g, "\n").normalize("NFC")) {
    if (char === "\n") result += char;
    else if (char === "\t") result += " ";
    else if (REPLACE.has(char)) result += REPLACE.get(char);
    else if (byteOf(char) !== null) result += char;
    else if (char.codePointAt(0) >= 32) {
      const plain = char.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
      result += plain && Array.from(plain).every((c) => byteOf(c) !== null) ? plain : "?";
    }
  }
  return result;
}

export function winAnsiBytes(value) {
  return Uint8Array.from(Array.from(normalizePrintText(value)), (char) => char === "\n" ? 10 : byteOf(char));
}

// ASCII-only PDF literal, including all high bytes as octal. Offsets never depend on UTF-8 string length.
export function pdfLiteral(value) {
  return "(" + Array.from(winAnsiBytes(value), (byte) => {
    if (byte === 40 || byte === 41 || byte === 92) return "\\" + String.fromCharCode(byte);
    return byte < 32 || byte > 126 ? "\\" + byte.toString(8).padStart(3, "0") : String.fromCharCode(byte);
  }).join("") + ")";
}

export function textWidth(value, size = 11, bold = false, italic = false) {
  if (!Number.isFinite(size) || size <= 0) throw new Error("Invalid print font size.");
  const widths = bold ? (italic ? BOLD_OBLIQUE : BOLD) : (italic ? OBLIQUE : REGULAR);
  return Array.from(winAnsiBytes(value)).reduce((sum, byte) => sum + widths[byte], 0) * size / 1000;
}

// Canvas draws each glyph at these advances to avoid browser kerning/fallback metrics moving the PDF layout.
export function glyphRuns(value, size = 11, bold = false, italic = false) {
  let x = 0;
  return Array.from(normalizePrintText(value), (char) => {
    const run = { char, x, width: textWidth(char, size, bold, italic) };
    x += run.width;
    return run;
  });
}

export function wrapText(value, width, size = 11, bold = false, italic = false) {
  if (!Number.isFinite(width) || width <= 0) throw new Error("Invalid print text width.");
  const lines = [];
  for (const paragraph of normalizePrintText(value).split("\n")) {
    let line = "";
    for (const word of paragraph.trim().split(/\s+/).filter(Boolean)) {
      if (line && textWidth(line + " " + word, size, bold, italic) <= width) { line += " " + word; continue; }
      if (line) { lines.push(line); line = ""; }
      for (const char of word) {
        if (line && textWidth(line + char, size, bold, italic) > width) { lines.push(line); line = ""; }
        line += char;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function textBlock(value, width, { size = 11, bold = false, italic = false, leading = size * 1.2 } = {}) {
  if (!Number.isFinite(leading) || leading <= 0) throw new Error("Invalid print line spacing.");
  const lines = wrapText(value, width, size, bold, italic);
  return { lines, height: lines.length * leading, leading, size, bold, italic,
    overflow: lines.some((line) => textWidth(line, size, bold, italic) > width) };
}

