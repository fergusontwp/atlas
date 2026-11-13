// A minimal, valid .xlsx writer (no DOM, no dependencies; the zip is zipWriter.js). A workbook is a zip of a few XML parts:
// [Content_Types].xml, _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels, xl/styles.xml and one worksheet per sheet.
// Strings are inline strings (t="inlineStr"), so there is no shared-strings part, and text is always text: Excel never
// converts a parcel ID typed as a string. Dates are serial numbers with a date format. The header row is bold, frozen and has
// an autofilter.
//
// A sheet is { name, header: [text], rows: [[cell]] } and a cell is one of
//   { t: "s", v: text }  { t: "n", v: number }  { t: "d", y, m, d }  { t: "e" } (empty; also null or undefined)
import { zip } from "./zipWriter.js";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAX_CELL_CHARS = 32767; // Excel's limit for the text of a cell
const MAX_SHEET_NAME = 31;
const STYLE = { DEFAULT: 0, HEADER: 1, DATE: 2 }; // cellXfs indexes in styles.xml

// XML 1.0 allows tab, LF, CR, U+0020-U+D7FF, U+E000-U+FFFD and U+10000 up and nothing else: control characters, lone
// surrogates and U+FFFE/U+FFFF are removed (an XML parser, and so Excel, rejects the whole part otherwise).
export function stripInvalidXml(text) {
  let out = "";
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000) out += ch;
  }
  return out; // `for...of` yields a lone surrogate as its own "character" (0xD800-0xDFFF), which the test above drops
}

export const escapeXml = (text) =>
  stripInvalidXml(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// Excel's serial number for a calendar day: whole days since 1899-12-30, which is right for every day from 1900-03-01 on
// (Excel counts a 1900-02-29 that never existed, so earlier days are one less: 1900-01-01 is 1).
export function excelSerial(y, m, d) {
  const days = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  return days < 61 ? days - 1 : days;
}

// Column letters: 1 -> A, 26 -> Z, 27 -> AA.
export function columnName(n) {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Sheet names: at most 31 characters, none of [ ] : * ? / \, not starting or ending with an apostrophe, not empty, and
// unique within the workbook ignoring case (a clash gets " (2)", " (3)", ... inside the 31 characters).
export function sheetNames(titles) {
  const used = new Set();
  return titles.map((title) => {
    let base = stripInvalidXml(title ?? "").replace(/[[\]:*?/\\]/g, "_").replace(/[\r\n\t]+/g, " ").trim().replace(/^'+|'+$/g, "").trim();
    if (!base) base = "Sheet";
    base = [...base].slice(0, MAX_SHEET_NAME).join("");
    let name = base, n = 1;
    while (used.has(name.toLowerCase())) {
      n++;
      const suffix = ` (${n})`;
      name = [...base].slice(0, MAX_SHEET_NAME - suffix.length).join("").trimEnd() + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

const textOf = (v) => [...stripInvalidXml(v)].slice(0, MAX_CELL_CHARS).join("");

function cellXml(ref, cell, isHeader) {
  if (cell === null || cell === undefined || cell.t === "e") return "";
  const style = isHeader ? ` s="${STYLE.HEADER}"` : "";
  if (isHeader || cell.t === "s") {
    const text = textOf(isHeader && typeof cell === "string" ? cell : cell.v ?? "");
    if (text === "") return "";
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }
  if (cell.t === "n") return Number.isFinite(cell.v) ? `<c r="${ref}"><v>${cell.v}</v></c>` : "";
  if (cell.t === "d") return `<c r="${ref}" s="${STYLE.DATE}"><v>${excelSerial(cell.y, cell.m, cell.d)}</v></c>`;
  return "";
}

// Widths in characters from the header and the first rows, between 8 and 60.
function columnWidths(sheet) {
  const widths = sheet.header.map((h) => [...String(h)].length + 3);
  for (const row of sheet.rows.slice(0, 50)) {
    row.forEach((cell, i) => {
      const len = !cell ? 0 : cell.t === "s" ? [...String(cell.v)].length : cell.t === "n" ? String(cell.v).length : cell.t === "d" ? 10 : 0;
      widths[i] = Math.max(widths[i] ?? 0, len + 2);
    });
  }
  return widths.map((w) => Math.min(60, Math.max(8, w)));
}

function sheetXml(sheet) {
  const cols = sheet.header.length;
  const lastRow = sheet.rows.length + 1;
  const range = `A1:${columnName(Math.max(cols, 1))}${lastRow}`;
  const rows = [];
  rows.push(`<row r="1">${sheet.header.map((h, i) => cellXml(`${columnName(i + 1)}1`, h, true)).join("")}</row>`);
  sheet.rows.forEach((row, r) => {
    const cells = row.map((cell, i) => cellXml(`${columnName(i + 1)}${r + 2}`, cell, false)).join("");
    rows.push(`<row r="${r + 2}">${cells}</row>`);
  });
  const colXml = columnWidths(sheet).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}">`
    + `<dimension ref="${range}"/>`
    + `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"/>`
    + `<cols>${colXml}</cols>`
    + `<sheetData>${rows.join("")}</sheetData>`
    + `<autoFilter ref="${range}"/>`
    + `</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS_MAIN}">`
  + `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`
  + `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>`
  + `</styleSheet>`;

// sheets: [{ name, header, rows }] in workbook order. Returns the file as a Uint8Array.
export function buildXlsx(sheets, { date = new Date() } = {}) {
  const names = sheetNames(sheets.map((s) => s.name));
  const n = sheets.length;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS_CT}">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + `</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}">`
    + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + `<bookViews><workbookView/></bookViews><sheets>`
    + names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
    + `</sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}">`
    + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="rId${n + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ], { date });
}
