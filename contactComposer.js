import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { contactDraftHasContent } from "./draftLogic.js";
import { cleanName, dayValue, defaultDueDay, domainCodes, dueFromDay, formatPhone, validEmail, validPhone } from "./contactLogic.js";

// The Contact half of the Notes composer (section 51, laid out in section 52, reordered in section 53). notesDialog.js
// places `top` above the note box and `bottom` under it. One column of labelled fields, every label the same style and
// flush left, in groups split by a rule:
//   top:    [When (date and time, default now); Method (one-tap chips, single); Customer type (chips, single); a switch
//           "Add customer details" opening name, phone and email (never required; the phone and email checked with
//           NOTES.CONTACT.PATTERNS)]
//           [Topics (chips, multiple); Permit or application submitted (Not asked / the domain's codes)]
//           [a switch "Needs a follow-up" opening the assignee (the org's staff list, me first, only people in the list)
//           and the day (DEFAULT_DAYS ahead), both required once on]
//   (the dialog's group: "What was discussed" and the link)
//   bottom: Staff contact (the signed-in full name, editable: someone may log for a colleague), in that last group.
// Method, customer type and permit offer only their domain's current codes (contactLogic.domainCodes); topics come from
// NOTES.CONTACT.TOPICS. No chip is focused or picked on open: focus goes to When. Nothing personal is ever logged.
//
// opts: { staff () -> Promise of { list, ok } (staffDirectory.js), me () -> Promise of the signed-in full name,
// onChange () }. Returns { top, bottom, set, reset, values, ready, dirty, draft, draftHasContent, restore, prefill,
// closing, followupOf, focus, loadPeople }.
export function createContactComposer({ staff = async () => ({ list: [], ok: false }), me = async () => null, onChange = () => {} } = {}) {
  const T = NOTES.CONTACT.TEXT, CFG = NOTES.CONTACT;
  const changed = () => onChange();
  // a field: its label over its control (or controls, side by side with `pair`)
  const field = (text, ...children) => h("div", { class: "form-field" }, h("div", { class: "form-label" }, text), ...children);
  const pair = (...children) => h("div", { class: "form-pair" }, ...children);
  const section = (...children) => h("div", { class: "form-section" }, ...children);

  // ---- closing a follow-up (Mark done): a line above everything, with a way out
  const closingText = h("span", {});
  const closingCancel = h("calcite-button", { appearance: "transparent", scale: "s", class: "contact-closing-cancel", onclick: () => { setClosing(null); changed(); } }, T.CLOSING_CANCEL);
  const closingRow = h("div", { class: "contact-closing", hidden: true }, h("calcite-icon", { icon: "check-circle", scale: "s" }), closingText, closingCancel);
  let closing = null; // { globalId, day }
  function setClosing(c) {
    closing = c;
    closingRow.hidden = !c;
    closingText.textContent = c ? T.CLOSING_FOR(c.day) : "";
  }

  // ---- when
  const today = () => dayValue(Date.now());
  const nowTime = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const datePicker = h("calcite-input-date-picker", { scale: "m", label: T.WHEN_DATE, overlayPositioning: "fixed", class: "contact-date", oncalciteInputDatePickerChange: () => { whenTouched = true; changed(); } });
  const timePicker = h("calcite-input-time-picker", { scale: "m", label: T.WHEN_TIME, step: 60, overlayPositioning: "fixed", class: "contact-time", oncalciteInputTimePickerChange: () => { whenTouched = true; changed(); } });
  let whenTouched = false;

  // ---- chips
  const group = (label, mode, cls) => h("calcite-chip-group", { label, selectionMode: mode, scale: "s", class: `contact-chips ${cls}`, oncalciteChipGroupSelect: () => changed() });
  const methodGroup = group(T.METHOD, "single", "contact-method");
  const customerGroup = group(T.CUSTOMER_TYPE, "single", "contact-customer-type");
  const topicsGroup = group(T.TOPICS, "multiple", "contact-topics");
  const chipsFor = (groupEl, options, selected = []) => groupEl.replaceChildren(...options.map((o) => {
    const chip = h("calcite-chip", { value: o.code, label: o.label, scale: "s", selected: selected.some((s) => String(s) === String(o.code)) }, o.label);
    if (o.icon) chip.icon = o.icon;
    return chip;
  }));
  const picked = (groupEl) => [...groupEl.querySelectorAll("calcite-chip")].filter((c) => c.selected).map((c) => c.value);
  const pick = (groupEl, codes) => groupEl.querySelectorAll("calcite-chip").forEach((c) => { c.selected = (codes ?? []).some((v) => String(v) === String(c.value)); });

  // ---- the customer (behind a switch). A phone or email that fails its pattern is marked once the field is left
  // (or Add is pressed), and the mark clears as soon as it is fixed; Add stays disabled meanwhile.
  const input = (label, cls, autocomplete) => h("calcite-input-text", { scale: "m", label, class: cls, autocomplete, oncalciteInputTextInput: () => { check(); changed(); }, oncalciteInputTextChange: (e) => { shown.add(e.target); check(); } });
  const nameInput = input(T.NAME, "contact-name", "off");
  const phoneInput = input(T.PHONE, "contact-phone", "off");
  const emailInput = input(T.EMAIL, "contact-email", "off");
  phoneInput.placeholder = T.PHONE_EXAMPLE;
  // a valid phone number is written one way once the field is left (section 58): contactLogic.formatPhone. Never while
  // typing (no cursor jumps); an invalid value is left as typed, with its message.
  phoneInput.addEventListener("focusout", () => {
    const typed = String(phoneInput.value ?? "");
    const formatted = formatPhone(typed.trim());
    if (typed.trim() && validPhone(typed.trim()) && formatted !== typed) { phoneInput.value = formatted; check(); changed(); }
  });
  emailInput.placeholder = T.EMAIL_EXAMPLE;
  const shown = new Set(); // the inputs whose problem may show
  const problems = () => ({ phone: validPhone(text(phoneInput)) ? "" : T.PHONE_BAD, email: validEmail(text(emailInput)) ? "" : T.EMAIL_BAD });
  function check() {
    const p = problems();
    for (const [el, message] of [[phoneInput, p.phone], [emailInput, p.email]]) {
      const show = !!message && shown.has(el);
      el.status = show ? "invalid" : "idle";
      el.validationMessage = show ? message : "";
      el.validationIcon = show;
    }
    return p;
  }
  const whoFields = h("div", { class: "form-reveal contact-who-fields", hidden: true }, field(T.NAME, nameInput), pair(field(T.PHONE, phoneInput), field(T.EMAIL, emailInput)));
  const whoSwitch = h("calcite-switch", { scale: "m", label: T.WHO, labelTextEnd: T.WHO, class: "contact-who-toggle", oncalciteSwitchChange: () => { setWho(whoSwitch.checked); if (whoSwitch.checked) nameInput.setFocus?.(); changed(); } });
  const setWho = (open) => { whoSwitch.checked = !!open; whoFields.hidden = !open; };

  // ---- permit, staff
  const permitControl = h("calcite-segmented-control", { scale: "m", label: T.PERMIT, class: "contact-permit", oncalciteSegmentedControlChange: changed });
  const staffInput = h("calcite-input-text", { scale: "m", label: T.STAFF, placeholder: T.STAFF_HINT, class: "contact-staff", oncalciteInputTextInput: () => { staffTouched = true; changed(); } });
  let staffTouched = false, myName = "";

  // ---- follow-up (behind a switch)
  const assignee = h("calcite-combobox", { scale: "m", label: T.ASSIGNEE, selectionMode: "single", allowCustomValues: false, placeholder: T.STAFF_PLACEHOLDER, overlayPositioning: "fixed", class: "contact-assignee", oncalciteComboboxChange: changed });
  const dueDate = h("calcite-input-date-picker", { scale: "m", label: T.DUE, overlayPositioning: "fixed", class: "contact-due", oncalciteInputDatePickerChange: changed });
  const staffNote = h("div", { class: "plan-note contact-staff-note", hidden: true }, T.STAFF_FAILED);
  const followFields = h("div", { class: "form-reveal contact-follow-fields", hidden: true }, pair(field(T.ASSIGNEE, assignee), field(T.DUE, dueDate)), staffNote);
  const followSwitch = h("calcite-switch", { scale: "m", label: T.NEEDS_FOLLOWUP, labelTextEnd: T.NEEDS_FOLLOWUP, class: "contact-follow-toggle", oncalciteSwitchChange: () => setFollow(followSwitch.checked, true) });
  const followRow = section(followSwitch, followFields);
  followRow.classList.add("contact-follow");
  followRow.hidden = true;
  let followups = false, people = [];
  async function loadPeople() {
    const r = await staff().catch(() => ({ list: [], ok: false }));
    people = r.list ?? [];
    staffNote.hidden = !!r.ok;
    const keep = selectedAssignee();
    assignee.replaceChildren(...people.map((u) => h("calcite-combobox-item", { value: u.username, heading: u.isMe ? T.STAFF_ME(u.name) : u.name, textLabel: u.name, selected: keep === u.username })));
  }
  const selectedAssignee = () => { const v = Array.isArray(assignee.value) ? assignee.value[0] : assignee.value; return v ? String(v) : null; };
  function setFollow(open, focus = false) {
    followSwitch.checked = !!open;
    followFields.hidden = !open;
    if (open) {
      dueDate.min = today();
      if (!dueDate.value) dueDate.value = defaultDueDay();
      if (!people.length) loadPeople();
      if (focus) assignee.setFocus?.();
    } else {
      assignee.value = "";
      assignee.querySelectorAll("calcite-combobox-item").forEach((i) => { i.selected = false; });
      dueDate.value = "";
    }
    changed();
  }

  const first = section(field(T.WHEN, h("div", { class: "form-pair contact-when" }, datePicker, timePicker)),
    field(T.METHOD, methodGroup), field(T.CUSTOMER_TYPE, customerGroup), whoSwitch, whoFields);
  first.classList.add("form-first");
  const top = h("div", { class: "contact-top" }, closingRow, first,
    section(field(T.TOPICS, topicsGroup), field(T.PERMIT, permitControl)),
    followRow);
  // the last group goes on from the dialog's note box and link, so no rule of its own
  const bottom = h("div", { class: "contact-bottom" }, field(T.STAFF, staffInput));

  let domains = {};
  // the notes layer's domains and whether follow-ups are on (the layer has their fields and a GlobalID)
  function set({ domains: d = {}, followups: f = false } = {}) {
    domains = d;
    followups = !!f;
    const methods = domainCodes(d.method).map((o) => ({ ...o, icon: CFG.METHOD_ICONS?.[String(o.code)] || CFG.DEFAULT_ICON }));
    chipsFor(methodGroup, methods);
    chipsFor(customerGroup, domainCodes(d.customerType));
    chipsFor(topicsGroup, CFG.TOPICS);
    permitControl.replaceChildren(h("calcite-segmented-control-item", { value: "", checked: true }, T.PERMIT_UNASKED),
      ...domainCodes(d.permit).map((o) => h("calcite-segmented-control-item", { value: String(o.code) }, o.label)));
    followRow.hidden = !followups;
  }

  // a fresh contact: now, nothing picked, the staff contact = me
  async function reset() {
    setClosing(null);
    datePicker.max = today();
    datePicker.value = today();
    timePicker.value = nowTime();
    whenTouched = false;
    pick(methodGroup, []); pick(customerGroup, []); pick(topicsGroup, []);
    nameInput.value = phoneInput.value = emailInput.value = "";
    shown.clear();
    check();
    setWho(false);
    permitControl.querySelectorAll("calcite-segmented-control-item").forEach((i, k) => { i.checked = k === 0; });
    staffTouched = false;
    myName = cleanName(await me().catch(() => null)) || "";
    staffInput.value = myName;
    if (followups) setFollow(false);
  }

  const permitValue = () => { const v = permitControl.value ?? permitControl.querySelector("calcite-segmented-control-item[checked]")?.value; return v ? String(v) : null; };
  function eventDate() {
    if (!whenTouched) return Date.now();
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(datePicker.value ?? ""));
    const time = /^(\d{1,2}):(\d{2})/.exec(String(timePicker.value ?? ""));
    if (!day) return Date.now();
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), time ? Number(time[1]) : 12, time ? Number(time[2]) : 0);
    return Math.min(d.getTime(), Date.now());
  }
  // the follow-up as entered: null when closed, else { to, toName, due } (to or due may be missing)
  function followupValue() {
    if (!followups || followFields.hidden) return null;
    const to = selectedAssignee();
    const person = people.find((u) => u.username === to);
    return { to, toName: person ? person.fullName || null : null, due: dueFromDay(dueDate.value) };
  }

  const text = (el) => String(el.value ?? "").trim();
  return {
    top, bottom, set, reset,
    get closing() { return closing; },
    followupOf: () => closing?.globalId ?? null,
    // the input for contactLogic.newContactRecord (the dialog adds the note text and link)
    values: () => ({
      eventDate: eventDate(), method: picked(methodGroup)[0] ?? null, customerType: picked(customerGroup)[0] ?? null, topics: picked(topicsGroup),
      permit: permitValue(), name: text(nameInput), phone: text(phoneInput), email: text(emailInput), staff: text(staffInput),
      followup: followupValue(), followupOf: closing?.globalId ?? null,
    }),
    // whether Add contact can be pressed, and why not
    ready() {
      const p = check();
      const values = { contact_method: picked(methodGroup)[0], customer_type: picked(customerGroup)[0], topics: picked(topicsGroup)[0], permit_submitted: permitValue(), staff_contact: text(staffInput) };
      const labels = { contact_method: T.METHOD, customer_type: T.CUSTOMER_TYPE, topics: T.TOPICS, permit_submitted: T.PERMIT, staff_contact: T.STAFF };
      const missing = (CFG.REQUIRE ?? []).filter((f) => f in values && !values[f]);
      if (missing.length) return { ok: false, message: T.REQUIRED(missing.map((f) => labels[f])) };
      if (p.phone || p.email) return { ok: false, message: p.phone || p.email };
      const f = followupValue();
      if (f && (!f.to || !Number.isFinite(f.due))) return { ok: false, message: T.FOLLOWUP_INCOMPLETE };
      return { ok: true, message: "" };
    },
    // anything entered beyond the defaults (closing asks first)
    dirty: () => !!(picked(methodGroup).length || picked(customerGroup).length || picked(topicsGroup).length || text(nameInput) || text(phoneInput) || text(emailInput)
      || permitValue() || (staffTouched && text(staffInput) !== myName) || followupValue() || closing || whenTouched),
    draft: () => ({
      when: whenTouched ? { date: datePicker.value, time: timePicker.value } : null, method: picked(methodGroup), customerType: picked(customerGroup), topics: picked(topicsGroup),
      permit: permitValue(), name: nameInput.value, phone: phoneInput.value, email: emailInput.value, who: whoSwitch.checked,
      staff: staffTouched ? staffInput.value : null, follow: followups && !followFields.hidden ? { to: selectedAssignee(), due: dueDate.value } : null, closing,
    }),
    // whether a stored draft (draft() above) holds anything beyond the defaults
    draftHasContent: contactDraftHasContent, // draftLogic.js
    async restore(d) {
      if (!d) return;
      if (d.when) { datePicker.value = d.when.date; timePicker.value = d.when.time; whenTouched = true; }
      pick(methodGroup, d.method); pick(customerGroup, d.customerType); pick(topicsGroup, d.topics);
      if (d.permit) permitControl.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = String(i.value) === String(d.permit); });
      nameInput.value = d.name ?? ""; phoneInput.value = d.phone ?? ""; emailInput.value = d.email ?? "";
      for (const el of [phoneInput, emailInput]) if (text(el)) shown.add(el);
      setWho(!!d.who);
      if (d.staff !== null && d.staff !== undefined) { staffInput.value = d.staff; staffTouched = true; }
      if (d.follow && followups) {
        setFollow(true);
        await loadPeople();
        if (d.follow.to) { assignee.value = d.follow.to; assignee.querySelectorAll("calcite-combobox-item").forEach((i) => { i.selected = i.value === d.follow.to; }); }
        if (d.follow.due) dueDate.value = d.follow.due;
      }
      if (d.closing) setClosing(d.closing);
      changed();
    },
    // Mark done: a fresh contact prefilled from the original (method, customer type, topics, customer details), closing
    // its follow-up. original: an entry with contact and globalId; day: its day as shown.
    async prefill(original, day) {
      await reset();
      const c = original?.contact ?? {};
      const offered = (groupEl, code) => [...groupEl.querySelectorAll("calcite-chip")].some((x) => String(x.value) === String(code));
      // a code no longer in the domain isn't offered, so it can't be picked again
      pick(methodGroup, offered(methodGroup, c.method) ? [c.method] : []);
      pick(customerGroup, offered(customerGroup, c.customerType) ? [c.customerType] : []);
      pick(topicsGroup, c.topics ?? []);
      nameInput.value = c.name ?? ""; phoneInput.value = c.phone ?? ""; emailInput.value = c.email ?? "";
      setWho(!!(c.name || c.phone || c.email));
      setClosing({ globalId: original.globalId, day });
      changed();
    },
    // the first field, When: focusing the date's text box does not open its picker, and no chip is focused (a focused
    // chip read as chosen, section 53)
    focus: () => datePicker.setFocus?.(),
    loadPeople,
  };
}
