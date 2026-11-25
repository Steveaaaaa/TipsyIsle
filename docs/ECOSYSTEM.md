**English** | [简体中文](ECOSYSTEM.zh-CN.md)

# Make room for the next way to roleplay

TipsyIsle is a place for the community to keep creating. Characters, worldbooks, presets, reading themes, app appearances, and plugins can all change how players enter a story. Each kind of creation has its own entry point. Start with what you know, or go deeper into stories, variables, and generation through the host API.

## An independent host architecture

TipsyIsle has an independently designed application architecture, with its own story state, prompt pipeline, local storage, and plugin system. It does not depend on SillyTavern at runtime. Support for the SillyTavern ecosystem comes through content format parsing and compatibility API adapters.

When you build a TipsyIsle plugin, you target its own versioned host API. When you adapt an existing SillyTavern creation, you target the interfaces exposed by the compatibility layer. Each has its own capabilities and runtime contract. See the [README](../README.md#a-new-independent-architecture-designed-for-airp) for how the architecture shapes the player experience, and [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies and reused code.

## Find the right entry point

| Your creation | Where to start |
| --- | --- |
| Character cards, worldbooks, and presets | Import existing PNG / JSON formats. For complex creations, review their dependencies against the [compatibility guide](MIGRATING_FROM_SILLYTAVERN.md#compatibility-and-scope). |
| HTML status panels, interactive pages, and card scripts | Use the creator page runtime and adapted APIs. Verify SillyTavern-specific behavior with the actual creation. |
| Reading themes and app appearance | Adjust styles, text, artwork, component placement, and layouts for both devices in Appearance (外观), then export a `.tipsy-appearance.json` pack. |
| TipsyIsle plugins | Develop with `@tipsy-isle/plugin-sdk`, declare versions and permissions, and sign and package your work as a `.tipsy-plugin` file. |
| Adaptations of existing SillyTavern extensions | Check dependencies against the compatibility layer and manage them through SillyTavern-compatible Extensions (酒馆兼容扩展). This is a separate entry point from TipsyIsle plugins. |

## Start with working examples

The repository includes three TipsyIsle plugin examples:

- **[Story Journal](../examples/plugins/story-journal):** Records a note for the current route when a reply is saved and lets players add their own notes. Recent notes can serve as a recap for the next generation, and it optionally consumes the visual chronicle service. It demonstrates event subscriptions, route storage, settings, cross-plugin services, and prompt contributions.
- **[Action Options](../examples/plugins/action-options):** Extracts action choices from a character reply and puts the player's selected option into the input draft. The player decides when to send it. It demonstrates message commands, reply storage, and composer interaction.
- **[Lumina Director](../examples/plugins/lumina-director/README.md):** Zero-friction narrative visual director with auto visual profiling, branch-aware continuity ledgers, streaming checkpoint pre-rendering, multi-protocol image generation, and scroll-synced stage backdrops (SDK 1.2.0).

Install dependencies from the repository root, then inspect the packaging commands:

```sh
npm ci
node packages/plugin-sdk/cli.mjs --help
```

The [SDK directory](../packages/plugin-sdk) contains TypeScript types, a Manifest Schema, the packager, and a CLI. Use the [type definitions](../packages/plugin-sdk/index.d.ts) for arguments and return values, and the [Manifest Schema](../packages/plugin-sdk/manifest.schema.json) for entry points, permissions, versions, and resource declarations. Refer to CLI help for packaging arguments.

## From reading a story to taking part in it

The host API organizes capabilities into explicit domains:

| API | What it offers | Ideas to build on it |
| --- | --- | --- |
| `story` | List conversations and routes, traverse route trees, page through and search messages, and read versioned state and changes. | Story navigation, route reviews, long-story search. |
| `storage` | Store data in `device`, `route`, and `reply` scopes, with explicitly addressed reads and writes. | Local preferences, branch journals, annotations on individual replies. |
| `assets` | Read cards, worldbooks, presets, and worldbook entries; preview, commit, and undo authorized changes. | Worldbook organization, creation assistants, resource editors. |
| `beforeScan` / `afterScan` | Supply macros, prompt injections, and history adjustments around worldbook scanning. | Recaps, memory systems, custom context strategies. |
| `models` / `tasks` | Start chat, image, speech, or embedding tasks through authorized connections and read their progress and results. | Assistance from multiple models, illustrations, speech, semantic search. |
| `media` / `index` | Manage media resources and text / vector indexes. | Asset management, search, content organization. |
| Command and interface declarations | Register commands in the composer, on messages, or in the app menu. Use host-provided blocks and fields to present dialogs, sidebars, or full-screen views. | Interactive helpers and dedicated feature pages. |
| `services` | Declare versioned services and call methods exposed by other plugins. | Plugins that combine into richer experiences. |

The ideas listed here describe what the APIs can support; they do not imply that finished plugins for every use case already exist.

## Build for long stories and multiple branches

AIRP state changes with the story. A plugin should identify the conversation, route, and reply version it is handling. The host provides `StoryRef`, `MessageRef`, `RouteAddress`, and version information to express those boundaries.

Each storage scope has a purpose: `device` holds data local to the device, `route` associates data with a story route, and `reply` associates data with an individual reply candidate. Choosing the right scope keeps notes, annotations, and gameplay data attached to the relevant part of the story.

For story or resource edits, use `preview → commit → undo`. A preview describes the changes; commits and undo operations check versions; operation IDs support idempotent handling. If a player has switched routes or content has changed, a plugin can detect stale state and decide how to proceed. Pagination and addressed access let you retrieve only the parts of a long story you need.

Implementation references: [route data](../src/plugins/native/route-graph.ts), [story API](../src/plugins/native/story-data.ts), [edit transactions](../src/plugins/native/transactions.ts).

## Give players control over extension access

TipsyIsle plugin logic runs in a **QuickJS sandbox inside a Web Worker**. It interacts through host APIs and is subject to CPU time, memory, call count, and message size limits. See the [runtime protocol](../src/plugins/native/vm-protocol.ts) for the specific limits.

The manifest declares requested capabilities, host API versions, and entry points. For resource edits, model calls, and network requests, players can also choose which resources may be changed, which connections may be used, and which origins may be accessed. Plugin packages are signed; the manager shows the publisher, granted permissions, and logs for the current session.

Prompt stages and model tools use a read-only API. Data-changing capabilities are available only in the appropriate entry points. Query `host.capabilities()` to discover the current host version, platform, and features, then enable functionality for the runtime you actually have. Types, version declarations, and capability queries provide explicit ways for plugins to evolve alongside the host.

Implementation references: [plugin host](../src/plugins/native/host.ts), [QuickJS runtime](../src/plugins/native/plugin.worker.ts), [permissions interface](../src/plugins/native/PluginAccess.tsx).

## Turn your visual style into a community creation

App appearance supports text, icons, startup artwork, fonts, wallpapers, component layouts, and CSS, with separate arrangements for desktop and mobile. Hooks include `data-ti-shell`, `data-ti-part`, and `data-ti-area`, helping you target the interface regions you want to change.

While editing, you can preview both device layouts, compare with the saved appearance, undo and redo changes, and package the assets and configuration for sharing. App appearance CSS has its own scope. Card-authored HTML and interactive content run in the creator runtime, so check each separately when adapting a design.

The built-in [Fog Harbor appearance](../src/theme/appearance-sample.ts) and [appearance data model](../src/theme/appearance-model.ts) show how text, assets, and layout fit together in a complete pack.

## Help shape the APIs

If an API cannot express your idea yet, open an [issue](https://github.com/Steveaaaaa/TipsyIsle/issues). Explain what you want players to do, where you get stuck, and include a minimal example. For compatibility issues, include the creation's dependencies and runtime environment. For API proposals, describe the expected data flow, permissions, and behavior across branches where relevant.

TipsyIsle provides the foundations. The community turns them into experiences worth having. The next way to play may be the idea you have been carrying for years.
