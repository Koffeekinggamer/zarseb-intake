const SUPABASE_URL = "https://qtiydawnegefsjgndqga.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0aXlkYXduZWdlZnNqZ25kcWdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MTU4NDMsImV4cCI6MjEwNTk5MTg0M30.XOBIuRH7CYN_xwQf8IQOknQxNYn-qtTgFCVscTKNDs4";
const PDF_URL = "../pdf/ZarSeb-Website-Prep-Form-Rachel-Schwartz-v2.pdf";

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
let rows = [];

const $ = (s) => document.querySelector(s);

function currentKey() {
  const q = new URLSearchParams(location.search).get("key");
  const typed = $("#key").value.trim();
  return typed || q || "";
}

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    }) + " ET";
  } catch (e) {
    return iso;
  }
}

function prettyAnswers(answers) {
  if (!answers || typeof answers !== "object") return "";
  const lines = [];
  Object.entries(answers).forEach(([k, v]) => {
    if (v === true) lines.push(`${k}: yes`);
    else if (v) lines.push(`${k}: ${v}`);
  });
  return lines.join("\n");
}

async function loadRows() {
  const key = currentKey();
  const status = $("#status");
  const list = $("#list");
  list.innerHTML = "";
  $("#export").hidden = true;
  if (!key) {
    status.textContent = "Enter the secret key to view responses.";
    status.className = "help";
    return;
  }
  status.textContent = "Loading…";
  status.className = "help";
  const { data, error } = await client.rpc("list_website_intake", { p_secret: key });
  if (error) {
    status.textContent = "Could not load responses. Check the key and try again.";
    status.className = "help err";
    console.error(error);
    return;
  }
  rows = data || [];
  status.textContent = rows.length ? `${rows.length} response${rows.length === 1 ? "" : "s"}.` : "No responses yet.";
  status.className = "help";
  $("#export").hidden = rows.length === 0;
  rows.forEach((row) => {
    const el = document.createElement("article");
    el.className = "entry";
    const testTag = row.is_test ? '<span class="tag">TEST</span>' : "";
    el.innerHTML = `
      <header>
        <h3>${escapeHtml(row.client_name || "Untitled")}${testTag}</h3>
        <div class="meta">${fmtWhen(row.created_at)} · ${escapeHtml(row.source || "web")}</div>
      </header>
      <pre>${escapeHtml(prettyAnswers(row.answers))}</pre>
      <div class="toolbar">
        <button type="button" class="btn btn-ghost js-json">Download JSON</button>
        <button type="button" class="btn btn-ghost js-pdf">Download filled PDF</button>
      </div>`;
    el.querySelector(".js-json").addEventListener("click", () => downloadJson(row));
    el.querySelector(".js-pdf").addEventListener("click", () => downloadPdf(row).catch((err) => {
      console.error(err);
      alert("Could not build the PDF for this response.");
    }));
    list.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function downloadJson(row) {
  const blob = new Blob([JSON.stringify(row, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `intake-${(row.client_name || "response").replace(/\s+/g, "-").toLowerCase()}-${(row.created_at || "").slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadPdf(row) {
  const answers = row.answers || {};
  const res = await fetch(PDF_URL);
  if (!res.ok) throw new Error("pdf missing");
  const bytes = await res.arrayBuffer();
  const doc = await PDFLib.PDFDocument.load(bytes);
  const form = doc.getForm();
  const maybe = (fn) => { try { fn(); } catch (e) {} };
  form.getFields().forEach((field) => {
    const name = field.getName();
    const value = answers[name];
    maybe(() => {
      if (value === true || value === "Yes" || value === "/Yes") {
        if (typeof field.check === "function") field.check();
      } else if (typeof value === "string" && value && typeof field.setText === "function") {
        field.setText(value);
      } else if (typeof value === "string" && value && typeof field.select === "function") {
        field.select(value);
      }
    });
  });
  maybe(() => form.flatten());
  const out = await doc.save();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
  a.download = `ZarSeb-Website-Prep-${(row.client_name || "response").replace(/\s+/g, "-")}.pdf`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#load").addEventListener("click", loadRows);
$("#key").addEventListener("keydown", (e) => { if (e.key === "Enter") loadRows(); });
$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "zarseb-website-intake-responses.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

const preset = new URLSearchParams(location.search).get("key");
if (preset) {
  $("#key").value = preset;
  loadRows();
}
