**English** | [简体中文](MIGRATING_FROM_SILLYTAVERN.zh-CN.md)

# Coming from SillyTavern? Bring a card you know by heart.

A new client takes a little getting used to. A card you already know is the best place to start: you know its opening, how its character state should develop, and what its familiar buttons do.

This guide helps you bring your cards and resources into TipsyIsle and find your way around. For startup and app build instructions, see the [README](../README.md#start-your-first-story). Translated menu names below include the app's current Chinese labels so you can find them on screen.

## Gather the creations you want to bring

Export from SillyTavern, or use the original files supplied by the creator:

| Content | What to prepare | How to use it in TipsyIsle |
| --- | --- | --- |
| Character cards | A PNG containing character data, or a character card JSON file. | Choose Import (导入) in the library (馆藏). An ordinary avatar image is not a character card. |
| Worldbooks | A worldbook JSON file. | Use the same import entry. Worldbooks embedded in a card are enabled with it, so you do not need to import them again. |
| Presets | A preset JSON file. | Import it, then select it in Preset Details (预设明细). Importing does not change your active preset automatically. |
| Your persona | Your name, avatar, and persona description. | Enter these in Settings → Persona (设置 → 个人资料). You can set a global persona and a story-specific identity. |
| Model connection | Endpoint, API key, protocol, and model name. | Configure and save these in Settings → Model Connection (设置 → 模型连接). |

The import entry handles character cards, worldbooks, and presets. **It does not provide a one-click migration of an entire SillyTavern data directory, chat history, or all settings.** Appearance packs and TipsyIsle plugins also have their own formats. Existing SillyTavern themes, CSS, and extensions need to be considered against the interfaces and page structure they use.

You can export a character card from its menu as a standard V2 / V3 PNG, including character data such as its embedded worldbook and regex scripts. This export does not include chat saves.

## Start with familiar scenes and interactions

1. **Read the creator's instructions.** Check the recommended model, preset, and worldbooks, along with any dependencies on Tavern Helper, Prompt Template, MVU, or other extensions.
2. **Import and select your resources.** Open the card and confirm its worldbook. After importing an additional preset, remember to select it.
3. **Configure your model and persona.** Save your settings. Starting with a model and preset you already know makes differences easier to understand.
4. **Play through a short interaction.** Read the opening, send a reply, and try the card's buttons, status panels, and variable updates. For complex cards, check their actual interactions as well as the import result.
5. **Try what TipsyIsle adds.** Adjust your reading style, select “Choose again from here” (从这里重新选择) beside a model reply after the opening, then switch back using the story map to experience saving and restoring different routes.

You can revisit the onboarding tour through Settings → Usage Guide (设置 → 使用引导) at any time.

## Compatibility and scope

TipsyIsle uses a new, independently designed architecture and does not require SillyTavern at runtime. Imported creations run through TipsyIsle's own content parsing, prompt pipeline, variable handling, and creator page runtime. A compatibility layer adapts calls to SillyTavern-related APIs.

It already supports text conversations, stories driven by variables, dynamic status panels, and interactive HTML pages. **Every character card the project author has personally tried so far has run successfully.** The table below explains how to use these capabilities and where third-party extension adaptation comes in.

| Capability used by a creation | Usage and adaptation scope |
| --- | --- |
| Character definitions, alternate openings, and embedded worldbooks | Importing and runtime support are available. Check that you have prepared the resources the creator recommends. |
| Macros, regex, worldbook triggers, and prompt templates | Dedicated processing modules are available. Actual behavior depends on the syntax, configuration, and trigger combinations used. |
| MVU variables and status panels | Variable parsing, updates, and restoration are supported. Match variable settings, creator scripts, and any additional analysis connection to the card's requirements. |
| Interactive HTML pages and Tavern Helper APIs | Creator content has its own runtime. Specific helper APIs, cross-window access, or dependencies on the original SillyTavern DOM may need adaptation. |
| Third-party SillyTavern extensions | Manage these under Settings → Plugins → SillyTavern-compatible Extensions (设置 → 插件 → 酒馆兼容扩展). Compatibility depends on their dependencies; they use a different installation path from TipsyIsle plugins. |

A familiar macro or plugin name alone does not establish support for every behavior of that tool. If a complex card behaves unexpectedly, its dependencies and reproduction steps help us identify what needs adapting.

## Connect models and switch devices

The Windows and Android apps can directly call **OpenAI-compatible Chat Completions endpoints** using your own endpoint, API key, and model. Some provider-specific protocols and account authorization features depend on the local Node gateway. Use the local web mode through `npm start` when you need them. Model connection capabilities differ between runtime modes.

You provide the model service. Local storage of resources and progress does not mean the client includes a model that can generate replies offline.

To move from your computer to your phone:

1. Connect both devices to the same local network and enable discovery in Settings → Device Sync (设置 → 双端互通).
2. Follow the on-screen steps to pair them for the first time. Paired devices can reconnect automatically when discovered again.
3. Choose Sync Now (立即同步), wait for it to finish, then continue on the other device.
4. Configure the model connection separately on that device. Service endpoints and API keys are not synced.

Sync covers character cards, worldbooks, presets, personas, and story progress. Appearance and gallery content have their own sync options. Each device saves its own progress while disconnected from the other. If you continue the same save independently on both, reconnecting preserves both continuations. When both devices edit a worldbook, you can review the differences and choose how to resolve the conflict.

## Tell us what you encounter

Open an [issue](https://github.com/Steveaaaaa/TipsyIsle/issues) and, where possible, include:

- Your device, app version, and whether you use an installed app or the local web mode.
- The plugins or extensions the creation depends on, with versions if known.
- Where the issue starts, what you expected, and what happened instead.
- A small shareable reproduction, screenshots, or relevant error messages.

Remove API keys, private conversations, and other private content before posting. Share only the card files and creator materials you have permission to share.

Every real experience you bring helps TipsyIsle better understand its community. We hope that, on your next visit, the step that interrupted your story is one you can take with ease.
