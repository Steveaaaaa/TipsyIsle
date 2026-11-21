[English](THIRD_PARTY_NOTICES.md) | **简体中文**

# 可独立复用的代码与参考来源

DOMPurify 3.4.18 用于普通消息经 Showdown 转换后的 HTML 净化；作者交互脚本保留在既有隔离运行环境。官方包采用 Apache-2.0 OR MPL-2.0 双许可，许可复制于 `public/licenses/dompurify.txt` 与 `public/licenses/dompurify-MPL.txt`。

Vue 3.5.21 的官方 `vue.global.prod.js` 完整浏览器构建用于作者 iframe 的全局 Vue API、响应式状态与模板编译；由本地构建输出并在各子文档执行。MIT 许可保留于 `public/licenses/vue.txt`，Copyright (c) 2018-present, Yuxi (Evan) You。

以下内容复用自 `MagicalAstrogy/MagVarUpdate` 提交 `d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc`，采用 MIT 许可证。保留原作者 Copyright (c) 2025 MagicalAstrogy & StageDog；完整许可随产品位于 `public/licenses/MagVarUpdate.txt`，构建后为 `dist/licenses/MagVarUpdate.txt`。

- `src/pipeline/mvu-markup.ts` 的标签扫描器改编自 `src/function/update/structured_update.ts`，适配增加 initvar 类别、反引号和 Unicode YAML 键扫描。
- `src/pipeline/mvu-prompts.ts` 保留 `src/prompts/` 中的模型提示词与额外解析任务文本，来源与 SHA-256 记录在 `docs/references/compatibility-audit-sources.json`。
- `server/pi-non-streaming.mjs` 转译自 `src/function/update/pi/non_streaming_fetch.ts`，供服务端协议适配器将非流式响应接入 Pi 的流式解析器。

上述复用不包含该项目的整个宿主或 UI。

酒馆助手、提示词模板、MVU Zod 曾作为行为核对参考；仓库仅保留 `docs/references/compatibility-audit-sources.json` 中的来源、锁定提交及校验值，不分发其参考源码副本。它们各自的 PolyForm Noncommercial、AGPL 和 PolyForm Noncommercial 许可由上游提供；它们的宿主实现未整体并入产品。MVU Zod 通过现有 Zod 和本地变量模块独立实现接口与事件适配，不执行发布文件内的 `new Function` 值解析。

外部依赖通过 `package.json`/`package-lock.json` 管理，各包保留其许可证。MVU 数据解析使用 JSON5 2.2.3、YAML 与按需加载的 mathjs 12.4.1。数学表达式不使用 JavaScript eval；赋值、间接调用、单位/配置修改等不属于当前允许的数学表达式集合。

提示词模板的 Faker 依赖由锁定 `libs/faker.mjs` 文件头确认为 `@faker-js/faker@9.7.0`。产品安装相同版本官方 npm 包，通过独立异步块提供完整模块导出，未复制插件的 esm.sh 构建。MIT 及历史贡献许可随产品位于 `public/licenses/faker.txt`。

本轮新增的可独立依赖与署名如下；`public/licenses/` 在生产构建时一并复制到 `dist/licenses/`。

| 来源 | 使用范围 | 许可文件 |
| --- | --- | --- |
| `@earendil-works/pi-ai` 1.3.0，Mario Zechner | 服务端模型协议、目录和 OAuth 适配，按需加载 | `public/licenses/pi-ai.txt`；取自 [v1.3.0 官方仓库](https://github.com/earendil-works/pi/blob/v1.3.0/LICENSE) |
| `gpt-tokenizer` 4.1.2，Bazyli Brzoska | 按需加载 cl100k/o200k 分词器 | `public/licenses/gpt-tokenizer.txt`、`public/licenses/Unicode.txt`，分别复制包内 MIT 和 Unicode 许可 |
| `moment` 2.31.0，OpenJS Foundation and other contributors | 日期与时间宏 | `public/licenses/moment.txt`，复制包内 MIT 许可 |
| `droll` 0.2.1，Ethan Zimmerman | 骰子宏 | `public/licenses/droll.txt`，复制包内 MIT 许可 |
| `seedrandom` 3.0.5，David Bau | 可重复的 pick 宏 | `public/licenses/seedrandom.txt`，保留 `seedrandom.js` 首部 MIT 许可 |
| cyrb53，bryc，2018 | `src/pipeline/content-hash.ts` 中的字符串哈希算法 | `public/licenses/cyrb53.txt`，保留参考文件的公共领域声明；不将原宿主条目结构视为已完整复制 |
| QuickJS 与 quickjs-emscripten 0.32.0 | 原生插件沙箱 | `public/licenses/quickjs-emscripten.txt` |
| Ajv 8.17.1 与 semver 7.7.3 | 校验插件清单和 API 版本 | `public/licenses/ajv*.txt`、`public/licenses/semver.txt` |
| Cropper.js 1.6.2，Chen Fengyuan | 兼容层的图片裁剪弹窗按需加载 | `public/licenses/cropperjs.txt`（MIT） |

Pi 及其 SDK 依赖留在本地 Node 网关，安装包中的许可证继续保留；前端构建不打包它们。酒馆助手、提示词模板和 SillyTavern 的参考源码仅供开发时核对行为，不属于产品运行模块。

`@babel/parser` 7.29.14 用于按需解析作者脚本的静态顶层窗口访问，避免修改注释、字符串或保存的作者源码。MIT 许可复制到 `public/licenses/babel-parser.txt`。道渊工坊远程脚本仅下载至 `.runtime` 阅读宿主检测条件，没有并入产品或执行。
