import { APP } from "./config.js";

// About and the version (section 59): pure. tools/export_public.py writes version.json at each export.

// version.json's content, checked: { version, commit, built } with text values; anything else (unreadable, not an
// object, no version) is null. A commit is 7 to 40 hex characters, else null.
export function parseVersion(json) {
  let o = json;
  if (typeof json === "string") { try { o = JSON.parse(json); } catch { return null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const version = text(o.version);
  if (!version) return null;
  const commit = text(o.commit);
  return { version, commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null, built: text(o.built) };
}

// A release version as the README's rule writes it (section 60): the release date YYYY.MM.DD, then .1, .2 … for a
// second release on the same day. The date must be a real one.
export function validRelease(value) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.([1-9]\d*))?$/.exec(typeof value === "string" ? value : "");
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// The About line: "Version 2026.11.13 · a1b2c3d"; without the file, the config's release alone, or "Version unknown".
export function versionLine(info, cfg = APP) {
  if (info) return cfg.TEXT.VERSION_LINE(info.version, info.commit);
  return cfg.VERSION.RELEASE ? cfg.TEXT.VERSION_LINE(cfg.VERSION.RELEASE, null) : cfg.TEXT.VERSION_UNKNOWN;
}

// A newer copy is out when both commits are known and differ (no commit on either side: can't tell, so no).
export const isNewer = (loaded, latest) => !!(loaded?.commit && latest?.commit && loaded.commit !== latest.commit);
