# Third-party notices

This website and its Play page are built from other people's free software and fonts. Each keeps its own licence.
This page lists them, with the copyright line each licence asks us to show and where its full text is. funground's own
licence and its library's dependencies are on the [About](about.md) page.

## Shipped with this site

These files are on this website, so their licence texts are here too.

| What | Version | Licence | Copyright | Full text |
|---|---|---|---|---|
| CodeMirror 6, Play's code editor, and the 14 small packages it uses (Lezer, style-mod, crelt, w3c-keyname, find-cluster-break) | autocomplete 6.20.3, view 6.43.14 and others | MIT | Marijn Haverbeke and others | [codemirror.LICENSES.txt](play/vendor/codemirror.LICENSES.txt), every package with its version |
| Blockly, the blocks view of Play, with its field plugins, icons and sounds | 13.4.0 | Apache-2.0 | Google LLC | [blockly.LICENSE.txt](play/vendor/blockly.LICENSE.txt) |
| blockly-fun, funground's blocks for Blockly | built from its repository | Apache-2.0 | ours | [blockly-fun](https://github.com/funground-hq/blockly-fun) |
| Atkinson Hyperlegible Next, the body font | 400 and 700 | SIL Open Font Licence 1.1 | 2020-2024 The Atkinson Hyperlegible Next Project Authors | [LICENSE-AtkinsonHyperlegibleNext.txt](assets/fonts/LICENSE-AtkinsonHyperlegibleNext.txt) |
| Bricolage Grotesque, the heading font | variable | SIL Open Font Licence 1.1 | 2022 The Bricolage Grotesque Project Authors | [LICENSE-BricolageGrotesque.txt](assets/fonts/LICENSE-BricolageGrotesque.txt) |
| JetBrains Mono, the code font | 400 and 700 | SIL Open Font Licence 1.1 | 2020 The JetBrains Mono Project Authors | [LICENSE-JetBrainsMono.txt](assets/fonts/LICENSE-JetBrainsMono.txt) |
| Material for MkDocs, the theme that builds these pages | 9.7.7 | MIT | 2016-2025 Martin Donath | [LICENSE](https://github.com/squidfunk/mkdocs-material/blob/master/LICENSE) |
| funground and funground-ml, run by Play in your browser | 0.2 in development | LGPL-2.1-only | ours | [LICENSE](https://github.com/funground-hq/funground/blob/main/LICENSE) |
| pycairo built for the browser, with cairo, pixman, libpng and zlib inside | pycairo 1.29.2, cairo 1.18.4 | pycairo and cairo: LGPL-2.1 or MPL-1.1; pixman, libpng and zlib: their own permissive licences | their authors | [funground-cairo-wasm](https://github.com/funground-hq/funground-cairo-wasm), which also has the sources and the build scripts |

## Loaded by Play from a public server

Play asks jsDelivr's servers for these when it starts. This website does not host or change them.

| What | Version | Licence | Copyright | Full text |
|---|---|---|---|---|
| Pyodide, Python in the browser, and the packages it brings (micropip, pillow, pygame-ce, fonttools) | 314.0.7 | MPL-2.0 (each package its own) | the Pyodide contributors | [Pyodide's LICENSE](https://github.com/pyodide/pyodide/blob/main/LICENSE) |
| ONNX Runtime Web, which runs the models in your browser | 1.30.0 | MIT | Microsoft Corporation | [ONNX Runtime's LICENSE](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) |

The models themselves (pose, hands, the person cut-out, sounds, speech and teaching) come with funground-ml. Their
licences and the limits their makers set are in
[THIRD_PARTY_LICENSES.md](https://github.com/funground-hq/funground/blob/main/THIRD_PARTY_LICENSES.md).
