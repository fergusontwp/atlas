import { h } from "./dom.js";

// A short message in a Calcite alert that closes by itself (the page's toasts). kind: "info" | "success" | "warning" |
// "danger"; duration: "fast" | "medium" | "slow". The alert is removed once closed.
export function toast(title, message = "", { kind = "info", duration = "medium" } = {}) {
  const alert = h("calcite-alert", { open: true, autoClose: true, autoCloseDuration: duration, kind, icon: true, label: title, scale: "s" },
    h("div", { slot: "title" }, title),
    message ? h("div", { slot: "message" }, message) : null);
  alert.addEventListener("calciteAlertClose", () => alert.remove());
  (document.querySelector("calcite-shell") ?? document.body).append(alert);
  return alert;
}
