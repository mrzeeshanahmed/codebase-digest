# codebase-digest README

Codebase Digest is a production-grade VS Code extension for generating LLM-ready codebase digests with advanced filtering, output, and analysis features.

## Features

### Key Features

- **Output Modes**: Supports `markdown`, `text`, and `json` output formats. Use the compatible preset for cross-tool-friendly formatting.
- **Compatible Preset Option**: Enable `codebaseDigest.outputPresetCompatible` for tree-first, header-delimited output with `==== <relPath> (<size>, <modified>) ====` and `\n---\n` separators. No code fences in text mode.
- **Remote Ingest Metadata Summary**: When ingesting remote repos, digests include repository, branch/tag/commit, SHA, and subpath metadata at the top.
- **Submodules Support**: Toggle `codebaseDigest.includeSubmodules` to include git submodules during remote ingestion.
- **Dashboard & Charts**: Interactive dashboard webview with file tree selection, live digest preview, and visual charts (language breakdown, file size distribution).
- **Quick Toggles**: Instantly switch output format, compatible preset, submodules, and notebook outputs from the Preview node actions.
- **Optional Token Plugin**: Add a tiktoken adapter for advanced token estimation (see plugins/index.ts for stub registration).
- **Notebook Non-Text Outputs**: Enable `codebaseDigest.notebookIncludeNonTextOutputs` to include images and HTML outputs as base64 blocks (configurable max size).
- **Hierarchical .gitignore support**: Closest rules override, matching real Git behavior.
- **Include-overrides-exclude logic**: Deterministic pattern matching; includes always win over excludes.
- **Streaming reads for large files**: Efficiently processes huge files without memory spikes.
- **Progressive file writes and cancellation**: Output is written incrementally; cancel generation at any time for safety.
- **Binary file handling policies**: Choose to skip, include a placeholder, or embed base64 (with markdown fencing for digest output).
- **Token estimation**: Fast, model-aware token counting with k/M suffix formatting and context-limit warnings.
- **Minimal selected-tree preview in sidebar Dashboard**: See a boxed ASCII preview of your selection before generating.
- **Tree rendering parity**: Sidebar preview and final output use identical ASCII tree logic for consistency.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings


This extension contributes the following settings:

- `codebaseDigest.outputFormat`: Output format (`markdown`, `text`, `json`).
- `codebaseDigest.outputPresetCompatible`: Enable cross-tool-friendly output preset.
- `codebaseDigest.includeSubmodules`: Include git submodules during remote ingestion.
- `codebaseDigest.notebookIncludeNonTextOutputs`: Include non-text notebook outputs as base64 blocks.
- `codebaseDigest.notebookNonTextOutputMaxBytes`: Max bytes for notebook non-text outputs.
- `codebaseDigest.includeTree`, `codebaseDigest.includeSummary`, `codebaseDigest.includeFileContents`, `codebaseDigest.includeMetadata`: Control digest sections.
- `codebaseDigest.excludePatterns`, `codebaseDigest.includePatterns`, `codebaseDigest.filterPresets`: Advanced file filtering.
- `codebaseDigest.cache.enabled`, `codebaseDigest.cache.dir`: Enable and configure digest caching.
- `codebaseDigest.openDashboardOnActivate`: Automatically reveal the dashboard panel when the extension activates (default: `true`).
- `codebaseDigest.outputHeaderTemplate`: Template used for per-file headers in `markdown`/`text` outputs. Defaults to `==== <relPath> (<size>, <modified>) ====`. Supported tokens: `<relPath>`, `<size>`, `<modified>`.

### Quick examples for `outputHeaderTemplate`

The header template controls how each file section is labeled in `markdown` and `text` outputs. It is independent from the inter-section separator (`codebaseDigest.outputSeparatorsHeader`, default `"\n---\n"`).

- Default:

```
==== <relPath> (<size>, <modified>) ====
```

- Minimal header (just path):

```
<relPath>
```

- Path with modified time only:

```
<relPath> (modified: <modified>)
```

When `codebaseDigest.outputPresetCompatible` is enabled, the digest output will appear as:

1. Summary (if enabled)
2. ASCII tree (if `includeTree` is enabled)
3. File sections, each starting with a header rendered from `codebaseDigest.outputHeaderTemplate` and followed by the file contents or placeholder

This makes preview and generated outputs consistent and easy to parse programmatically.
### Enabling Compatible Preset and Text Mode

1. Open the Preview node in the sidebar.
2. Use quick actions to set output format (`Markdown`, `Text`, `JSON`) and toggle the compatible preset.
3. Compatible preset ensures tree-first, header-delimited output for easy parsing.

### Remote Ingest Metadata

When generating a digest from a remote repo, the output includes:

```
# Remote Source
Repository: <owner/repo>
Ref: <branch|tag|commit> => <sha>
Subpath: <subpath or '-'>
```

### Submodules

Toggle submodule inclusion from the Preview node or set `codebaseDigest.includeSubmodules` in settings.

### Dashboard & Charts

Open the dashboard from the command palette or Preview node for:
- File tree selection with checkboxes
- Live digest preview
- Visual charts (language breakdown, file size distribution)

Quick ways to open the dashboard
-------------------------------

- Command Palette: run `Codebase Digest: Open Dashboard Panel`.
- Status bar: click the left-side status bar item labeled "Codebase Digest".
- Welcome node: when the tree shows the welcome/empty state, click the welcome entry to open the dashboard for the current workspace.

## Sidebar-first UX and redaction controls

We now prefer the Primary Sidebar as the authoritative dashboard location. This keeps the UI focused and avoids creating editor tabs unless you explicitly open the dashboard as a panel.

- Find the Primary Sidebar view:
	- Open the Activity Bar (left side of VS Code) and look for the "Codebase Digest" view. If a dedicated Activity Bar container is provided it will appear as its own icon; otherwise it appears under Explorer.
	- Run the Command Palette command: `Codebase Digest: Focus View` to bring the Primary Sidebar dashboard to the foreground.

- Open as panel (optional pop-out):
	- Use the Command Palette entry `Codebase Digest: Open as Panel` to create a WebviewPanel in the editor area when you need a larger canvas. The panel is created only when requested.

- Redaction controls (safety):
	- Settings exposed:
		- `codebaseDigest.showRedacted` — when true, digest output is not masked (default: false).
		- `codebaseDigest.redactionPatterns` — an array or comma/newline-separated list of regex patterns used to mask sensitive-looking strings.
		- `codebaseDigest.redactionPlaceholder` — text used to replace matches (default: `[REDACTED]`).
	- In the dashboard Settings UI you can toggle "Show redacted" and edit patterns/placeholder. Saving writes these to the workspace settings and subsequent generations will respect them.
	- One-shot override: the dashboard toolbar includes a "Disable redaction for this run" toggle that temporarily shows raw values for the next generation only; it does not persist to your workspace settings.

	#### One-shot "No Redact" override (safety note)

	The dashboard toolbar exposes a transient "Disable redaction for this run" toggle. Behavior:

	- It's transient: the toggle only affects the next single Generate action and is automatically cleared immediately after the generate command is sent from the webview.
	- It does not persist to workspace settings and cannot be used to change `codebaseDigest.showRedacted` permanently.
	- The webview sends a one-shot override payload { overrides: { showRedacted: true } } to the extension when the toggle is active. The extension treats this as a runtime-only override when constructing the effective configuration for that generation.

	This design keeps redaction safe by requiring an explicit user action per run; no settings are mutated as a side-effect of generation.

Notes:

- The extension no longer auto-opens an editor tab on activation by default; the Primary Sidebar view is the recommended entry point. If you prefer the panel, use the explicit "Open as Panel" command.
- Generation results include metadata `redactionApplied` indicating whether masking occurred; the dashboard shows a small, non-blocking toast when content was masked so you can quickly adjust settings and re-run if needed.

### Notebook Non-Text Outputs

Enable `codebaseDigest.notebookIncludeNonTextOutputs` to include images and HTML outputs as base64 blocks in the digest. Configure max size with `codebaseDigest.notebookNonTextOutputMaxBytes`.

### Tokenizer Adapter (tiktoken)

For advanced token estimation, you can install the optional tiktoken adapter:

```sh
npm install optional-tiktoken-adapter
```

Then, set `codebaseDigest.tokenModel` to `tiktoken` in your settings. If the adapter is present, token estimates will use tiktoken logic; otherwise, the extension will fall back to character-based estimation.

**Example:**

- Open settings and set:
	- `codebaseDigest.tokenModel`: `tiktoken`

**Testing:**

- Run the extension with and without the adapter installed to verify token estimates change accordingly.

Notes on behavior and UI model names
-----------------------------------

- Optional adapter precedence: if a tiktoken-compatible adapter (for example `optional-tiktoken-adapter`) is installed and successfully loaded at runtime, the extension will use that adapter for the `tiktoken` tokenModel. If no adapter is available the extension falls back to the built-in heuristic estimator (see `TokenAnalyzer`), so the adapter is strictly optional and never becomes a hard dependency.
- UI model name mapping: model names surfaced in the UI (for example `gpt-4o`, `gpt-3.5`, `gpt-4o-mini`, etc.) are mapped to conservative heuristic divisors inside `TokenAnalyzer` when no adapter is present. In practice this means selecting `gpt-4o` or `gpt-3.5` will produce a consistent heuristic estimate (not an adapter-backed tiktoken result) unless you explicitly choose the `tiktoken` model and have installed an adapter.

This keeps the extension lightweight by default while enabling higher-fidelity estimates when users opt in to install an adapter.

### Bundling, optional adapters, and auditing dependencies

This project intentionally keeps optional adapters and developer tooling out of the runtime bundle. A few guidelines:

- Webpack externals: `webpack.config.js` marks Node builtins (e.g. `fs`, `path`) and dev-only tooling (for example `typescript`) as externals so they are not bundled into the extension runtime. If you add new optional adapters that should not be bundled, add them to the `externals` list.
- Dynamic / guarded requires: Optional adapters (for example the `optional-tiktoken-adapter`) are loaded using a dynamic require inside a try/catch so the extension works if the adapter isn't installed. Example pattern used in `src/plugins/index.ts`:

```js
// hide from webpack static analysis and guard with try/catch
try {
	const dynamicRequire = eval('require');
	const adapter = dynamicRequire('optional-tiktoken-adapter');
	// register adapter
} catch (e) {
	// adapter not installed — fall back safely
}
```

- Runtime vs dev dependencies: Prefer keeping heavy developer tools (TypeScript API, large AST parsers, or CLI-formatters) as devDependencies and load them dynamically only when available. This keeps the production extension small and reduces install size.
- Avoid heavy UI frameworks: The webview content uses minimal vanilla JS/CSS to maximize compatibility and keep the bundle light. If you need richer UI components, prefer optional adapters or remote loading guarded by feature flags.

If you'd like, I can run an automated scan for imported modules that are safe to mark as externals or suggest a minimal .vscodeignore update to avoid shipping optional adapters in the extension package.

### Quick Toggles

Preview node actions let you instantly toggle output format, compatible preset, submodules, and notebook outputs.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**

## Remote ingest temporary directory lifecycle

When performing a programmatic remote ingest (for example via the `codebaseDigest.ingestRemoteRepoProgrammatic` command), the extension clones the repository into a temporary directory and scans files from that location.

- By default the temporary directory is cleaned up before the command returns. The returned `output` and `preview` payloads contain concatenated content produced in-memory — callers should not rely on the temp directory remaining on disk.
- If you need to retain the clone for manual inspection or further processing, pass the optional `keepTmpDir: true` parameter to `ingestRemoteRepoProgrammatic`. When `keepTmpDir` is set, the command will return the temporary path as `localPath` and will NOT delete it; you become responsible for calling `githubService.cleanup(localPath)` when finished.

This behavior avoids leaking sensitive temp files by default while providing an opt-in path for debugging or manual workflows.
