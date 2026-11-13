import { h } from "./dom.js";
import { APP, CONFIG } from "./config.js";
import { displayName, initialsOf } from "./userLogic.js";

// The header's user button and its menu (section 59). The button, at the header's right end after Follow-ups (n),
// shows the signed-in user's initials in a circle (or their portal picture) and, when the window is at least
// APP.HEADER.NAME_MIN_WIDTH wide, their full name. It is a native <button>, so Enter and Space open the menu. The menu
// (a calcite-popover anchored to it) holds, in order: who (full name, then the username), Theme (Light, Dark, Match
// system), About, and Sign out (the last two added by their own modules into `about` and `actions`).
// Not signed in (no APP_ID, or a public map): a person icon, and the menu has Theme and About only.
//
// Esc while the menu is open closes it and puts focus back on the button, and goes no further: the listener is on the
// window in the capture phase and added at startup, before any of the app's own Esc listeners (which are added while
// their dialog, card or drawing is open), so it runs first.
// opts: { theme (theme.js), host (the header element to fill; #user) }. Returns { setUser(user | null), about, actions,
// button, popover, open(), close(), get state() }.
export function setupUserMenu({ theme, host = document.getElementById("user") } = {}) {
  const T = APP.TEXT;
  let user = null; // { name, username, thumbnail (object URL) } or null
  let thumbFailed = false;

  const avatar = h("span", { class: "user-avatar" });
  avatar.setAttribute("aria-hidden", "true");
  const nameEl = h("span", { class: "user-name" });
  const button = h("button", { type: "button", class: "user-button", id: "user-button" }, avatar, nameEl);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  host.replaceChildren(button);

  // ---- the menu
  const whoName = h("div", { class: "user-menu-name" });
  const whoUser = h("div", { class: "user-menu-username" });
  const who = h("div", { class: "user-menu-who" }, whoName, whoUser);
  const themeControl = h("calcite-segmented-control", { scale: "s", width: "full", label: T.THEME, class: "user-menu-theme",
    oncalciteSegmentedControlChange: () => theme?.set(themeControl.value) },
  ...APP.THEME.VALUES.map((v) => h("calcite-segmented-control-item", { value: v, checked: theme?.get() === v }, T.THEME_LABELS[v])));
  const about = h("div", { class: "user-menu-about" });
  const actions = h("div", { class: "user-menu-actions" });
  const body = h("div", { class: "user-menu-body" }, who,
    h("calcite-label", { scale: "s", class: "user-menu-field" }, T.THEME, themeControl), about, actions);
  const popover = h("calcite-popover", { label: T.MENU_HEADING, scale: "s", autoClose: true, triggerDisabled: true, overlayPositioning: "fixed",
    placement: "bottom-end", referenceElement: button, class: "user-menu" }, body);
  document.body.append(popover);
  popover.addEventListener("calcitePopoverOpen", () => {
    button.setAttribute("aria-expanded", "true");
    themeControl.setFocus?.();
  });
  popover.addEventListener("calcitePopoverClose", () => button.setAttribute("aria-expanded", "false"));
  const open = () => { popover.open = true; };
  const close = (focusButton = false) => { popover.open = false; if (focusButton) button.focus(); };
  button.addEventListener("click", () => (popover.open ? close() : open()));
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !popover.open) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    close(true);
  }, true);
  theme?.onChange?.(() => themeControl.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === theme.get(); }));

  // ---- the button's look: initials or picture, the name when there is room
  const narrow = matchMedia(`(max-width: ${APP.HEADER.NAME_MIN_WIDTH - 1}px)`);
  const syncWidth = () => button.classList.toggle("initials-only", narrow.matches);
  narrow.addEventListener?.("change", syncWidth);
  syncWidth();
  function render() {
    const name = user?.name ?? "";
    const initials = initialsOf(name);
    if (user?.thumbnail && !thumbFailed) {
      const img = h("img", { class: "user-avatar-img", src: user.thumbnail, alt: "" });
      img.addEventListener("error", () => { thumbFailed = true; render(); }, { once: true }); // quietly back to initials
      avatar.replaceChildren(img);
    } else if (initials) {
      avatar.replaceChildren(document.createTextNode(initials));
    } else {
      avatar.replaceChildren(h("calcite-icon", { icon: "user", scale: "s" }));
    }
    nameEl.textContent = name;
    nameEl.hidden = !name;
    button.setAttribute("aria-label", T.USER_BUTTON(name));
    button.title = T.USER_BUTTON(name);
    who.hidden = !user;
    actions.hidden = !user; // Sign out only for a signed-in user
    whoName.textContent = name;
    whoUser.textContent = user?.username && user.username !== name ? user.username : "";
    whoUser.hidden = !whoUser.textContent;
  }

  // user: { fullName, username, thumbnail } (thumbnail: an image URL the page may show) or null
  function setUser(next) {
    user = next ? { name: displayName(next.fullName, next.username), username: next.username ?? "", thumbnail: next.thumbnail ?? null } : null;
    thumbFailed = false;
    render();
  }
  render();

  return {
    setUser, about, actions, button, popover, open, close,
    get state() { return { open: !!popover.open, user: user ? { name: user.name, username: user.username, picture: !!user.thumbnail && !thumbFailed } : null, initialsOnly: narrow.matches }; },
  };
}

// The signed-in portal user for the button: { fullName, username, thumbnail } with the picture fetched with the user's
// own sign-in (esriRequest adds the token) as an object URL, or null when no one is signed in. Never starts a sign-in.
export async function portalUserForMenu() {
  if (!CONFIG.APP_ID) return null;
  try {
    const [Portal, esriRequest] = await $arcgis.import(["@arcgis/core/portal/Portal.js", "@arcgis/core/request.js"]);
    const portal = new Portal({ url: CONFIG.PORTAL_URL, authMode: "no-prompt" });
    await portal.load();
    const u = portal.user;
    if (!u) return null;
    let thumbnail = null;
    if (APP.HEADER.THUMBNAIL && u.thumbnailUrl) {
      try {
        const r = await esriRequest(u.thumbnailUrl, { responseType: "blob" });
        if (r.data?.size) thumbnail = URL.createObjectURL(r.data);
      } catch { /* no picture: the initials */ }
    }
    return { fullName: u.fullName, username: u.username, thumbnail };
  } catch (err) {
    console.warn("User menu: couldn't read the signed-in user:", err?.message ?? String(err));
    return null;
  }
}
