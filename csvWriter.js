// CSV for the results table (pure). UTF-8 with a byte order mark (so Excel reads accents right), CRLF line endings, a field
// quoted when it contains a comma, a quote, CR or LF (quotes doubled). Cells are { t: "s", v } text, { t: "n", v } number,
// { t: "d", y, m, d } date (written YYYY-MM-DD) or empty (see xlsxWriter.js).
//
// Formula injection: a spreadsheet runs a cell that starts with = + - or @ (and tab or CR) as a formula, so TEXT that
// starts with one of them gets a leading single quote (the usual neutralizer: Excel shows the text without it). Numbers
// are written as numbers and are not touched. Excel may still convert some digit-only text (leading zeros, long IDs) when
// it opens a CSV, because a CSV has no types; the .xlsx doesn't, so it is the right export for parcel IDs.
const BOM = "﻿";
const FORMULA_START = /^[=+\-@\t\r]/;

export const guardFormula = (text) => (FORMULA_START.test(text) ? `'${text}` : text);

const pad = (n, w) => String(n).padStart(w, "0");

export function csvField(cell, { guard = true } = {}) {
  let text;
  if (cell === null || cell === undefined || cell.t === "e") text = "";
  else if (cell.t === "n") text = Number.isFinite(cell.v) ? String(cell.v) : "";
  else if (cell.t === "d") text = `${pad(cell.y, 4)}-${pad(cell.m, 2)}-${pad(cell.d, 2)}`;
  else text = guard ? guardFormula(String(cell.v ?? "")) : String(cell.v ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// header: [text]; rows: [[cell]]. Returns the whole file as a string (the BOM is its first character).
export function toCsv(header, rows) {
  const lines = [header.map((h) => csvField({ t: "s", v: h })).join(",")];
  for (const row of rows) lines.push(row.map((c) => csvField(c)).join(","));
  return BOM + lines.join("\r\n") + "\r\n";
}
