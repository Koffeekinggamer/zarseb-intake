/* ZarSeb website prep form — Rachel Schwartz
   Anon/publishable key only. Inserts into website_intake; no service role. */
const SUPABASE_URL = "https://qtiydawnegefsjgndqga.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0aXlkYXduZWdlZnNqZ25kcWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MTU4NDMsImV4cCI6MjEwNTk5MTg0M30.XOBIuRH7CYN_xwQf8IQOknQxNYn-qtTgFCVscTKNDs4";
const STORAGE_KEY = "zarseb-intake-rachel-schwartz-v2";
const REQUIRED = [
  "client_name",
  "biz_legal_name",
  "biz_email",
  "biz_phone",
  "domain_has",
  "sign_name",
];

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function todayISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

/* ---------- collect / restore ---------- */
function collect() {
  const data = {};
  $$("[data-field][data-kind='text']").forEach((el) => {
    data[el.dataset.field] = (el.value || "").trim();
  });
  $$(".js-toggle[data-field]").forEach((el) => {
    if (el.getAttribute("aria-pressed") === "true") data[el.dataset.field] = true;
  });
  $$(".js-radio-group").forEach((group) => {
    const name = group.dataset.group;
    const sel = group.querySelector("[aria-checked='true']");
    if (sel) data[name] = sel.dataset.value;
  });
  return data;
}

function setText(field, value) {
  const el = document.querySelector(`[data-field="${field}"][data-kind="text"]`);
  if (el) el.value = value ?? "";
}

function setToggle(field, on) {
  const el = document.querySelector(`.js-toggle[data-field="${field}"]`);
  if (el) el.setAttribute("aria-pressed", on ? "true" : "false");
}

function setRadio(group, value) {
  const root = document.querySelector(`.js-radio-group[data-group="${group}"]`);
  if (!root) return;
  $$("[data-value]", root).forEach((btn) => {
    btn.setAttribute("aria-checked", btn.dataset.value === value ? "true" : "false");
    btn.classList.toggle("selected", btn.dataset.value === value);
  });
}

function restore(data) {
  if (!data || typeof data !== "object") return;
  Object.entries(data).forEach(([k, v]) => {
    if (v === true || v === "true" || v === "Yes") setToggle(k, true);
    else if (typeof v === "string" || typeof v === "number") {
      const text = document.querySelector(`[data-field="${k}"][data-kind="text"]`);
      if (text) setText(k, String(v));
      else setRadio(k, String(v));
    }
  });
}

/* ---------- persistence ---------- */
let saveTimer;
function saveDraft(show = true) {
  const data = collect();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch (e) {
    /* private mode / quota */
  }
  if (show) {
    const s = $("#draft-status");
    if (s) {
      s.textContent = "Draft saved";
      s.dataset.state = "saved";
    }
  }
  updateProgress();
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    restore(parsed.data || parsed);
    return true;
  } catch (e) {
    return false;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {}
}

/* ---------- progress / nav ---------- */
function updateProgress() {
  const data = collect();
  const allKeys = new Set();
  $$("[data-field]").forEach((el) => allKeys.add(el.dataset.field));
  $$(".js-radio-group").forEach((el) => allKeys.add(el.dataset.group));
  let filled = 0;
  allKeys.forEach((k) => {
    const v = data[k];
    if (v === true || (typeof v === "string" && v.length > 0)) filled += 1;
  });
  const pct = allKeys.size ? Math.round((filled / allKeys.size) * 100) : 0;
  const bar = $("#progress-fill");
  const label = $("#progress-label");
  if (bar) bar.style.width = pct + "%";
  const reqDone = REQUIRED.filter((k) => data[k] && String(data[k]).length).length;
  if (label) {
    label.innerHTML = `<strong>${pct}%</strong> complete · ${reqDone} of ${REQUIRED.length} required`;
  }
}

function spySections() {
  const links = $$(".section-nav a");
  const sections = $$("section.block");
  const offset = 140;
  let current = sections[0];
  sections.forEach((s) => {
    if (s.getBoundingClientRect().top - offset <= 0) current = s;
  });
  links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + current.id));
}

/* ---------- validation ---------- */
function validate(showHints) {
  const data = collect();
  let firstBad = null;
  REQUIRED.forEach((name) => {
    const ok = !!(data[name] && String(data[name]).trim());
    const field = document.querySelector(`[data-field="${name}"]`);
    const group = document.querySelector(`.js-radio-group[data-group="${name}"]`);
    const wrap =
      (field && field.closest(".field, .field-group")) ||
      (group && group.closest(".field, .field-group"));
    if (wrap && showHints) wrap.classList.toggle("invalid", !ok);
    if (!ok && !firstBad) firstBad = wrap || field || group;
  });
  return { ok: !firstBad, firstBad, data };
}

function clearHintOn(el) {
  const wrap = el.closest(".field, .field-group");
  if (wrap) wrap.classList.remove("invalid");
}

/* ---------- events ---------- */
function bindToggles() {
  $$(".js-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      clearHintOn(btn);
      scheduleSave();
    });
  });
}

function bindRadios() {
  $$(".js-radio-group").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-value]");
      if (!btn || !group.contains(btn)) return;
      setRadio(group.dataset.group, btn.dataset.value);
      clearHintOn(group);
      scheduleSave();
    });
    group.querySelectorAll("[data-value]").forEach((btn) => {
      btn.setAttribute("role", "radio");
      if (!btn.hasAttribute("aria-checked")) btn.setAttribute("aria-checked", "false");
    });
  });
}

function scheduleSave() {
  const s = $("#draft-status");
  if (s) s.textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveDraft(true), 280);
}

async function handleSubmit(ev) {
  ev.preventDefault();
  const { ok, firstBad, data } = validate(true);
  if (!ok) {
    $("#submit-msg").textContent = "Please fill in the required items marked *.";
    if (firstBad) {
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return;
  }
  $("#submit-msg").textContent = "";
  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";

  const isTest =
    new URLSearchParams(location.search).has("test") ||
    /\bTEST\b/i.test(data.client_name || "") ||
    data.client_name === "TEST";

  const payload = {
    client_name: data.client_name || null,
    answers: data,
    source: "web",
    is_test: isTest,
    user_agent: navigator.userAgent.slice(0, 400),
  };

  try {
    const { error } = await client.from("website_intake").insert(payload);
    if (error) throw error;
    clearDraft();
    $("#form-root").classList.add("hide");
    $(".sticky-bar")?.classList.add("hide");
    $("#confirm").classList.add("show");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    console.error(err);
    $("#submit-msg").textContent =
      "We couldn't send this just now. Your draft is still saved on this device — please try again in a moment, or download a copy below and email it to Judson.";
    $("#fallback-download").hidden = false;
    btn.disabled = false;
    btn.textContent = "Submit form";
    saveDraft(true);
  }
}

function downloadAnswers() {
  const data = collect();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rachel-schwartz-website-prep-answers.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function init() {
  if (!$("#form_date").value) setText("form_date", todayISO());
  const restored = loadDraft();
  if (restored) {
    const s = $("#draft-status");
    if (s) s.textContent = "Draft restored";
    $("#draft-banner").hidden = false;
  }
  if (!$("#client_name").value) setText("client_name", "Rachel Schwartz");
  bindToggles();
  bindRadios();
  document.addEventListener("input", (e) => {
    if (e.target.matches("[data-field]")) {
      clearHintOn(e.target);
      scheduleSave();
    }
  });
  $("#intake-form").addEventListener("submit", handleSubmit);
  $("#fallback-download").addEventListener("click", downloadAnswers);
  updateProgress();
  spySections();
  window.addEventListener("scroll", spySections, { passive: true });
}

document.addEventListener("DOMContentLoaded", init);
