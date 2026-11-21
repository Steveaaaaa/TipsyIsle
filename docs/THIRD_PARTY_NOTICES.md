**English** | [简体中文](THIRD_PARTY_NOTICES.zh-CN.md)

# Reused code and reference sources

DOMPurify 3.4.18 sanitizes HTML produced by Showdown for ordinary messages. Creator-authored interactive scripts remain in the existing isolated runtime. The official package is dual-licensed under Apache-2.0 OR MPL-2.0; the licenses are copied to `public/licenses/dompurify.txt` and `public/licenses/dompurify-MPL.txt`.

The official full browser build of Vue 3.5.21, `vue.global.prod.js`, provides the global Vue API, reactive state, and template compilation inside creator iframes. It is emitted by the local build and runs in each child document. The MIT license is retained in `public/licenses/vue.txt`, Copyright (c) 2018-present, Yuxi (Evan) You.

The following material is reused from `MagicalAstrogy/MagVarUpdate`, commit `d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc`, under the MIT license. The original attribution, Copyright (c) 2025 MagicalAstrogy & StageDog, is retained. The full license ships at `public/licenses/MagVarUpdate.txt`, copied to `dist/licenses/MagVarUpdate.txt` after building.

- The tag scanner in `src/pipeline/mvu-markup.ts` is adapted from `src/function/update/structured_update.ts`, with support added for the initvar category, backticks, and scanning Unicode YAML keys.
- `src/pipeline/mvu-prompts.ts` retains model prompts and additional parsing task text from `src/prompts/`. Sources and SHA-256 hashes are recorded in `docs/references/compatibility-audit-sources.json`.
- `server/pi-non-streaming.mjs` is transpiled from `src/function/update/pi/non_streaming_fetch.ts`. It allows server-side protocol adapters to feed non-streaming responses into Pi's streaming parser.

This reuse does not include that project's entire host or UI.

Tavern Helper, Prompt Template, and MVU Zod were consulted as references for checking behavior. This repository retains only their sources, pinned commits, and checksums in `docs/references/compatibility-audit-sources.json`; it does not distribute copies of their reference source code. Their respective PolyForm Noncommercial, AGPL, and PolyForm Noncommercial licenses are provided upstream. Their host implementations have not been incorporated wholesale into the product. MVU Zod interface and event adaptation is implemented independently using the existing Zod dependency and local variable modules; the value parsing through `new Function` in the upstream release file is not executed.

External dependencies are managed through `package.json` / `package-lock.json`, with each package retaining its license. MVU data parsing uses JSON5 2.2.3, YAML, and mathjs 12.4.1 loaded on demand. Mathematical expressions do not use JavaScript eval. Assignment, indirect calls, changes to units or configuration, and similar operations are outside the currently permitted expression set.

The header of the pinned `libs/faker.mjs` file identifies Prompt Template's Faker dependency as `@faker-js/faker@9.7.0`. TipsyIsle installs the official npm package at that version and exposes its full module exports through a separate asynchronous chunk. It does not copy the plugin's esm.sh build. The MIT license and historical contribution licenses ship in `public/licenses/faker.txt`.

Additional standalone dependencies and attributions are listed below. Production builds copy `public/licenses/` into `dist/licenses/`.

| Source | Usage | License file |
| --- | --- | --- |
| `@earendil-works/pi-ai` 1.3.0, Mario Zechner | Server-side model protocols, catalog, and OAuth adapters, loaded on demand. | `public/licenses/pi-ai.txt`, from the [official v1.3.0 repository](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE). |
| `gpt-tokenizer` 4.1.2, Bazyli Brzoska | cl100k / o200k tokenizers loaded on demand. | `public/licenses/gpt-tokenizer.txt` and `public/licenses/Unicode.txt`, copied from the package's MIT and Unicode licenses respectively. |
| `moment` 2.31.0, OpenJS Foundation and other contributors | Date and time macros. | `public/licenses/moment.txt`, copied from the package's MIT license. |
| `droll` 0.2.1, Ethan Zimmerman | Dice macros. | `public/licenses/droll.txt`, copied from the package's MIT license. |
| `seedrandom` 3.0.5, David Bau | Reproducible pick macros. | `public/licenses/seedrandom.txt`, retaining the MIT license header from `seedrandom.js`. |
| cyrb53, bryc, 2018 | String hashing in `src/pipeline/content-hash.ts`. | `public/licenses/cyrb53.txt`, retaining the reference file's public-domain statement. This does not imply that the original host's entry structure was copied in full. |
| QuickJS and quickjs-emscripten 0.32.0 | TipsyIsle plugin sandbox. | `public/licenses/quickjs-emscripten.txt`. |
| Ajv 8.17.1 and semver 7.7.3 | Plugin manifest and API version validation. | `public/licenses/ajv*.txt` and `public/licenses/semver.txt`. |
| Cropper.js 1.6.2, Chen Fengyuan | Loaded on demand for the compatibility layer's image crop popup. | `public/licenses/cropperjs.txt` (MIT). |

Pi and its SDK dependencies remain in the local Node gateway; their licenses are retained in the installation packages. They are not bundled into the frontend build. Reference source code from Tavern Helper, Prompt Template, and SillyTavern is used only to check behavior during development and is not part of the product's runtime modules.

`@babel/parser` 7.29.14 parses static accesses to the top-level window in creator scripts on demand, avoiding changes to comments, strings, or the saved creator source. Its MIT license is copied to `public/licenses/babel-parser.txt`. Remote scripts from Daoyuan Workshop (道渊工坊) were downloaded only to `.runtime` to inspect their host-detection conditions; they were neither incorporated into the product nor executed.
