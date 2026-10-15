# style-intel 0.1.0

A **read-only**, evidence-oriented CLI for investigating styles in React + CSS/SCSS projects, including monorepos with Spring Boot services. Built for **Windows 11 and PowerShell** (uses Node.js directly, not Bash). It should also work on macOS and Linux if anyone were to ever care.

It aims to save developers (and agents...) repeated source searches, with honest distinctions between static evidence and runtime behavior. It is **not** a CSS deletion tool, a complete React architecture engine, or a browser visual-regression system.

## Prerequisites

- **Node.js 20+** (`node --version`; Node 22 LTS or later is a good choice).
- **Git for Windows** in `PATH` for comparisons against Git commits (`git --version`). Git is optional for `inventory`, `refs`, and `impact`. Git is required for Git-based comparisons and for the bundled test suite, whose fixtures create and inspect local repositories.
- `npm install` in this tool's directory, to install PostCSS, the SCSS/selector parsers, TypeScript, and native Sass Embedded.
- Access to the local repository you want to examine.

### Install and test — PowerShell

Install to a separate tools directory (for example, `C:\DevTools\style-intel`, but keep in mind this is illustrative) and run:

```powershell
Set-Location 'C:\DevTools\style-intel'
npm install
npm test
node .\style-intel.mjs --help
```

The script itself **does not** run `npm install` or any package scripts, and never modifies project source. `npm install` above writes to the **tool's** folder, so placing it outside your application repo keeps the repo clean.

If `sass-embedded` cannot be installed in your environment, you can use `sass` instead: install `sass` in the tool directory. The `compare` command attempts `sass-embedded` first and `sass` second. The parser and TypeScript packages are still required.

## Typical workflow

```powershell
$Repo = 'C:\awg-repos\awg-creditmaster'

# 1. Find frontend and Java build modules.
node .\style-intel.mjs inventory --root $Repo

# 2. Set scope to the frontend folder that inventory identifies.
#    Change 'frontend' to the ACTUAL directory in your repository.
node .\style-intel.mjs refs --root $Repo --scope frontend --selector '.customer-card'

# 3. Trace a style module's JS/TS importers toward pages and application entry points.
node .\style-intel.mjs impact --root $Repo --scope frontend --file 'src/components/CustomerCard.module.scss'

# 4. Compare compiled CSS at HEAD with the local working tree.
node .\style-intel.mjs compare --root $Repo --scope frontend --baseline HEAD --candidate worktree

# 5. Ask Codex or a CI job to enforce no *detected* changes (exit 2 on differences).
node .\style-intel.mjs verify --root $Repo --scope frontend
$LASTEXITCODE
```

PowerShell treats `--selector '.foo'` as an argument containing a literal class name. Paths with spaces are supported when quoted; use `node .\style-intel.mjs` instead of invoking an `.mjs` file as a PowerShell script. No `cmd.exe`, `powershell.exe`, shell wrapper, or command substitution is spawned by the CLI.

### JSON output designed for Agents (Codex, Gemini, or a weird human who just loves reading JSON...)

```powershell
node .\style-intel.mjs compare --root $Repo --scope frontend --format json --limit 25 `
  | Set-Content -Encoding utf8 'C:\Temp\style-intel-report.json'
```

By default, text output is brief. JSON limits selected evidence arrays to `--limit` (default **30**) and reports items omitted by that limit under `truncated`. Aggregate counts are not limited; the inventory project list is capped at 200 entries before formatting. Increase `--limit` when deeper evidence is needed. Write generated reports **outside** the target repository if you want to keep it untouched.

## Commands

| Command | What it does | What it does *not* prove |
|---|---|---|
| `inventory` | Reports source counts; identifies `package.json`, React dependencies and Java build manifests | How components integrate at runtime |
| `refs --selector .foo` | Finds CSS/SCSS class definitions and probable TSX/JSX/HTML consumers; understands static CSS Module imports | That a class is truly unused or always rendered |
| `impact --file path` | Computes reverse relative JS/TS module imports; reports possible pages/routes | That a component is rendered, or styles take effect |
| `impact --selector .foo` | Starts from probable selector consumers and walks reverse imports | That the full runtime impact is known |
| `compare` | Compiles Sass on two sides; compares CSS ASTs **in order**; checks CSS-containing JS/TS import sequences | Browser visual/computed-style equivalence |
| `verify` | Same as `compare`, but nonzero when detectable differences remain | Safe removal, full behavioral correctness, or accessible UI |

### `refs`

```powershell
node .\style-intel.mjs refs --root $Repo --scope frontend --selector '.warning' --format json
node .\style-intel.mjs refs --root $Repo --scope frontend --selector '.warning' --file 'src/components/Alert.module.scss'
```

A `--file` narrows **definitions**, not the source files searched for references. This lets you distinguish the same CSS class in different CSS Modules. Evidence confidence levels are `strong`, `probable`, and `possible`; unresolved dynamic lookups are listed separately under `possibleDynamic`.

Parsing SCSS works on the original syntax using `postcss-scss`. It does **not** fully expand selectors created through nesting, mixins, interpolation, or dynamic runtime composition. Indented `.sass` is supported for compilation in `compare` but is **not** mapped by `refs` in this release. CSS Module compositions, `:global`, TS path aliases and JS computed strings also have incomplete coverage. Never automatically delete styles based on zero references.

### `compare` / `verify`

```powershell
# Explicitly limit to one compiled Sass entry, relative to frontend scope.
node .\style-intel.mjs verify --root $Repo --scope frontend `
  --baseline HEAD --candidate worktree `
  --entry 'src/styles/main.scss' --format json

# Compare two commits; both are reconstructed from Git (without git checkout).
node .\style-intel.mjs compare --root $Repo --scope frontend `
  --baseline HEAD~1 --candidate HEAD

# Compare against a separate, already-captured copy of your ORIGINAL working tree.
# The folder must mirror the repository layout; it is not created by style-intel.
node .\style-intel.mjs compare --root $Repo --scope frontend `
  --baseline 'C:\Temp\creditmaster-before' --candidate worktree

# Use explicit Sass load paths if the application's build config requires them.
node .\style-intel.mjs compare --root $Repo --scope frontend `
  --load-path 'frontend/src' --load-path 'frontend/node_modules'
```

`--baseline` and `--candidate` accept `worktree`, an immutable Git commit or ref, or a directory containing a mirror of the original repository tree. For Git refs, the tool resolves the commit, reads blobs using `git cat-file --batch`, writes CSS/SCSS and scoped JS/TS files into a **unique OS temporary directory**, and deletes that directory at the end. It does **not** change branches, stash, checkout, or reset Git files.

The comparison is order-sensitive and intentionally conservative. Treat its results as static evidence: Sass is compiled entry by entry, and the application build pipeline and browser behavior are not reproduced.

- `structurally-equal` — parsed CSS rules, declarations and at-rules have the same order and values after ignoring comments/formatting. This is **not** a browser test.
- `reordered` — the same canonicalized AST nodes and rule blocks appear in different order; a cascade change is possible.
- `changed` — declarations, selectors, at-rules, or entries changed.
- `error` — compilation or CSS parsing could not be completed; the verification is **incomplete**, not a pass.
- `importChanges` — React/JS source that directly imports CSS/SCSS/Sass had its ES import sequence changed. Such a change is treated as a *potential* CSS-order regression even if all compiled CSS ASTs are equal.

Even if the comparison is structurally equal, computed styles may differ because of React rendering, className expressions, routes, CSS bundling, PostCSS plugins, CSS Modules transformations, library versions, or UI state.

For historical Git comparisons, the current Sass compiler and current accessible `node_modules` are used on **both** sides; historical dependencies are not recreated. This isolates checked-in Sass source differences in many common cases but cannot reproduce historical production builds with dependency changes.

## Return codes

- **0** — completed successfully (`compare` may report differences without failing; `verify`/`--fail-on-diff` have stricter handling).
- **2** — `verify` or `compare --fail-on-diff` found structural CSS changes or potential CSS import-order changes.
- **3** - invalid arguments, failed required dependency, Sass compilation error, incomplete parsing, or no comparison entries. Never interpret exit 3 as no differences.

Use `$LASTEXITCODE` immediately after the CLI invocation in PowerShell. Structured JSON is emitted to stdout; errors go to stderr.

## Windows and operational properties

- No dependencies on POSIX tools (`grep`, `find`, `bash`, `sed`) or Unix path syntax.
- Native `spawnSync('git', [...], {shell: false, windowsHide:true})` for Git commands: no shell interpolation of user paths or Git ref names.
- All internal repo paths are normalized to `/` for stable JSON on Windows/Linux; filesystem access still uses OS-native paths.
- Skips directories such as `.git`, `node_modules`, `dist`, `build`, `target`, `.next`, `coverage`, and symbolic-link directories.
- Refuses `--scope` and file arguments that escape `--root`; caps traversals at 100,000 files. Narrow `--scope` for a mixed React/Spring Boot repository.
- Git snapshots are written only to a temporary OS folder and are removed after the command finishes. JSON reports are streamed to stdout and are not saved automatically.

## Test coverage and known limits

The bundled `node:test` suite covers CSS and CSS Module references, React reverse-import analysis, paths containing spaces, Git snapshots, format-only CSS changes, declaration differences, ordering changes, import-order risks, directory baselines, output limiting, missing dependencies, and error cases.

### Suggested Codex instruction

> For CSS/SCSS investigations, consider `style-intel inventory`, `refs`, and `impact` for targeted evidence before broad source dumps. For regressions, compare CSS snapshots with `compare` or `verify`, inspect the warnings and unresolved cases, and use application builds/real browser states to verify important behavior. Do not equate zero detected differences with visual equivalence or a selector's absence from static references with safe deletion.

The tool focuses on reducing *deterministic repeated work*, leaving design and maintenance judgments to **developers**.