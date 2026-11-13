import { TABLE, WHATS_HERE } from "./config.js";
import { exportCell } from "./tableModel.js";
import { toCsv } from "./csvWriter.js";
import { buildXlsx } from "./xlsxWriter.js";
import { saveFile } from "./download.js";
import { exportInfoSheet, tableFileName } from "./tableGridLogic.js";

// The attribute table's downloads (attributeTable.js): CSV or Excel of the rows that match the current filters, in the
// current sort ("all rows"), or of the selected rows in table order. The visible columns, in the table's order, with
// the What's in this parcel export rules (tableModel.exportCell: real numbers and dates, coded values as descriptions,
// identifiers as text). The header cells follow WHATS_HERE.TABLE.EXPORT_HEADER (the one setting for both tables). Rows
// are read in pages of TABLE.EXPORT_PAGE by object id, with progress and a cancel signal; at most
// TABLE.EXPORT_MAX_ROWS. The Excel file starts with an "Export info" sheet.
//
// job: { tab, ids (in order), selected (bool), format: "csv" | "xlsx", fetchRows(ids, outFields, { signal }) -> Map,
//        info: { where, extent, search, selectedOnly, sort }, onProgress(done, total), signal }
// Resolves to { file, rows } once saved; throws an AbortError when cancelled.
export async function exportTable({ tab, ids, selected, format, fetchRows, info, onProgress = () => {}, signal }) {
  const columns = tab.columns;
  const header = columns.map((c) => (WHATS_HERE.TABLE.EXPORT_HEADER === "name" ? c.name : c.alias));
  const fields = [tab.layer.objectIdField, ...columns.map((c) => c.name)];
  const rows = [];
  onProgress(0, ids.length);
  for (let i = 0; i < ids.length; i += TABLE.EXPORT_PAGE) {
    signal?.throwIfAborted();
    const slice = ids.slice(i, i + TABLE.EXPORT_PAGE);
    const got = await fetchRows(slice, fields, { signal });
    for (const oid of slice) rows.push(columns.map((c) => exportCell(got.get(oid)?.[c.name], c)));
    onProgress(Math.min(ids.length, i + slice.length), ids.length);
  }
  signal?.throwIfAborted();
  const date = new Date();
  const title = tab.layer.title ?? "table";
  const file = tableFileName({ title, selected, date, ext: format });
  if (format === "csv") {
    saveFile(toCsv(header, rows), file, "text/csv;charset=utf-8");
  } else {
    const infoSheet = exportInfoSheet({ title, when: date, rows: rows.length, ...info });
    saveFile(buildXlsx([{ name: TABLE.TEXT.INFO_SHEET, ...infoSheet }, { name: title, header, rows }], { date }), file,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  return { file, rows: rows.length };
}
