// Home page — minimal script for theme toggle only
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

function themeName() { return document.documentElement.dataset.theme === "dark" ? "dark" : "light"; }
function paintTheme() { const b = $("themeBtn"); if (b) b.textContent = themeName() === "dark" ? "Light" : "Dark"; }
on("themeBtn", "click", () => {
  const n = themeName() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = n;
  try { localStorage.setItem("audit-theme", n); } catch (e) {}
  paintTheme();
});
paintTheme();