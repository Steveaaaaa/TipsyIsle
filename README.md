**English** | [简体中文](README.zh-CN.md)

# TipsyIsle · 微醺屿

**Countless worlds. One place to call home.**

TipsyIsle is a local client built for **AI roleplay (AIRP) players** and the **creators and developers who shape the community**. Available on Windows, Android, and the local web, it brings immersive reading, branching stories, continuity across devices, and deep customization into one experience—so every evening with your characters feels a little more your own.

**TipsyIsle is built on a new, independently designed architecture.** It has its own interface, story state, prompt pipeline, local storage, and plugin system. It is not a reskin or wrapper around SillyTavern, and it does not require SillyTavern to run. Familiar community creations find their way here through format compatibility and API adapters.

We want this to become the place every AIRP player can eventually call home. Somewhere to open your first card, settle in with a collection of hundreds, or create the card, theme, preset, or plugin that takes roleplay somewhere new.

**A beautiful interface draws you in. Stories, freedom, and a community with room to grow give you reasons to stay.**

**[Download TipsyIsle](https://github.com/Steveaaaaa/TipsyIsle/releases/latest)** · [What's new in 1.1.6](docs/releases/1.1.6.en.md) · [Why try TipsyIsle?](#why-make-the-move) · [Migration guide](docs/MIGRATING_FROM_SILLYTAVERN.md) · [Developer docs](docs/ECOSYSTEM.md)

## New in 1.1.6

- **AVS model selection.** Select a saved connection to fill in its model name or fetch its model list.
- **Preset switches keep your edits.** Saved prompt text, enabled states, and your streaming preference no longer reset when you switch presets.
- **Simpler worldbook and story route management.** Open active worldbooks directly and review what will be removed before deleting a route, branch, or saved conversation.

## Why make the move?

After years with SillyTavern, you have more than a folder of character cards. You have carefully tuned presets, familiar routines, favorite creators, and stories whose meaning only you fully know. SillyTavern and its community have built a mature ecosystem over many years. Moving deserves a compelling reason.

TipsyIsle offers four: **an interface designed for immersive reading, a phone app that runs independently, story branches that preserve their state, and an experience you and the community can keep making your own.**

### An invitation to immerse yourself—and stay awhile

Characters and prose take center stage. Your library, settings, and controls each have their place. Clear spacing by day, quiet colors by night, and carefully considered line spacing and reading width give even hundreds of messages room to breathe. Focused reading, a remembered reading position, and controls that tuck away as you read help keep your attention on what your character says next.

Desktop gives your library and stories room to spread out. Mobile has navigation, input, and menus made for touch. **Good design lives in the first impression and in every page you read afterward.**

### Close your laptop. Take the story with you.

Windows and Android each have a standalone Tauri app. The phone app includes local storage and a runtime for creator-authored pages. With a supported model endpoint, you can keep playing directly on your phone without leaving your computer running.

Pair your devices on the same local network to sync character cards, worldbooks, presets, personas, and story progress. Changes save to the current device first and sync when idle; you can also sync immediately before switching devices. If you continue the same save separately on both devices, both versions of your progress are preserved when they reconnect. Conflicting worldbook edits can be reviewed side by side.

**A different screen. The same world waiting for you.** Configure model connections and API keys separately on each device; see the [connection guide](docs/MIGRATING_FROM_SILLYTAVERN.md#connect-models-and-switch-devices) for supported protocols.

### Keep the ending you love. Discover the one you never chose.

You have already walked that road together. But what if, back at the crossroads, you had said yes?

Choose “Choose again from here” (从这里重新选择) beside a model reply after the opening to follow another possibility while keeping the original route. The story map lets you explore summaries along each branch or see the conversations and routes across an entire character card.

When you return to a route, its text, story variables, and timed worldbook state return with it. The discoveries, relationships, and consequences of one path belong to that path. **Every possibility you care about has somewhere to keep growing.**

### Settle in. Make it yours.

Start with a wallpaper, or give the whole app a different character.

- **Read your way.** Adjust colors, fonts, font sizes, line spacing, and text width to suit you.
- **Put controls within reach.** Rearrange common interface elements, with separate layouts for desktop and mobile.
- **Make the details personal.** Replace logos, button icons, and startup artwork. Rewrite interface text. Even give your own TipsyIsle a new name.
- **Share your taste.** Preview, compare, and undo before saving. Export an appearance pack for someone else who will love it as much as you do.

If you write CSS, hooks such as `data-ti-shell` and `data-ti-part` let you go further. App appearance styles have their own scope, while card-authored HTML and interactive content keep their own runtime.

**The interface you imagine can become your everyday home—or the community's next favorite creation.**

## Bring your favorites from SillyTavern

Your favorite characters, carefully tuned presets, and collected worlds deserve to come with you. TipsyIsle supports SillyTavern community creations through its own parsing, execution, and API compatibility systems, all built on its independent architecture.

From text conversations to stories driven by variables, dynamic status panels, and interactive HTML pages, TipsyIsle already supports a rich range of character card experiences. **Every character card the project author has personally tried so far has run successfully in TipsyIsle.**

| Bring these along | Enjoy them in TipsyIsle |
| --- | --- |
| PNG / JSON character cards | Import cards with their embedded worldbooks enabled alongside the story. Export cards as standard V2 / V3 PNG files. |
| Worldbooks and presets | Import JSON files to bring familiar worldbuilding and storytelling styles with you, then edit, adjust, and select them in the app. |
| Existing chats | Import a `.jsonl` chat as a new conversation after selecting its character card. The migration guide explains which chat data comes with it. |
| Macros, regex, and prompt templates | Run the text processing, display formatting, and prompt logic that creators use to shape their work. |
| MVU variables, creator-authored HTML, and interactive scripts | Use variable updates, dynamic status panels, and HTML interactions in TipsyIsle's independent runtime. |
| SillyTavern extensions | Install, update, enable, and disable extensions, with their functionality connected through compatibility APIs. |

Bring a card you love, choose your usual model and preset, and meet again in an interface that feels right. Keep a branch when you want to try another choice. Take the story to your phone when you want a change of scenery. **The worlds you already love are welcome here.**

If your creation needs a specialized extension API that has yet to be adapted, open an [issue](https://github.com/Steveaaaaa/TipsyIsle/issues) with the experience you want to support. The guide below covers import steps and migration scope.

[From SillyTavern to TipsyIsle: import your creations, connect a model, and continue across devices →](docs/MIGRATING_FROM_SILLYTAVERN.md)

## For community creators and developers

**The community's imagination has always pushed AIRP forward.**

A card can hold a world. A preset can change the rhythm of a story. A status panel, appearance pack, or plugin can introduce a whole community to a new way to play. We want TipsyIsle's future to carry its creators' signatures: deep APIs for people who love to build, and the fruits of that creativity for people who simply want to play.

Card and preset authors can start with familiar formats and compatibility features. Theme creators can shape reading styles and app appearance. Plugin developers have an independent, versioned API for working with stories, resources, models, and the interface.

### Deeper APIs for bigger ideas

| What you want to create | Available extension capabilities |
| --- | --- |
| Story journals, route reviews, and long-story search | Page through conversations and route trees, read versioned messages and variables, and store data in `device`, `route`, and `reply` scopes. |
| Recaps, custom memory, and context strategies | Join the prompt pipeline through `beforeScan` / `afterScan`, contribute macros and injections, adjust the history sent to the model, and declare read-only tools for model use. |
| Worldbook assistants, story editors, and branching tools | Use `preview → commit → undo` for story and resource edits, with version checks and idempotent operations. |
| Images, speech, embeddings, and assistance from multiple models | Use player-authorized model connections and manage asynchronous tasks, media, and text / vector indexes. |
| Plugins with their own interfaces and ways to work together | Register commands in the composer, on messages, or in the app menu; use dialogs, sidebars, or full-screen views; collaborate through versioned plugin services. |

These are **APIs you can use to build those experiences**. The repository includes [Story Journal](examples/plugins/story-journal) and [Action Options](examples/plugins/action-options) as starting points.

### A new, independent architecture designed for AIRP

TipsyIsle's foundation is independently designed: **React + TypeScript** for the interface and core logic, **Tauri 2 + Rust** for native platform capabilities, and **SQLite** for local storage in the installed apps. A local web mode is also available. Story branching, device sync, and the plugin system are built around this architecture. SillyTavern is not part of the application runtime.

Compatibility with the SillyTavern ecosystem lives in content formats and API adapters. These connect existing creations to TipsyIsle's own story state, prompt pipeline, and creator runtime, leaving the architecture free to evolve around AIRP's needs:

- **Shared capabilities across desktop and mobile.** A platform layer connects storage, networking, and file access. Both apps use the same core story and extension APIs, reducing the work of maintaining features across devices.
- **Dedicated handling for long conversations.** The standard message stream uses virtualized rendering. Card importing and template compilation use Web Workers, and prompt computation also has a separate Worker path, reducing heavy work on the interface thread.
- **State belongs to the story branch.** Messages, variables, and continuation state are saved around routes. Plugins can distinguish device, route, and individual reply data when building features that change with the story.
- **Explicit contracts for extensions.** TipsyIsle plugin logic runs in QuickJS inside a Web Worker, accessing capabilities through declared permissions and host APIs under execution and memory limits. Players can inspect permissions and session logs; developers can query host versions and capabilities.

This leaves room for the interface to evolve, more devices to join, and new ways to play—with explicit APIs for community creators to build on.

[Ecosystem guide](docs/ECOSYSTEM.md) · [TypeScript API](packages/plugin-sdk/index.d.ts) · [Manifest Schema](packages/plugin-sdk/manifest.schema.json) · [Plugin SDK and packaging tools](packages/plugin-sdk)

## Start your first story

For the quickest start, grab the **Windows x64 installer** or **Android ARM64 APK** from [GitHub Releases](https://github.com/Steveaaaaa/TipsyIsle/releases/latest). Android requires version 8.0 or later.

To run the local web version instead, install [Node.js](https://nodejs.org/) **22.19.0 or later** and [Git](https://git-scm.com/), then run:

```sh
git clone https://github.com/Steveaaaaa/TipsyIsle.git
cd TipsyIsle
npm ci
npm start
```

Launch the installed app or open [http://localhost:5179](http://localhost:5179) for the local web version, then follow the first-run guide. The steps below include the app's current Chinese menu labels:

1. Import a character card into the library (馆藏), along with any worldbooks and presets recommended by its author.
2. Open Settings → Persona (设置 → 个人资料) and choose your own name and identity for the story.
3. Open Settings → Model Connection (设置 → 模型连接), enter your endpoint, API key, and model, then save.
4. Pick an opening. The next line is yours.

TipsyIsle connects to a model service you provide. Whether generation works offline depends on that service. Stories and resources are stored locally; device sync runs over your local network.

<details>
<summary>Build the Windows / Android apps or the web assets yourself</summary>

- **Web assets:** `npm run build`. `npm start` builds and launches the web app, local model gateway, and compatibility service. Building static assets alone does not include these services.
- **Windows installer:** Set up the [Tauri development prerequisites](https://v2.tauri.app/start/prerequisites/), then run `npm run windows:build`. Output is placed in `releases/`.
- **Android APK:** The current script builds an ARM64 APK on Windows. Set up the Tauri / Rust Android toolchain, JDK 21, Android SDK 37, and NDK 28.2.13676358. Configure `JAVA_HOME` and `ANDROID_HOME`, supply signing settings in your local `src-tauri/gen/android/keystore.properties`, then run `npm run android:build`. Output is placed in `releases/`; the minimum Android version is 8.0 (API 26).

See the [Windows script](scripts/windows.ps1) and [Android script](scripts/android.ps1) for build details.

</details>

## There is a place for you here

TipsyIsle is still growing. How far it goes depends on the code, the experiences people bring, the creations they care enough to polish, and the honest feedback they share.

Players: tell us what breaks your immersion and what makes you want to stay. Creators: bring your compatibility needs and the ideas our APIs cannot yet express. Developers: help shape compatibility, plugins, performance, and the experience across devices. Open an [issue](https://github.com/Steveaaaaa/TipsyIsle/issues) with a concrete example, or contribute a pull request.

**Explore countless worlds. Find your harbor here.**

With thanks to SillyTavern and the AIRP community for years of creativity and exploration. See [third-party notices](docs/THIRD_PARTY_NOTICES.md) for reused code and licenses.

## License

TipsyIsle and its plugin SDK are licensed under the [Apache License 2.0](LICENSE). Third-party components retain their respective licenses; see [third-party notices](docs/THIRD_PARTY_NOTICES.md).
