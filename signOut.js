import { h } from "./dom.js";
import { APP, AUTH, CONFIG } from "./config.js";
import { signOutUrl } from "./draftLogic.js";

// Sign out (section 59), from the user menu. In order:
// 1. Unsaved work (a Notes draft with text or files, or files uploading): ask first, "You have unsaved notes. Sign out
//    anyway?" (Sign out / Cancel). Otherwise go on at once.
// 2. Stop the follow-ups poll, and destroy Atlas's credentials: IdentityManager.destroyCredentials() revokes each OAuth
//    token on the portal (oauth2/revokeToken, sent with keepAlive so leaving the page doesn't cancel it) and forgets it.
// 3. With AUTH.SIGNOUT_ENDS_SESSION, leave through the portal's OAuth sign-out, so the AGOL session ends too.
// 4. Land on the app's base URL (no ?parcel=, ?entry= or ?style=); the normal sign-in starts as on any load.
// Per-browser settings (theme, style, units, layer visibility...) stay; nothing personal stays in memory (the page goes).
// opts: { menu (userMenu.js), esriId, notes, followups, navigate (url) (default location.assign) }. Returns
// { signOut({ ask }), dialog } or null with no identity manager (nothing to sign out of).
export function setupSignOut({ menu, esriId, notes = null, followups = null, navigate = (url) => window.location.assign(url) }) {
  if (!esriId || !menu) return null;
  const T = APP.TEXT;
  const button = h("calcite-button", { appearance: "outline", kind: "neutral", width: "full", iconStart: "sign-out", class: "user-menu-signout", onclick: () => signOut() }, T.SIGN_OUT);
  menu.actions.append(button);

  // the question, as a small modal
  const yes = h("calcite-button", { slot: "footer-end", kind: "danger", class: "signout-yes", onclick: () => { dialog.open = false; go(); } }, T.SIGN_OUT_YES);
  const no = h("calcite-button", { slot: "footer-end", appearance: "outline", class: "signout-no", onclick: () => { dialog.open = false; } }, T.SIGN_OUT_CANCEL);
  const dialog = h("calcite-dialog", { modal: true, scale: "s", width: "s", heading: T.SIGN_OUT, class: "signout-dialog" }, h("p", { class: "signout-text" }, T.SIGN_OUT_ASK), no, yes);
  document.body.append(dialog);

  let leaving = false;
  function go() {
    if (leaving) return;
    leaving = true;
    button.loading = true;
    button.textContent = T.SIGNING_OUT;
    try { followups?.stop?.(); } catch { /* nothing to stop */ }
    try { esriId.destroyCredentials(); } catch (err) { console.warn("Sign out: couldn't clear the credentials:", err?.message ?? String(err)); }
    navigate(signOutUrl({ href: window.location.href, portalUrl: CONFIG.PORTAL_URL, appId: CONFIG.APP_ID, endSession: AUTH.SIGNOUT_ENDS_SESSION, path: AUTH.SIGNOUT_PATH }));
  }
  function signOut({ ask = true } = {}) {
    menu.close();
    const work = notes?.unsaved?.();
    if (ask && work?.unsaved) { dialog.open = true; return "asked"; }
    go();
    return "signed-out";
  }
  return { signOut, dialog, button };
}
