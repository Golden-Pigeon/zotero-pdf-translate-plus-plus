# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies.
- `npm run start` — run `zotero-plugin serve` for development.
- `npm run build` — run `tsc --noEmit` and build the plugin into `build/`.
- `npm run lint` — run Prettier over the repository and ESLint with auto-fix.
- `npx tsc --noEmit` — type-check without building the plugin package.
- `npx eslint src/path/to/file.ts` — lint a single TypeScript file without formatting the whole repo.
- `npx prettier --write src/path/to/file.ts` — format a single file.

Tests: `npm run test:styles` runs the Node test runner over `scripts/scope-katex.test.mjs` (KaTeX CSS scoping). `npm test` runs `zotero-plugin test`, which launches Zotero and runs the mocha-style specs under `test/` (e.g. `test/taskNormalization.test.ts`); it needs a local Zotero install.

## Project overview

This is a TypeScript Zotero 7/8 plugin built with `zotero-plugin-scaffold`. It translates selected reader text, EPUB/webpage content, item metadata, and annotations using many provider modules; selected reader text can also be inserted into the active note with its translation.

The package entrypoint is `src/index.ts`. It initializes Zotero globals via `BasicTool`, creates the global `addon` instance, exposes it on `Zotero[package.json.config.addonInstance]`, and calls startup hooks.

`src/addon.ts` defines the central runtime object. Its `data` property holds plugin config, ztoolkit, locale/prefs window state, reader panel/popup state, and translation queue/service state. Its `hooks` and `api` properties are imported from `src/hooks.ts` and `src/api.ts`.

`src/hooks.ts` is the main dispatcher for Zotero lifecycle and UI events. `onStartup` waits for Zotero readiness, initializes locale/default prefs, and registers custom fields, reader integrations, shortcuts, notifications, preference panes, item tree columns, item pane rows, and reader tab panels. Hook methods should stay dispatch-oriented; feature work belongs in modules/utilities.

## Translation pipeline

Translation state flows through `TranslateTask` objects from `src/utils/task.ts`. Helpers there create tasks for selected text, annotations, titles, abstracts, add-to-note actions, and custom API calls; they also normalize raw text, manage concat mode, cap queue length, infer languages, attach service secrets, and sanitize logs.

`src/modules/services/base.ts` defines the `TranslateService` contract. Each service exports a `TranslateService` object with an `id`, `type` (`word` or `sentence`), optional secret/config metadata, and a `translate(data)` processor that must set `data.result` or throw.

`src/modules/services/index.ts` imports and registers all providers, sorts them for preference UI, resolves names/configuration state, and runs tasks through `TranslationServices.runTranslationTask`. Task execution handles disabled item languages, result caching, service lookup, `TranslateTaskRunner`, optional result post-processing, extra panel tasks, fallback candidate services, UI refresh, and writing successful annotation/title/abstract translations back to Zotero items.

To add or change a provider, update or create the service module under `src/modules/services/`, export a `TranslateService`, register it in `src/modules/services/index.ts`, and keep locale strings/settings aligned in `addon/locale/*` and preference UI code if user-visible labels or options change.

## UI and Zotero integration

The reader integration starts in `src/modules/reader.ts`, which registers Zotero reader event listeners. Text-selection popups are built/refreshed in `src/modules/popup.ts`; reader item-pane and standalone panels are registered/refreshed in `src/modules/tabpanel.ts`; reusable custom elements live under `src/elements/` and are loaded into Zotero windows from `src/extras/customElements.ts`.

Preferences are declared in `addon/chrome/content/preferences.xhtml`, backed by defaults in `addon/prefs.js`, initialized/migrated in `src/modules/defaultPrefs.ts`, and wired dynamically in `src/modules/preferenceWindow.ts`. Preference keys are accessed through `src/utils/prefs.ts`; service secrets are handled through `src/utils/secret.ts` and the settings dialogs under `src/modules/settings/`.

Localization uses Fluent files under `addon/locale/<locale>/`. When adding visible strings, update the relevant locale files (`addon.ftl`, `mainWindow.ftl`, `panel.ftl`, `preferences.ftl`, or `standalone.ftl`) rather than hardcoding UI text in TypeScript.

## Build configuration and assets

`zotero-plugin.config.ts` builds `src/index.ts` to `build/addon/chrome/content/scripts/<addonRef>.js` and `src/extras/*` into the same scripts directory, targeting Firefox 115. Static add-on assets are copied from `addon/**/*.*`.

`addon/` contains Zotero extension assets: `bootstrap.js`, `manifest.json`, XUL/XHTML UI files, locale files, icons, and default prefs. `typings/` contains project-specific global, localization, and preference declarations in addition to `zotero-types`.

ESLint restricts direct use of global `window`, `document`, `ZoteroPane`, and `Zotero_Tabs` in most TypeScript files. Use `Zotero.getMainWindow()`, `Zotero.getMainWindow().document`, or `Zotero.getActiveZoteroPane()` as appropriate; `src/elements/*.ts` is the exception for direct `window`/`document` access.
