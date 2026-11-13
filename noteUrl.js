// A note's optional link: the pure rules, tested. No DOM and no SDK imports.
//
// normalizeNoteUrl checks what was typed (and, on read, what is stored): only NOTES.URL_PROTOCOLS (http and https), no
// file or network paths (work PCs block file: links anyway, section 40), no spaces or control characters, no user name or
// password, at most NOTES.URL_MAX_CHARS. Text with no scheme that looks like a domain ("www.example.com/x") gets
// https://. new URL() only checks it: the text is kept as typed (the scheme lowercased), so a path, query or fragment such
// as Laserfiche's "#?id=123" comes back unchanged and isn't re-encoded.
import { NOTES } from "./config.js";

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
// host(.host)+ with an optional port, then a path, query, fragment or nothing
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i;

// { ok, url, reason }: ok with url null for empty text (no link); ok with the link to store; or not ok with a reason.
export function normalizeNoteUrl(text, cfg = NOTES) {
  const T = cfg.TEXT;
  const typed = String(text ?? "").trim();
  if (!typed) return { ok: true, url: null, reason: "" };
  const no = (reason) => ({ ok: false, url: null, reason });
  if (/^\\\\/.test(typed) || /^[a-z]:[\\/]/i.test(typed) || /\\/.test(typed)) return no(T.LINK_PATH);
  if (/\s/.test(typed)) return no(T.LINK_SPACES);
  if (/[\u0000-\u001f\u007f]/.test(typed)) return no(T.LINK_INVALID);
  let candidate = typed;
  const scheme = SCHEME.exec(typed)?.[1];
  // "www.example.com:8080/x" reads as a scheme to the pattern; a dotted "scheme" is a host
  if (scheme && !scheme.includes(".")) {
    if (!cfg.URL_PROTOCOLS.includes(`${scheme.toLowerCase()}:`)) return no(scheme.toLowerCase() === "file" ? T.LINK_PATH : T.LINK_SCHEME);
    candidate = `${scheme.toLowerCase()}${typed.slice(scheme.length)}`;
  } else if (DOMAIN.test(typed)) {
    candidate = `https://${typed}`;
  } else {
    return no(T.LINK_INVALID);
  }
  if (candidate.length > cfg.URL_MAX_CHARS) return no(T.LINK_TOO_LONG(cfg.URL_MAX_CHARS));
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return no(T.LINK_INVALID);
  }
  if (!cfg.URL_PROTOCOLS.includes(parsed.protocol)) return no(T.LINK_SCHEME);
  if (parsed.username || parsed.password || /^[a-z]+:\/\/[^/?#]*@/i.test(candidate)) return no(T.LINK_CREDENTIALS);
  if (!parsed.hostname || !/^[a-z]+:\/\/[^/?#]/i.test(candidate)) return no(T.LINK_INVALID);
  return { ok: true, url: candidate, reason: "" };
}

// The link's text in the list: its host name without the port ("app.laserfiche.com"); "" if it doesn't parse.
export function urlLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// How a stored link is shown, checked again on read (another tool may have written it): { href, label } for a link,
// { text } for a value that fails the check (shown as plain text, never as a link), or null for none.
export function noteLink(stored, cfg = NOTES) {
  if (stored === null || stored === undefined || String(stored).trim() === "") return null;
  const { ok, url } = normalizeNoteUrl(stored, cfg);
  if (!ok || !url) return { text: String(stored) };
  return { href: url, label: urlLabel(url) || url };
}
