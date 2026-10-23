import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "pack-leader-capture-"));
let browser;
try {
  execFileSync(process.execPath, [join(root, "scripts/render-previews.mjs"), directory], { stdio: "inherit" });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
  for (const [name, width, height] of [["pack-overview", 572, 736], ["worker-question", 620, 354]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(join(directory, `${name}.html`)).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(root, `site/assets/${name}.png`) });
    await page.close();
    console.log(`Captured site/assets/${name}.png`);
  }
} finally {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
}
