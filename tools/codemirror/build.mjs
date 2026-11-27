// Builds the Play page's code editor (site_src/play/vendor/codemirror.js) and, beside it, the licence of every package
// that went into it (codemirror.LICENSES.txt). The packages are MIT, which asks for the copyright and licence text to
// travel with every copy; the minified bundle keeps no comments, so the texts go in a file of their own and the bundle's
// first line points to it (S-327). Which packages are listed comes from esbuild's own record of what it bundled, so the
// list cannot drift from the bundle.
import { build } from "esbuild";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VENDOR = "../../site_src/play/vendor";
const LICENSES = "codemirror.LICENSES.txt";

const result = await build({
  entryPoints: ["entry.js"],
  bundle: true,
  minify: true,
  format: "esm",
  legalComments: "none",
  banner: { js: `/* CodeMirror 6 and the packages it uses, MIT licence: see ${LICENSES} beside this file */` },
  outfile: `${VENDOR}/codemirror.js`,
  metafile: true,
});

// "node_modules/@codemirror/view/dist/index.js" -> "@codemirror/view"
const bundled = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const found = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (found) bundled.add(found[1]);
}

const sections = [...bundled].sort().map((name) => {
  const folder = join("node_modules", name);
  const { version, license } = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const file = readdirSync(folder).find((entry) => /^licen[cs]e/i.test(entry));
  if (!file) throw new Error(`${name} has no licence file: add its text by hand before shipping`);
  const text = readFileSync(join(folder, file), "utf8").replace(/\r\n/g, "\n").trim();
  return `${name} ${version} (${license})\n\n${text}`;
});

const heading = "The code editor of funground's Play page (codemirror.js) is built from these packages. "
  + "Each one's licence follows.";
writeFileSync(`${VENDOR}/${LICENSES}`, `${heading}\n\n${"=".repeat(72)}\n\n${sections.join(`\n\n${"=".repeat(72)}\n\n`)}\n`);
console.log(`codemirror.js and ${LICENSES}: ${bundled.size} packages`);
