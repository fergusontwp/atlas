// URL parameters (?style=, ?parcel=). withParam is pure; setParam writes the address bar with history.replaceState
// (no reload, no new history entry), keeping every other parameter.
export const getParam = (search, key) => new URLSearchParams(search).get(key);

// `href` with `key` set to `value` (percent-encoded), or removed when value is null, undefined or "".
export function withParam(href, key, value) {
  const url = new URL(href);
  if (value === null || value === undefined || value === "") url.searchParams.delete(key);
  else url.searchParams.set(key, String(value));
  return url.toString();
}

export function setParam(key, value) {
  history.replaceState(history.state, "", withParam(location.href, key, value));
}
