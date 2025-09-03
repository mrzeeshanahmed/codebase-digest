<!--
This file is a developer-facing prompt and checklist for auditing dependencies.
It is written as a Copilot prompt plus concrete commands and checks so reviewers
or automated assistants can produce a prioritized remediation checklist.
-->

# Dependency Audit Prompt (for Copilot / maintainers)

Goal: produce a prioritized checklist to reduce runtime bundle size and remove unused dev-only transitive tooling from the extension runtime. Identify unused dependencies, large dependencies that should be replaced or made optional, and tree-shake / bundling opportunities. Also verify that `package.json` `engines.vscode` and any `peerDependencies` are consistent with extension constraints.

Instructions for Copilot (or human reviewer):

- Output a short prioritized checklist (ordered) with concrete commands, filenames, and line references when possible.
- Group findings into: Unused dependencies, Large deps to replace or make optional, Tree-shake / bundling opportunities, and Package metadata checks (engines/peerDependencies).
- For each item include: rationale, a conservative remediation plan, and a short smoke-test to validate the change.

Suggested checklist template to generate and fill in:

1) Quick inventory
   - Command(s) to run locally to reproduce the inventory:
     - npm ls --prod --depth=0
     - npm ls --all --prod --depth=0
     - pnpm why <package> (or npm explain / npm ls) for transitive ownership
   - Expected output: a plain list of top-level runtime deps and sizes.

2) Identify unused dependencies
   - Run: npx depcheck --json || npx depcheck
   - Supplement with: grep -R "require('|\"|from )<package>" src || eslint rules for unused imports
   - For each unused package listed, confirm by searching repository and tests, then propose removal and validate by running the test suite and building via webpack.

3) Large dependencies to consider replacing or making optional
   - Create a list of top candidates (from step 1) sorted by install size or by known weight (e.g., full SDKs, large AST parsers, heavy charting libraries).
   - Commands to measure bundle impact (recommended):
     - npm run compile (or pnpm -s build/watch to produce webpack bundle)
     - node --max-old-space-size=4096 ./node_modules/.bin/webpack --profile --json > stats.json
     - npx webpack-bundle-analyzer stats.json (optional visual; guard by try/catch in docs)
   - For each heavy candidate, suggest alternatives or make optional (examples):
     - Replace a heavy charting lib with simple HTML table or small chart shim used only in webview.
     - Move dev-only tools (TypeScript compiler API, linters, formatters) to devDependencies and load them dynamically via guarded require if they must be used at runtime.
   - Provide a conservative migration plan: add dynamic require wrapper, add README notes for optional adapter install, mark module as external in `webpack.config.js`.

4) Tree-shake and bundling opportunities
   - Ensure packages that support ES modules are imported using ESM syntax where possible.
   - Use `sideEffects: false` in `package.json` where safe for local modules.
   - In `webpack.config.js` mark heavy dev-only or optional modules as `externals` so they are not bundled.
   - Look for large `require(...)` usage in the codebase that forces bundling of a whole package; prefer dynamic guarded requires for optional adapters.
   - Commands and checks:
     - Search for `require('typescript')`, `require('some-large-sdk')` and verify they are guarded by try/catch + dynamic require via eval('require') pattern.
     - Inspect `webpack.config.js` `externals` and add candidates as `"module": "commonjs module"` lines.

5) Package metadata checks (engines / peerDependencies)
   - Check current values in `package.json`:
     - engines.vscode (should match the API surface your extension requires)
     - devDependency @types/vscode (should match engines.vscode major version)
   - Checklist actions:
     - If your extension uses new API introduced in a particular VS Code version, bump `engines.vscode` accordingly.
     - If you declare `peerDependencies` for host-level packages, ensure the version ranges align with `engines.vscode` constraints.
     - Add a short smoke test: run `pnpm -s test` / `npm test` and exercise the extension in the matching VS Code version via `devcontainer` or the VS Code extension tester if needed.

6) Packaging and .vscodeignore
   - Ensure optional adapters and dev-only tooling are not accidentally shipped. Entries added to `webpack.config.js` externals should also be accounted for in `.vscodeignore` when packaging the extension.

7) Deliverable checklist for maintainers (what to change and validate)
   - Remove unused packages from `package.json` and run `npm prune`.
   - Move large dev-only modules to `devDependencies` if currently in `dependencies`.
   - Add dynamic guarded require wrappers in code and add documentation in README explaining optional adapters (already present in `src/plugins/index.ts`).
   - Add modules you want excluded from production bundle to `webpack.config.js` `externals` and add a comment explaining why.
   - Rebuild and run test suite (commands below) and validate the extension in a dev VS Code window.

   Tooling note: Some tools cannot parse JSONC (comments in tsconfig.json). To accommodate them, this repository includes a pure-JSON `tsconfig.tools.json` that mirrors the compiler options used for builds. Point tooling or CI that complains about parsing to `tsconfig.tools.json` (for example via a `--project` flag) to avoid "invalidFiles" errors.

   Example: `npx depcheck --project tsconfig.tools.json` or set an environment variable in CI to reference `tsconfig.tools.json`.

Helpful commands
```
# Inventory runtime top-level deps
npm ls --prod --depth=0

# Find why a package is present
pnpm why <package>

# Detect unused deps (install depcheck locally or run npx)
npx depcheck --json

# Produce bundle stats for analysis
npm run compile
node ./node_modules/.bin/webpack --profile --json > stats.json
npx webpack-bundle-analyzer stats.json  # optional visual analysis

# Run tests and build smoke checks
pnpm -s test --silent
```

Notes for Copilot output
- Keep suggestions conservative: prefer making a dependency optional or external over replacing it wholesale.
- For each suggested change include one-liner reason, commands to apply and verify, and a risk level (low/medium/high).

---

If you want, I can now run the quick automated inventory steps (npm ls, npx depcheck, and a lightweight webpack stats generation) and propose a focused set of edits (externals updates and package.json cleanup). Reply with "run audit" to proceed.
