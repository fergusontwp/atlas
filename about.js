import { h } from "./dom.js";
import { APP } from "./config.js";
import { isNewer, parseVersion, versionLine } from "./versionInfo.js";

// About in the user menu (section 59): "Version 2026.11.12 · a1b2c3d" from version.json (written by
// tools/export_public.py at each export), read once at startup. When the menu opens, the file is read again with
// cache: "no-store": a different commit means this browser holds an old copy, so "A newer version is available" shows
// with Reload. No polling. A file that can't be read shows APP.VERSION.RELEASE alone (section 60) or "Version unknown", never an error.
// opts: { menu (userMenu.js), read () -> Promise of the file's JSON or null, reload () }. Returns { state, check() }.
export function setupAbout({ menu, read = readVersionFile, reload = () => window.location.reload() }) {
  const T = APP.TEXT;
  let loaded = null, latest = null;
  const line = h("span", { class: "about-line" });
  const newer = h("div", { class: "about-newer", hidden: true }, h("span", {}, T.NEWER),
    h("calcite-button", { scale: "s", appearance: "outline", iconStart: "refresh", class: "about-reload", onclick: () => reload() }, T.RELOAD));
  menu.about.append(h("div", { class: "about-heading" }, T.ABOUT), line, newer);

  function render() {
    const text = versionLine(loaded);
    const url = loaded?.commit && APP.VERSION.COMMIT_URL ? `${APP.VERSION.COMMIT_URL}${loaded.commit}` : null;
    if (url) {
      const [before] = text.split(loaded.commit);
      const a = h("a", { href: url, target: "_blank", rel: "noopener" });
      a.textContent = loaded.commit;
      line.replaceChildren(document.createTextNode(before), a);
    } else {
      line.textContent = text;
    }
    newer.hidden = !isNewer(loaded, latest);
  }
  async function check() {
    latest = parseVersion(await read());
    render();
    return latest;
  }
  const ready = read().then((json) => { loaded = parseVersion(json); render(); });
  menu.popover.addEventListener("calcitePopoverOpen", () => { ready.then(check); });
  render();
  return { check, get state() { return { loaded, latest, newer: isNewer(loaded, latest) }; } };
}

async function readVersionFile() {
  try {
    const r = await fetch(APP.VERSION.FILE, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
