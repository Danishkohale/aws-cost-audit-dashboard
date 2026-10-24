// AWS Cost Audit — Analyze page
// Lazy-loads `docx` npm package only when user clicks "DOCX" download.

const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&","<":"<",">":">",'"':"""}[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let job = null, rows = [], steps = [];

// --- API Base URL Configuration ----------------------------------------------
// Can be overridden by:
// 1. window.__API_BASE_URL__ (set in HTML before script loads)
// 2. VITE_API_BASE_URL at build time (for Cloudflare Pages)
const API_BASE = (typeof window !== "undefined" && window.__API_BASE_URL__) || "";
function apiUrl(path) {
  return `${API_BASE}${path}`;
}

// --- Lazy DOCX loader -------------------------------------------------------
let docxModulePromise = null;
function loadDocxModule() {
  if (!docxModulePromise) {
    docxModulePromise = import("docx").catch((e) => {
      console.error("Failed to load docx:", e);
      toast("DOCX library failed to load");
      return null;
    });
  }
  return docxModulePromise;
}

// --- Theme & UI helpers -----------------------------------------------------
function toast(m) { const t = $("toast"); if (!t) return; t.textContent = m; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 4500); }
function view(id) { ["v-form", "v-scan", "v-rep"].forEach((v) => { const el = $(v); if (el) el.classList.toggle("hidden", v !== id); }); window.scrollTo({top: 0}); }
function themeName() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
function paintTheme() { const b = $("themeBtn"); if (b) b.textContent = themeName() === "dark" ? "Light" : "Dark"; }
on("themeBtn", "click", () => {
  const n = themeName() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = n;
  try { localStorage.setItem("audit-theme", n); } catch (e) {}
  paintTheme();
});
paintTheme();

// --- API helper -------------------------------------------------------------
async function api(url, opt) {
  const r = await fetch(url, opt);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error(`Server error ${r.status} — restart backend, then reload.`);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `Failed (${r.status})`);
  return j;
}

function applyView(j) {
  $("pct").textContent = `${j.progress || 0}%`;
  $("fill").style.width = `${j.progress || 0}%`;
  $("log").textContent = (j.logs || []).join("\n") || "Working…";
  return j;
}
const refreshView = () => api(apiUrl(`/api/audit/${job}`)).then(applyView);

// --- Chunked collect (browser-driven fan-out) -------------------------------
async function collect(step, cursor) {
  return api(apiUrl(`/api/collect/${step}`), {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({job_id: job, cursor}),
  });
}

async function runAudit() {
  try {
    await refreshView();
    for (const step of steps) {
      let cursor = null;
      for (;;) {
        let r;
        for (let attempt = 0; ; attempt++) {
          try { r = await collect(step, cursor); break; }
          catch (ex) {
            if (attempt >= 4) throw ex;
            $("log").textContent += `\nRetrying ${step}… ${ex.message}`;
            await sleep(500 * (attempt + 1));
          }
        }
        cursor = r.next_cursor;
        if (r.progress !== undefined) {
          $("pct").textContent = `${r.progress}%`;
          $("fill").style.width = `${r.progress}%`;
        }
        await refreshView().catch(() => {});
        if (!cursor) break;
      }
    }
    render(await refreshView());
  } catch (ex) {
    $("log").textContent += `\nERROR: ${ex.message}`;
    toast(ex.message);
  }
}

// --- Form submit / demo -----------------------------------------------------
on("f", "submit", async (e) => {
  e.preventDefault();
  const err = $("err"); if (err) err.textContent = "";
  const body = {access_key_id: $("ak").value.trim(), secret_access_key: $("sk").value.trim(), session_token: $("st").value.trim(), region: $("rg").value.trim(), days: 14};
  $("sk").value = ""; $("st").value = "";
  const btn = $("run"); if (btn) btn.disabled = true;
  try {
    const j = await api(apiUrl("/api/audit"), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    job = j.job_id;
    steps = j.steps || [];
    view("v-scan");
    await runAudit();
  } catch (ex) { if (err) err.textContent = ex.message; toast(ex.message); }
  finally { if (btn) btn.disabled = false; }
});

// Auto-run demo if ?demo=1 in URL
if (new URLSearchParams(location.search).get("demo") === "1") {
  document.addEventListener("DOMContentLoaded", async () => {
    try {
      const j = await api(apiUrl("/api/demo"), {method: "POST"});
      job = j.job_id;
      render(await api(apiUrl(`/api/audit/${job}`)));
    } catch (ex) {
      console.error("Auto-demo failed:", ex);
    }
  });
}

// --- Report rendering -------------------------------------------------------
function render(j) {
  view("v-rep");
  const s = j.summary, p = j.payload;
  $("meta").textContent = `${s.region} · ${s.date} · ${s.findings_count} findings`;
  $("kS").textContent = `$${Number(s.total_savings).toLocaleString()}/mo`;
  $("kF").textContent = s.findings_count;
  $("kC").textContent = `$${Number(s.live_cost_total).toLocaleString()}`;
  $("note").textContent = s.cost_note || "";
  const items = Object.entries(p.live_cost_by_service || {}).sort((a, b) => b[1] - a[1]);
  const mx = Math.max(...items.map((x) => Number(x[1])), 0.01);
  $("bars").innerHTML = items.length ? items.map(([k, v]) =>
    `<div class="brow"><span>${esc(k)}</span><div><i style="width:${(100 * Number(v) / mx).toFixed(1)}%"></i></div><b>$${Number(v).toLocaleString()}</b></div>`).join("")
    : `<p class="mut">Cost Explorer unavailable.</p>`;
  rows = p.findings || [];
  const svcs = [...new Set(rows.map((f) => f.service))].sort();
  $("flt").innerHTML = `<option value="">All services (${rows.length})</option>` + svcs.map((x) => `<option>${esc(x)}</option>`).join("");
  draw();
}

function meta(m) {
  if (!m || typeof m !== "object") return "";
  const out = [];
  const push = (k, v, sfx = "") => { if (v !== null && v !== undefined && v !== "") out.push(`${k} ${v}${sfx}`); };
  push("Size", m.size_gb, "GB"); push("Objects", m.objects); push("GET", m.gets); push("PUT", m.puts);
  push("CPU", m.cpu_avg, "%"); push("Type", m.instance_type || m.class || m.type);
  push("Age", m.age_days, "d"); push("Cost", m.base_cost_mo ?? m.est_cost_mo, "$/mo");
  return out.length ? `<div class="det">${esc(out.join(" · "))}</div>` : "";
}

function draw() {
  const f = $("flt").value, q = $("q").value.toLowerCase();
  const list = rows
    .filter((r) => (!f || r.service === f) && (!q || `${r.resource} ${r.category} ${r.detail} ${r.recommendation}`.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.est_monthly_saving_usd || 0) - Number(a.est_monthly_saving_usd || 0));
  $("cnt").textContent = `${list.length} shown`;
  $("list").innerHTML = list.length ? list.map((r) =>
    `<div class="find"><div class="t"><span class="svc">${esc(r.service)}</span><span class="save">$${esc(r.est_monthly_saving_usd)}/mo</span></div><div class="res">${esc(r.resource)}</div><div class="cat">${esc(r.category)}</div><div class="det">${esc(r.detail)}</div>${meta(r.meta)}<div class="rec">→ ${esc(r.recommendation)}</div></div>`).join("")
    : `<p class="mut">No findings — well optimized.</p>`;
}
on("flt", "change", draw);
on("q", "input", draw);

// ===== Client-side report generation =======================================

/** Build the JSON report payload. */
function buildJsonReport(j) {
  const s = j.summary, p = j.payload;
  return JSON.stringify({
    date: s.date,
    region: s.region,
    lookback_days: s.lookback_days,
    live_cost_by_service: p.live_cost_by_service,
    cost_note: s.cost_note,
    findings: p.findings
  }, null, 2);
}

/** Build the standalone HTML report (dark theme, self-contained). */
function buildHtmlReport(j) {
  const s = j.summary, p = j.payload;
  const region = esc(s.region);
  const date = esc(s.date);
  const findingsCount = s.findings_count;
  const totalSavings = Number(s.total_savings).toLocaleString();
  const liveCostTotal = Number(s.live_cost_total).toLocaleString();
  const costNote = esc(s.cost_note || "—");

  const items = Object.entries(p.live_cost_by_service || {}).sort((a, b) => b[1] - a[1]);
  const mx = Math.max(...items.map((x) => Number(x[1])), 0.01);
  const costBars = items.length ? items.map(([k, v]) =>
    `<tr><td>${esc(k)}</td><td><div class="bar"><i style="width:${(100 * Number(v) / mx).toFixed(1)}%"></i></div></td><td class="num">$${Number(v).toLocaleString()}</td></tr>`
  ).join("") : `<tr><td colspan="3" class="mut">Cost Explorer unavailable.</td></tr>`;

  const findingRows = (p.findings || []).map((f) => {
    const m = f.meta || {};
    const metaBits = [];
    const add = (k, v, sfx = "") => { if (v !== null && v !== undefined && v !== "") metaBits.push(`${k} ${v}${sfx}`); };
    add("Size", m.size_gb, "GB"); add("Objects", m.objects); add("GET", m.gets); add("PUT", m.puts);
    add("CPU", m.cpu_avg, "%"); add("Type", m.instance_type || m.class || m.type);
    add("Age", m.age_days, "d"); add("Cost", m.base_cost_mo ?? m.est_cost_mo, "$/mo");
    const metaHtml = metaBits.length ? `<div class="meta">${esc(metaBits.join(" · "))}</div>` : "";
    return `<tr><td>${esc(f.service)}</td><td>${esc(f.resource)}</td><td>${esc(f.category)}</td><td>${esc(f.detail)}${metaHtml}</td><td class="num">$${Number(f.est_monthly_saving_usd || 0).toLocaleString()}</td><td>${esc(f.recommendation)}</td></tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AWS Cost Audit — ${region} ${date}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:2rem}
  h1{font-size:1.5rem;margin-bottom:.2rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem;color:#aaa}
  .meta{display:flex;gap:2rem;font-size:.9rem;color:#aaa;margin-bottom:1.5rem}
  table{width:100%;border-collapse:collapse;margin-top:.5rem}
  th,td{padding:.5rem .75rem;text-align:left;border-bottom:1px solid #333;font-size:.85rem}
  th{color:#888;font-weight:600}
  .bar{height:.5rem;background:#333;border-radius:.25rem;overflow:hidden}
  .bar i{display:block;height:100%;background:linear-gradient(90deg,#4ade80,#22c55e)}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .mut{color:#888;font-style:italic}
  .meta{font-size:.75rem;color:#888}
</style></head><body>
  <h1>AWS Cost Audit Dashboard</h1>
  <div class="meta">
    <span>Region: ${region}</span>
    <span>Date: ${date}</span>
    <span>Lookback: ${s.lookback_days}d</span>
    <span>Findings: ${findingsCount}</span>
    <span>Est. Savings: $${totalSavings}/mo</span>
    <span>Live Cost: $${liveCostTotal}/mo</span>
  </div>
  <p>${costNote}</p>
  <h2>Live Cost by Service</h2>
  <table><thead><tr><th>Service</th><th>Share</th><th class="num">Cost/mo</th></tr></thead><tbody>${costBars}</tbody></table>
  <h2>Findings (${findingsCount})</h2>
  <table><thead><tr><th>Service</th><th>Resource</th><th>Category</th><th>Detail</th><th class="num">Saving/mo</th><th>Recommendation</th></tr></thead><tbody>${findingRows}</tbody></table>
</body></html>`;
}

/** Trigger a browser download of a blob. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- DOCX generation (lazy-loaded) -----------------------------------------

async function buildDocxReport(j) {
  const docx = await loadDocxModule();
  if (!docx) throw new Error("docx module not loaded");
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } = docx;

  const s = j.summary, p = j.payload;

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ children: [new TextRun({ text: "AWS Cost Audit Dashboard", bold: true, size: 32 })] }),
        new Paragraph({ children: [new TextRun(`Region: ${s.region}  Date: ${s.date}  Findings: ${s.findings_count}`)] }),
        new Paragraph({ children: [new TextRun(`Est. Savings: $${Number(s.total_savings).toLocaleString()}/mo`)] }),
        new Paragraph({ children: [new TextRun(s.cost_note || "—")] }),
        new Paragraph({ children: [new TextRun({ text: "", size: 2 })] }),

        // Cost table
        new Paragraph({ children: [new TextRun({ text: "Live Cost by Service", bold: true, size: 24 })] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: ["Service", "Cost/mo"].map(t => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] }) }),
            ...Object.entries(p.live_cost_by_service || {}).sort((a,b) => b[1] - a[1]).map(([k,v]) =>
              new TableRow({ children: [k, `$${Number(v).toLocaleString()}`].map(t => new TableCell({ children: [new Paragraph({ children: [new TextRun(t)])] }) }) )
            )
          ]
        }),

        new Paragraph({ children: [new TextRun({ text: "", size: 2 })] }),

        // Findings table
        new Paragraph({ children: [new TextRun({ text: `Findings (${s.findings_count})`, bold: true, size: 24 })] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: ["Service", "Resource", "Category", "Detail", "Saving/mo", "Recommendation"].map(t => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] }) }),
            ...(p.findings || []).map(f =>
              new TableRow({ children: [f.service, f.resource, f.category, f.detail, `$${Number(f.est_monthly_saving_usd || 0).toLocaleString()}`, f.recommendation].map(t => new TableCell({ children: [new Paragraph({ children: [new TextRun(t)])] }) }) )
            )
          ]
        })
      ]
    }]
  });

  return Packer.toBlob(doc);
}

/** Download handler — generates report locally. */
async function handleDownload(format) {
  const j = await refreshView();
  if (j.status !== "done") { toast("Job not finished yet"); return; }
  const s = j.summary;
  const filename = `cost-optimization-${s.region}-${s.date}.${format}`;

  if (format === "json") {
    const txt = buildJsonReport(j);
    downloadBlob(new Blob([txt], {type: "application/json"}), filename);
  } else if (format === "html") {
    const txt = buildHtmlReport(j);
    downloadBlob(new Blob([txt], {type: "text/html"}), filename);
  } else if (format === "docx") {
    try {
      toast("Generating DOCX…");
      const blob = await buildDocxReport(j);
      downloadBlob(blob, filename);
      toast("DOCX downloaded");
    } catch (e) {
      console.error(e);
      toast("DOCX generation failed");
    }
  }
}

// ===== Shared helpers =======================================================

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.querySelectorAll(".dl button[data-f]").forEach((b) =>
  b.addEventListener("click", () => handleDownload(b.dataset.f)));

on("new", "click", () => { job = null; view("v-form"); });