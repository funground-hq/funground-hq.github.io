# The editor bundle

`entry.js` is the Play page's code editor (CodeMirror 6, Python colours). esbuild bundles it, with the parts of
CodeMirror it uses, into one file that is committed: `../../site_src/play/vendor/codemirror.js`. The page loads that
file from its own site, never from a CDN (several copies of `@codemirror/state` break the editor).

To rebuild after changing `entry.js` or a version in `package.json`:

    cd tools/codemirror
    npm install
    npm run build

`node_modules/` is not committed. `playwright-core` is here only for `../test_editor.mjs`.
