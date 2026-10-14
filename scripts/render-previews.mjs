// Render the production sidebar functions with fictional data. No agents or herdr
// connections are started. The HTML is a capture surface, not a second UI implementation.
// Usage: node scripts/render-previews.mjs /tmp/pack-leader-previews
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: node scripts/render-previews.mjs OUTPUT_DIRECTORY");
const destination = resolve(process.argv[2]);
const sandbox = mkdtempSync(join(tmpdir(), "pack-leader-preview-"));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PACK_") || name.startsWith("HERDR_")) delete process.env[name];
}
Object.assign(process.env, {
  HOME: sandbox,
  XDG_CONFIG_HOME: join(sandbox, "config"),
  XDG_STATE_HOME: join(sandbox, "state"),
  HERDR_PLUGIN_STATE_DIR: join(sandbox, "pack-state"),
  HERDR_SOCKET_PATH: join(sandbox, "no-live-herdr.sock"),
});

const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const palette = { 31: "#f29d91", 32: "#b6d69b", 33: "#ead08f", 34: "#8eb9dc", 35: "#c1a4d4", 36: "#9bc9bf", 90: "#98a49b" };

// Only SGR styles emitted by src/ansi.ts: colour, bold and dim. The text and
// box layout come directly from src/sidebar.ts, including wrapping and choices.
function ansiHtml(text) {
  const style = { color: "", bold: false, dim: false };
  return text.split(/(\x1b\[[0-9;]*m)/).map((part) => {
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) Object.assign(style, { color: "", bold: false, dim: false });
        else if (code === 1) style.bold = true;
        else if (code === 2) style.dim = true;
        else if (code === 22) { style.bold = false; style.dim = false; }
        else if (code === 39) style.color = "";
        else if (code === 38 && codes[i + 1] === 2) {
          style.color = `rgb(${codes.slice(i + 2, i + 5).join(",")})`;
          i += 4;
        } else if (palette[code]) style.color = palette[code];
      }
      return "";
    }
    const css = [style.color && `color:${style.color}`, style.bold && "font-weight:700", style.dim && "opacity:.65"].filter(Boolean).join(";");
    return `<span style="${css}">${escape(part)}</span>`;
  }).join("");
}

function document(title, lines, height) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#17221d;color:#e4e9e0;font-family:"DejaVu Sans Mono",monospace}
.frame{height:${height}px;overflow:hidden;border:1px solid #35453a;border-radius:10px;display:flex;flex-direction:column}
header{height:49px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 27px;border-bottom:1px solid #344238;background:#202d25;font:12px "DejaVu Sans Mono",monospace}
.label{color:#a8b6aa;font-size:10px;letter-spacing:1px}pre{font:17px/24px "DejaVu Sans Mono",monospace;font-variant-ligatures:none;margin:0;padding:26px 28px;flex:1;white-space:pre}
footer{padding:0 28px 15px;font:10px "DejaVu Sans Mono",monospace;letter-spacing:.3px;color:#98a89b}
</style><div class="frame"><header><span>${escape(title)}</span><span class="label">DEMO DATA</span></header><pre>${ansiHtml(lines.join("\n"))}</pre><footer>Production sidebar renderer · no live sessions</footer></div></html>`;
}

const realNow = Date.now;
try {
  // A fixed clock makes runtime labels reproducible.
  Date.now = () => Date.parse("2026-01-01T12:08:00Z");
  const { boxLines, goalLines } = await import("../src/sidebar.ts");
  const { dim, fg } = await import("../src/ansi.ts");
  const base = {
    run_id: "demo", pane_id: "w-demo:p1", cwd: "/demo/project", task_id: "t-demo", dispatch_id: "d-demo",
    started_at: "2026-01-01T12:04:00Z", last_status: "working", last_seq: 1,
    last_seen: "2026-01-01T12:08:00Z", owns_pane: true, retained: false,
  };
  const message = (type, body, extra = {}) => ({ id: "m-demo", run_id: "demo", ts: "2026-01-01T12:08:00Z", type, from: "tests", to: "orchestrator", task_id: "t-demo", dispatch_id: "d-demo", body, acked: false, ...extra });
  const task = (title, status = "dispatched") => ({ title, status });
  const theme = { accent: "#b6d69b" };
  const parser = { ...base, name: "parser", kind: "claude" };
  const validator = { ...base, name: "validator", kind: "codex" };
  const tests = { ...base, name: "tests", kind: "pi" };
  const ask = message("ask", "Reject invalid rows, or skip them?", { options: ["Reject import", "Skip rows"] });
  const overview = [
    ...goalLines("Ship CSV import", 48), "", fg.yellow("Unread: 1"), "", dim("─".repeat(48)), "",
    ...boxLines(parser, task("Parse CSV input", "succeeded"), message("done", "Parser + tests committed.", { outcome: "succeeded" }), "done", 48, true, theme),
    ...boxLines(validator, task("Validate imported rows"), message("heartbeat", "Checking edge cases."), "working", 48),
    ...boxLines(tests, task("Cover invalid input"), ask, "blocked", 48),
  ];
  const detail = boxLines(tests, task("Cover invalid input"), {
    ...ask,
    body: "Some rows have missing emails. Should I reject the entire import or skip invalid rows?",
  }, "blocked", 52, true, theme);
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "pack-overview.html"), document("Pack Leader / sidebar", overview, 736));
  writeFileSync(join(destination, "worker-question.html"), document("Pack Leader / selected worker", detail, 354));
  console.log(`Preview HTML written to ${destination}`);
} finally {
  Date.now = realNow;
  rmSync(sandbox, { recursive: true, force: true });
}
