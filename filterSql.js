// Pure SQL generation for the parcel filter. No DOM and no SDK imports, so it can be tested alone.
//
// state = { match: "AND" | "OR", conditions: [{ field, op, value, value2 }], rawSql: string | null }
//   value is an array for "in" / "notIn".
// fieldInfoByName[name] = { name, kind: "string" | "numeric" | "date", type }  (type is the SDK field type)

// Something the user can fix (an empty or invalid value); the message is shown as written.
export class FilterError extends Error {}

// Field types that can't be filtered with a simple value.
const SKIPPED_TYPES = new Set([
  "oid", "global-id", "guid", "geometry", "blob", "raster", "xml", "time-only", "timestamp-offset",
]);
const NUMERIC_TYPES = new Set(["small-integer", "integer", "long", "big-integer", "single", "double"]);
const DATE_TYPES = new Set(["date", "date-only"]);

// "string" | "numeric" | "date", or null when the field can't be offered.
export function kindOf(field) {
  if (SKIPPED_TYPES.has(field.type)) return null;
  if (field.domain?.type === "range") return "numeric";
  if (NUMERIC_TYPES.has(field.type)) return "numeric";
  if (DATE_TYPES.has(field.type)) return "date";
  if (field.type === "string") return "string";
  return null;
}

// arity: 0 no value, 1 one value, 2 two values, "list" several values
const op = (id, label, arity) => ({ id, label, arity });
const NULLS = [op("isNull", "is null", 0), op("notNull", "is not null", 0)];

export const OPERATORS = {
  string: [
    op("eq", "equals", 1), op("ne", "not equals", 1),
    op("contains", "contains", 1), op("notContains", "does not contain", 1),
    op("startsWith", "starts with", 1), op("endsWith", "ends with", 1),
    op("in", "is one of", "list"), op("notIn", "is not one of", "list"),
    ...NULLS,
  ],
  numeric: [
    op("eq", "=", 1), op("ne", "<>", 1), op("lt", "<", 1), op("le", "<=", 1), op("gt", ">", 1), op("ge", ">=", 1),
    op("between", "between", 2), op("notBetween", "not between", 2),
    op("in", "is one of", "list"), op("notIn", "is not one of", "list"),
    ...NULLS,
  ],
  date: [
    op("on", "on", 1), op("before", "before", 1), op("onOrBefore", "on or before", 1),
    op("after", "after", 1), op("onOrAfter", "on or after", 1), op("between", "between", 2),
    ...NULLS,
  ],
};

export const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;

// A finite number, written back out as a number. Never passes the raw text through.
export function validateNumber(v, label = "value") {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
    throw new FilterError(`Enter a ${label}.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new FilterError(`"${v}" isn't a number.`);
  return String(n);
}

// YYYY-MM-DD that is a real calendar day.
function validateDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? "").trim());
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new FilterError(`"${v ?? ""}" isn't a date. Use YYYY-MM-DD.`);
  }
  return m[0];
}

function nextDay(day) {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

function list(values, kind) {
  const items = (Array.isArray(values) ? values : [values]).filter((v) => v !== null && v !== undefined && String(v) !== "");
  if (items.length === 0) throw new FilterError("Pick at least one value.");
  return items.map((v) => (kind === "numeric" ? validateNumber(v) : quote(v))).join(", ");
}

function stringCondition(f, o, c) {
  const need = () => {
    if (c.value === null || c.value === undefined || String(c.value) === "") throw new FilterError("Enter a value.");
  };
  switch (o) {
    case "eq": need(); return `${f} = ${quote(c.value)}`;
    case "ne": need(); return `(${f} <> ${quote(c.value)} OR ${f} IS NULL)`;
    case "contains": need(); return `UPPER(${f}) LIKE ${quote(`%${String(c.value).toUpperCase()}%`)}`;
    case "notContains": need(); return `(UPPER(${f}) NOT LIKE ${quote(`%${String(c.value).toUpperCase()}%`)} OR ${f} IS NULL)`;
    case "startsWith": need(); return `UPPER(${f}) LIKE ${quote(`${String(c.value).toUpperCase()}%`)}`;
    case "endsWith": need(); return `UPPER(${f}) LIKE ${quote(`%${String(c.value).toUpperCase()}`)}`;
    case "in": return `${f} IN (${list(c.value, "string")})`;
    case "notIn": return `(${f} NOT IN (${list(c.value, "string")}) OR ${f} IS NULL)`;
    default: return null;
  }
}

function numericCondition(f, o, c) {
  const one = () => validateNumber(c.value);
  const range = () => {
    const a = validateNumber(c.value, "starting value");
    const b = validateNumber(c.value2, "ending value");
    if (Number(a) > Number(b)) throw new FilterError("The first number must not be larger than the second.");
    return `${a} AND ${b}`;
  };
  switch (o) {
    case "eq": return `${f} = ${one()}`;
    case "ne": return `(${f} <> ${one()} OR ${f} IS NULL)`;
    case "lt": return `${f} < ${one()}`;
    case "le": return `${f} <= ${one()}`;
    case "gt": return `${f} > ${one()}`;
    case "ge": return `${f} >= ${one()}`;
    case "between": return `${f} BETWEEN ${range()}`;
    case "notBetween": return `(${f} NOT BETWEEN ${range()} OR ${f} IS NULL)`;
    case "in": return `${f} IN (${list(c.value, "numeric")})`;
    case "notIn": return `(${f} NOT IN (${list(c.value, "numeric")}) OR ${f} IS NULL)`;
    default: return null;
  }
}

// Calendar days are written as wall-clock days in the field's own time zone, which is how the
// Query docs word date literals (DATE 'YYYY-MM-DD' / TIMESTAMP 'YYYY-MM-DD HH:MI:SS').
function dateCondition(f, o, c, type) {
  if (type === "date-only") {
    const d = (v) => `DATE '${validateDay(v)}'`;
    switch (o) {
      case "on": return `${f} = ${d(c.value)}`;
      case "before": return `${f} < ${d(c.value)}`;
      case "onOrBefore": return `${f} <= ${d(c.value)}`;
      case "after": return `${f} > ${d(c.value)}`;
      case "onOrAfter": return `${f} >= ${d(c.value)}`;
      case "between": return `${f} BETWEEN ${d(c.value)} AND ${d(c.value2)}`;
      default: return null;
    }
  }
  const start = (v) => `TIMESTAMP '${validateDay(v)} 00:00:00'`;
  const after = (v) => `TIMESTAMP '${nextDay(validateDay(v))} 00:00:00'`;
  switch (o) {
    case "on": return `(${f} >= ${start(c.value)} AND ${f} < ${after(c.value)})`;
    case "before": return `${f} < ${start(c.value)}`;
    case "onOrBefore": return `${f} < ${after(c.value)}`;
    case "after": return `${f} >= ${after(c.value)}`;
    case "onOrAfter": return `${f} >= ${start(c.value)}`;
    case "between": return `(${f} >= ${start(c.value)} AND ${f} < ${after(c.value2)})`;
    default: return null;
  }
}

function conditionSql(c, fieldInfoByName) {
  const info = fieldInfoByName[c.field];
  if (!info) throw new FilterError(`Unknown field "${c.field}".`);
  const f = info.name; // from the layer schema, never free text
  if (c.op === "isNull") return `${f} IS NULL`;
  if (c.op === "notNull") return `${f} IS NOT NULL`;
  const sql =
    info.kind === "numeric" ? numericCondition(f, c.op, c)
    : info.kind === "date" ? dateCondition(f, c.op, c, info.type)
    : stringCondition(f, c.op, c);
  if (sql === null) throw new FilterError(`"${c.op}" can't be used on ${info.name}.`);
  return sql;
}

// The user's where clause, or null for "no filter". Throws FilterError for values that can't be used.
export function buildWhere(state, fieldInfoByName) {
  // rawSql is null unless the user is editing SQL directly; then it is the filter, even when empty.
  if (typeof state?.rawSql === "string") return state.rawSql.trim() || null;
  const conditions = (state?.conditions ?? []).filter((c) => c.field && c.op);
  if (conditions.length === 0) return null;
  const parts = conditions.map((c) => conditionSql(c, fieldInfoByName));
  if (parts.length === 1) return parts[0];
  const wrap = (p) => (p.startsWith("(") ? p : `(${p})`);
  return parts.map(wrap).join(state.match === "OR" ? " OR " : " AND ");
}

// What goes on layer.definitionExpression. With no user filter the original comes back unchanged.
export function combineWithOriginal(original, userWhere) {
  if (!userWhere) return original;
  return original && String(original).trim() ? `(${original}) AND (${userWhere})` : userWhere;
}
