// Screenshots the site's key pages at three sizes, in both colour schemes, for comparing with design/mockups/.
//
//   node tools/design_shots.mjs <site url> <output folder>
//   node tools/design_shots.mjs http://localhost:8000 out/shots
//
// Prints, for every shot, the page's scroll width (a number larger than the viewport means something overflows
// sideways) and, on the Play page, the rendered size of the picture frame (should be the sketch's own size when
// it fits). Uses the installed Chrome through tools/codemirror's playwright-core, like tools/test_editor.mjs:
// run `npm install` in tools/codemirror first. Installs nothing.
import { mkdirSync } from "node:fs";
import path from "node:path";

const { chromium } = await import("./codemirror/node_modules/playwright-core/index.mjs");

const [site = "http://localhost:8000", out = "out/shots"] = process.argv.slice(2);
const CHROME = process.env.CHROME ?? "C:/Users/samirj/AppData/Local/Google/Chrome/Application/chrome.exe";

const PAGES = {
  home: "/",
  guide: "/guide/03_shapes/",
  gallery: "/gallery/",
  play: "/play/?example=basics/01_first_sketch",
};
const SIZES = { laptop: [1366, 768], desktop: [1920, 1080], phone: [390, 844] };
const SCHEMES = ["default", "slate"];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME });
try {
  for (const [sizeName, [width, height]] of Object.entries(SIZES)) {
    for (const scheme of SCHEMES) {
      for (const [pageName, route] of Object.entries(PAGES)) {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(new URL(route, site).href, { waitUntil: "load" });
        await page.evaluate((s) => document.body.setAttribute("data-md-color-scheme", s), scheme);
        await page.waitForTimeout(pageName === "play" ? 3000 : 600);
        const file = path.join(out, `${pageName}-${sizeName}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: pageName !== "play" });
        const facts = await page.evaluate(() => {
          const frame = document.querySelector(".fg-play__frame, .play-preview");
          const r = frame?.getBoundingClientRect();
          return {
            scrollWidth: document.documentElement.scrollWidth,
            picture: r ? `${Math.round(r.width)} x ${Math.round(r.height)}` : null,
          };
        });
        const overflow = facts.scrollWidth > width ? `  OVERFLOWS by ${facts.scrollWidth - width}px` : "";
        console.log(`${file}  scrollWidth=${facts.scrollWidth}${overflow}${facts.picture ? `  picture=${facts.picture}` : ""}`);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
