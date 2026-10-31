// The docs are plain markdown files in pages/. This file renders one per URL
// (?p=slug), builds the page list, the "On this page" list and search.
const NAV = [
  ["Getting started", [
    ["introduction", "Introduction"],
    ["install", "Install"],
    ["quickstart", "Your first run"],
    ["concepts", "How it fits together"],
  ]],
  ["Using it", [
    ["supervising", "Supervising a run"],
    ["tasks", "Tasks and gates"],
    ["worktrees", "Worktrees and merging"],
    ["long-runs", "Handoffs and sub-runs"],
    ["settings", "Settings"],
    ["recovery", "Recovery and cleanup"],
  ]],
  ["Where it runs", [
    ["tmux", "Running under tmux"],
    ["rex", "Running under Rex"],
    ["remote", "Remote crewmates"],
    ["model-routing", "Model routing"],
  ]],
  ["Reference", [
    ["commands", "Commands"],
    ["environment", "Environment variables"],
    ["changelog", "Changelog"],
  ]],
];
// Pages copied in from docs/ at deploy time are edited there, not here.
const SOURCE = { "model-routing": "docs/model-routing.md", changelog: "docs/CHANGELOG.md" };
const REPO = "https://github.com/zenodea/lodestar";

const PAGES = NAV.flatMap(([, items]) => items);
const titleOf = (slug) => (PAGES.find(([s]) => s === slug) || [])[1];
// The docs can be loaded on their own, or mounted into the landing page without a reload,
// so elements are looked up on mount and the document-wide listeners check they're still there.
const DOCS_DIR = new URL(".", document.currentScript.src);
let doc, side, toc, pager, edit, menu, scrim, q, results;
const mounted = () => !!doc && doc.isConnected && location.pathname.startsWith(DOCS_DIR.pathname);
const cache = new Map();

function slugify(text) {
  return text.toLowerCase().replace(/`/g, "").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function source(slug) {
  if (!cache.has(slug)) {
    const got = fetch(new URL(`pages/${slug}.md`, DOCS_DIR)).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.text();
    });
    got.catch(() => cache.delete(slug)); // so a later visit tries again
    cache.set(slug, got);
  }
  return cache.get(slug);
}

function current() {
  const p = new URLSearchParams(location.search).get("p");
  return titleOf(p) ? p : "introduction";
}

function drawSide(slug) {
  side.innerHTML = NAV.map(([group, items]) => `<h2>${group}</h2><ul>${items.map(([s, t]) =>
    `<li><a href="?p=${s}"${s === slug ? ' aria-current="page"' : ""}>${t}</a></li>`).join("")}</ul>`).join("");
}

// A small highlighter for shell snippets: comments, strings, flags, the main commands.
function highlight(code) {
  const text = code.textContent;
  const re = /((?<=^|\s)#[^\n]*)|("(?:[^"\\\n]|\\.)*")|((?<=^|\s)--?[A-Za-z][\w-]*)|((?<=^|\s)(?:lodestar|herdr|tmux|git|zig)\b)/gm;
  let out = "", last = 0, m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "f" : "k";
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  code.innerHTML = out + esc(text.slice(last));
}

function decorate(slug) {
  const seen = new Map();
  const heads = [...doc.querySelectorAll("h2, h3")];
  for (const h of heads) {
    let id = slugify(h.textContent) || "section";
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += `-${n}`;
    h.id = id;
    const a = document.createElement("a");
    a.className = "anchor"; a.href = `#${id}`; a.textContent = "#";
    a.setAttribute("aria-label", `Link to ${h.textContent}`);
    h.prepend(a);
  }
  for (const code of doc.querySelectorAll("pre code")) {
    if (/language-(sh|bash|shell|text)|^$/.test(code.className) || !code.className) highlight(code);
    const pre = code.parentElement;
    const b = document.createElement("button");
    b.type = "button"; b.className = "copy"; b.textContent = "Copy";
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code.textContent.trim()); b.textContent = "Copied"; }
      catch { b.textContent = "Select it"; }
      b.classList.add("done");
      setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1500);
    });
    pre.appendChild(b);
  }
  // Links to the old guide on GitHub point at the pages here instead.
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (/^(https?:)?\/\//.test(href)) { a.target = "_blank"; a.rel = "noopener"; }
    else if (/\.md(#|$)/.test(href)) a.href = `${REPO}/blob/main/${href.replace(/^(\.\.\/)+/, "").replace(/^(?!docs\/)/, "docs/")}`;
  }

  const items = heads.map((h) => `<li><a class="${h.tagName === "H3" ? "sub" : ""}" href="#${h.id}">${esc(h.textContent.replace(/^#/, ""))}</a></li>`);
  toc.innerHTML = items.length > 1 ? `<p>On this page</p><ul>${items.join("")}</ul>` : "";
  watchHeadings(heads);

  const i = PAGES.findIndex(([s]) => s === slug);
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  pager.innerHTML = (prev ? `<a class="prev" href="?p=${prev[0]}"><span>Previous</span><strong>${prev[1]}</strong></a>` : "")
    + (next ? `<a class="next" href="?p=${next[0]}"><span>Next</span><strong>${next[1]}</strong></a>` : "");
  edit.innerHTML = `<a href="${REPO}/edit/main/${SOURCE[slug] || `site/docs/pages/${slug}.md`}">Edit this page on GitHub</a>`;
}

// The section you're reading: the last heading that has reached the top bar, the first one before any has,
// and the last one once the page can't scroll further (a short last section never reaches the top).
let tocHeads = [], tocFrame = 0;
function markReading() {
  tocFrame = 0;
  if (!mounted()) return;
  const links = toc.querySelectorAll("a");
  if (!links.length || links.length !== tocHeads.length) return;
  let at = 0;
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) at = tocHeads.length - 1;
  else tocHeads.forEach((h, i) => { if (h.getBoundingClientRect().top <= 90) at = i; });
  links.forEach((a, i) => a.classList.toggle("on", i === at));
}
function watchHeadings(heads) {
  tocHeads = heads;
  markReading();
}
const soon = () => { tocFrame ||= requestAnimationFrame(markReading); };
addEventListener("scroll", soon, { passive: true });
addEventListener("resize", soon);

async function show(slug, hash) {
  drawSide(slug);
  closeMenu();
  try {
    doc.innerHTML = marked.parse(await source(slug));
  } catch {
    doc.innerHTML = `<h1>Not here yet</h1><p class="missing">This page didn't load. Try the <a href="?p=introduction">introduction</a>.</p>`;
  }
  document.title = `${titleOf(slug)} · Lodestar docs`;
  decorate(slug);
  const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
  markReading();
  window.packDocsShown = true;
  document.dispatchEvent(new CustomEvent("docs:shown"));
  // The rest of the pages are small: fetch them once this one is up, so changing page is instant.
  (window.requestIdleCallback || setTimeout)(() => prefetch());
}

function prefetch(...slugs) {
  for (const slug of slugs.length ? slugs : PAGES.map(([s]) => s)) source(slug).catch(() => {});
}

// In-page navigation without reloading.
document.addEventListener("click", (e) => {
  if (!mounted()) return;
  const a = e.target.closest("a[href]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === "_blank") return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname) return;
  const slug = url.searchParams.get("p");
  if (!slug) return;
  e.preventDefault();
  if (slug === current() && url.hash) {
    history.pushState(null, "", url);
    document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    return;
  }
  history.pushState(null, "", url);
  show(slug, url.hash);
  hideResults();
});
addEventListener("popstate", () => { if (mounted()) show(current(), location.hash); });

// The page list on phones.
function closeMenu() { side.classList.remove("open"); scrim.hidden = true; menu.setAttribute("aria-expanded", "false"); }

// Search: every page split into its sections, matched on all the words typed.
let index = null, picked = 0;
async function buildIndex() {
  if (index) return index;
  index = [];
  await Promise.all(PAGES.map(async ([slug, title]) => {
    let md;
    try { md = await source(slug); } catch { return; }
    let head = title, id = "", body = [];
    const seen = new Map();
    const flush = () => { if (body.length || id) index.push({ slug, page: title, head, id, text: body.join(" ").replace(/[`*_|>#]/g, " ").replace(/\s+/g, " ") }); };
    for (const line of md.split("\n")) {
      const h = /^(#{2,3})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        head = h[2].replace(/`/g, "");
        let s = slugify(h[2]) || "section";
        const n = seen.get(s) || 0; seen.set(s, n + 1);
        id = n ? `${s}-${n}` : s; body = [];
      } else if (!/^#\s/.test(line)) body.push(line);
    }
    flush();
  }));
  return index;
}
function hideResults() { results.hidden = true; }
function mark(text, words) {
  let out = esc(text);
  for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
  return out;
}
async function search() {
  const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) { hideResults(); return; }
  const all = await buildIndex();
  const hits = all.map((r) => {
    const head = r.head.toLowerCase(), text = r.text.toLowerCase();
    if (!words.every((w) => head.includes(w) || text.includes(w))) return null;
    const whole = (hay, w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay);
    let score = words.reduce((s, w) => s + (head.includes(w) ? 10 : 0) + (whole(head, w) ? 8 : 0) + (head.startsWith(w) ? 5 : 0) + (whole(text, w) ? 2 : text.includes(w) ? 1 : 0), 0);
    if (r.slug === "changelog") score *= .3;
    return { r, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
  picked = 0;
  results.innerHTML = hits.length ? hits.map(({ r }, i) => {
    const at = r.text.toLowerCase().indexOf(words[0]);
    const snip = r.text.slice(Math.max(0, at - 40), at + 100).trim();
    return `<li><a class="${i ? "" : "on"}" href="?p=${r.slug}${r.id ? `#${r.id}` : ""}"><span class="r-where">${esc(r.page)}</span><span class="r-title">${mark(r.head, words)}</span><span class="r-snip">${mark(snip, words)}</span></a></li>`;
  }).join("") : `<li class="r-none">Nothing matches “${esc(q.value)}”.</li>`;
  results.hidden = false;
}
function searchKeys(e) {
  const links = [...results.querySelectorAll("a")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!links.length) return;
    picked = (picked + (e.key === "ArrowDown" ? 1 : links.length - 1)) % links.length;
    links.forEach((a, i) => a.classList.toggle("on", i === picked));
    links[picked].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter" && links[picked]) {
    e.preventDefault(); links[picked].click(); q.blur();
  } else if (e.key === "Escape") { hideResults(); q.blur(); }
}
document.addEventListener("click", (e) => { if (mounted() && !e.target.closest(".search")) hideResults(); });
document.addEventListener("keydown", (e) => {
  if (!mounted()) return;
  const typing = /input|textarea/i.test(document.activeElement.tagName);
  if (!typing && (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey)))) { e.preventDefault(); q.focus(); q.select(); }
});

function mount() {
  [doc, side, toc, pager, edit] = ["doc", "side", "toc", "pager", "edit"].map((id) => document.getElementById(id));
  [menu, scrim] = [".menu", ".scrim"].map((sel) => document.querySelector(sel));
  q = document.getElementById("q");
  results = document.getElementById("results");
  menu.addEventListener("click", () => {
    const open = !side.classList.contains("open");
    side.classList.toggle("open", open); scrim.hidden = !open; menu.setAttribute("aria-expanded", String(open));
  });
  scrim.addEventListener("click", closeMenu);
  q.addEventListener("input", search);
  q.addEventListener("focus", () => { buildIndex(); if (q.value) search(); });
  q.addEventListener("keydown", searchKeys);
  return show(current(), location.hash);
}
window.packDocs = { mount, prefetch };
// Inside the landing page, script.js mounts it once the docs are on the page.
if (document.getElementById("doc") && !document.getElementById("docs-root")) mount();
