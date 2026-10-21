# style-intel 0.1.0

A **read-only**, evidence-oriented CLI for investigating styles in React + CSS/SCSS projects, including monorepos with Spring Boot services. Built for **Windows 11 and PowerShell**, using Node.js directly without Bash. It also runs on macOS and Linux.

It saves developers and agents repeated source searches, while distinguishing static evidence from runtime behavior. It is **not** a CSS deletion tool, a complete React architecture engine, or a browser visual-regression system.

## Prerequisites

- **Node.js 20.19.0 or newer**. Although the CLI manifest declares Node 20+, the locked Sass Embedded dependency requires at least 20.19.0. **Node 24 LTS** is recommended; the CI matrix covers Node 20 and 24.
- **PowerShell 7** is recommended for Windows and used in CI. The examples below target PowerShell 7; Windows PowerShell 5.1 is not covered by CI.
- **Git for Windows** in `PATH` for comparisons against Git commits (`git --version`). Git is optional for `inventory`, `refs`, and `impact`. Git is required for Git-based comparisons and for the bundled test suite, whose fixtures create and inspect local repositories.
- The tool's dependencies, installed with `npm.cmd ci` as shown below. No global CLI installation or build step is needed.
- Access to the local repository you want to examine.

### Install and test — PowerShell

Install [Node.js LTS (includes npm)](https://nodejs.org/en/download), [Git for Windows](https://git-scm.com/install/windows), and [PowerShell 7](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows). PowerShell 7 uses `pwsh.exe` and installs alongside Windows PowerShell's `powershell.exe`. Open a new PowerShell 7 terminal after installation so it picks up changes to `PATH`, then check:

```powershell
$PSVersionTable.PSVersion
node --version
npm.cmd --version
git --version
```

Clone this repository into a separate, user-writable tools folder. The destination must not already exist; if you already have a checkout, skip cloning and set `$ToolHome` to its absolute path instead. Repository access may require your organization's GitHub authentication.

```powershell
$ToolHome = Join-Path $env:USERPROFILE 'DevTools\style-intel'
New-Item -ItemType Directory -Force -Path (Split-Path $ToolHome) | Out-Null
git clone 'https://github.com/AWGBrianMurdock/style-intel.git' $ToolHome
if ($LASTEXITCODE -ne 0) { throw 'Cloning style-intel failed.' }
```

Install the locked dependencies and check the tool:

```powershell
Set-Location -LiteralPath $ToolHome -ErrorAction Stop
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'style-intel tests failed.' }
$Tool = Join-Path $ToolHome 'style-intel.mjs'
node $Tool --help
```

`npm.cmd` avoids the `npm.ps1` execution-policy restriction; no policy change is needed. `npm ci` installs the versions in `package-lock.json` and replaces an existing tool `node_modules` directory. Keep optional dependencies enabled: Sass Embedded uses a platform-specific native compiler package. On macOS/Linux, use `npm ci` and `npm test` instead of `npm.cmd`.

Installation and tests write to the **tool's** folder and disposable test fixtures. Analysis never installs target dependencies, runs application package scripts, or modifies application source. Keep the tool outside the application repository. The Sass runtime tries `sass-embedded`, then an already-installed `sass` package if loading the former fails; this fallback does not bypass npm installation failures for the required `sass-embedded` dependency.

## Typical workflow

```powershell
# In a new terminal, set $Tool again to your installed script's absolute path.
$Tool = Join-Path $env:USERPROFILE 'DevTools\style-intel\style-intel.mjs'
$Repo = 'C:\awg-repos\awg-creditmaster'

# 1. Find frontend and Java build modules.
node $Tool inventory --root $Repo

# 2. Change this to the frontend folder that inventory identifies.
$Scope = 'frontend'
node $Tool refs --root $Repo --scope $Scope --selector '.customer-card'

# 3. Trace a style module's JS/TS importers toward pages and application entry points.
node $Tool impact --root $Repo --scope $Scope --file 'src/components/CustomerCard.module.scss'

# 4. Compare compiled CSS at HEAD with the local working tree.
node $Tool compare --root $Repo --scope $Scope --baseline HEAD --candidate worktree

# 5. Ask Codex or a CI job to enforce no *detected* changes (exit 2 on differences).
node $Tool verify --root $Repo --scope $Scope
$LASTEXITCODE
```

Replace the example repository, scope, selector, and file with values from your project. For Git comparisons, `$Repo` should be the Git repository's top-level directory. `$Tool` is an absolute path, so these commands work from any current directory. PowerShell treats `--selector '.foo'` as a literal argument; quote literal paths containing spaces and invoke the script with `node $Tool`. The CLI does not spawn shell wrappers or perform shell interpolation.

### Save JSON output

```powershell
$Report = Join-Path $env:TEMP 'style-intel-report.json'
node $Tool compare --root $Repo --scope $Scope --format json --limit 25 |
  Set-Content -LiteralPath $Report -Encoding utf8NoBOM -ErrorAction Stop
$Code = $LASTEXITCODE
Write-Output "Report: $Report; CLI exit code: $Code"
```

This uses PowerShell 7's UTF-8 without BOM encoding. Capture `$LASTEXITCODE` before running another native command. In a `.ps1` automation script, use `exit $Code` after handling the report to propagate the CLI result; printing the code alone does not fail the script. A fatal CLI error can leave an empty report, so check the exit code and stderr before parsing it.

By default, text output is brief. JSON limits selected evidence arrays to `--limit` (default **30**), reports full array counts under `totals`, and reports omitted items under `truncated`. Counts include all discovered evidence before formatting. Each CSS comparison includes `findingCount` and, when needed, `truncatedFindings`. Import-sequence evidence includes `beforeCount`/`afterCount` and `truncatedBefore`/`truncatedAfter`. Increase `--limit` when deeper evidence is needed. Write generated reports **outside** the target repository if you want to keep it untouched.

`refs` and `impact` also report `staticResolution: "partial"` in JSON and `Static resolution: partial` in text. This describes the method's coverage independently of `complete`, which indicates whether the supported analysis finished without warnings. A successful command does not establish exhaustive application or runtime coverage.

## Commands

### Options and path resolution

| Option | Default and interpretation |
|---|---|
| `--root PATH` | Current directory; use an absolute application repository path for repeatable commands. |
| `--scope PATH` | Whole repository (`.`); resolved relative to `--root`. |
| `--file PATH`, `--entry PATH` | Absolute paths within the repository, or paths relative to the root or scope. An existing root-relative match takes precedence; entries may exist on either comparison side. Use an unambiguous root-relative path if both interpretations exist. |
| `--load-path PATH` | No additional Sass search paths; repeatable. Relative paths resolve from `--root`, not `--scope`. |
| `--baseline`, `--candidate` | `HEAD` and `worktree`, respectively. Directory paths resolve from the terminal's current directory; use absolute paths to avoid ambiguity. An existing directory is interpreted before a Git ref of the same name. |
| `--format text\|json` | `text`; JSON includes structured evidence and completion status. |
| `--limit N` | `30`; integer from 1 to 10,000. Limits reported evidence, not analysis work. Narrow `--scope` to reduce work. |

`--entry` is repeatable and limits compiled stylesheet entries; import-sequence analysis still scans scoped JS/TS. Use `node $Tool --help` for the complete option list.

### Command overview

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
node $Tool refs --root $Repo --scope $Scope --selector '.warning' --format json
node $Tool refs --root $Repo --scope $Scope --selector '.warning' --file 'src/components/Alert.module.scss'
```

A `--file` narrows definitions and the stylesheet identity of CSS Module references; it does not restrict the consumer source files searched. Static CSS Module property and string-index accesses are reported even when the selector definition or imported stylesheet is absent. Module references include `stylesheet` and `definitionFound`; the existing `definition` field retains the stylesheet path for compatibility. A missing stylesheet also produces an unresolved-import warning and exit 3. Selector impact can trace these consumers without a matching definition.

Evidence confidence levels are `strong`, `probable`, and `possible`; unresolved dynamic class lookups are listed separately under `possibleDynamic`. HTML evidence comes from literal class attributes, including unquoted values, with comments and script/style/raw-text contents skipped. JSX module keys, unrelated attributes, and predicate strings are excluded from global-class evidence. Other exact JavaScript string literals may still be reported as `possible`, never proof of runtime class use. HTML entity decoding and full HTML error recovery are not implemented.

Relative ES imports, re-exports, TypeScript `import name = require("./module")` declarations, and string-literal `import()` calls are traversed. Resolution recognizes common emitted extensions (`.js` to `.ts`/`.tsx`, `.jsx` to `.tsx`, `.mjs` to `.mts`, `.cjs` to `.cts`), preferring an exact existing file, and includes `.mts`/`.cts` index files. Extensionless source and index lookup prefer `.ts` to `.tsx`; this fixed policy does not reproduce custom bundler resolution. CSS Module accesses retain their imported identity through parentheses, type assertions, non-null assertions, and `satisfies`, while respecting local shadowing. Missing relative script/style imports, source parse errors, computed `import()` expressions, and unsupported standalone `require()` calls produce warnings and `complete: false` (exit 3). Nonrelative packages and tsconfig aliases are not resolved. `complete` describes completion of the supported static analysis, not full application coverage; dynamic class expressions and runtime rendering remain unresolved.

Parsing SCSS works on the original syntax using `postcss-scss`. It does **not** fully expand selectors created through nesting, mixins, interpolation, or dynamic runtime composition. Indented `.sass` is supported for compilation in `compare` but is **not** mapped by `refs` in this release. CSS Module compositions, `:global`, TS path aliases and JS computed strings also have incomplete coverage. Never automatically delete styles based on zero references.

### `compare` / `verify`

```powershell
# Explicitly limit to one compiled Sass entry, relative to frontend scope.
node $Tool verify --root $Repo --scope $Scope `
  --baseline HEAD --candidate worktree `
  --entry 'src/styles/main.scss' --format json

# Compare two commits; both are reconstructed from Git (without git checkout).
node $Tool compare --root $Repo --scope $Scope `
  --baseline HEAD~1 --candidate HEAD

# Compare against a separate, already-captured copy of your ORIGINAL working tree.
# The folder must mirror the repository layout; it is not created by style-intel.
node $Tool compare --root $Repo --scope $Scope `
  --baseline 'C:\Temp\creditmaster-before' --candidate worktree

# Use explicit Sass load paths if the application's build config requires them.
node $Tool compare --root $Repo --scope $Scope `
  --load-path 'frontend/src' --load-path 'frontend/node_modules'
```

`--baseline` and `--candidate` accept `worktree`, a Git commit or ref, or a directory containing a mirror of the original repository tree. For Git refs, the tool resolves an immutable commit, streams blobs using `git cat-file --batch`, writes tracked CSS/SCSS/Sass sources across the repository and scoped JS/TS files into a **unique OS temporary directory**, and deletes that directory at the end. It does **not** change branches, stash, checkout, or reset Git files. Untracked working-tree files are included in filesystem analysis but are absent from Git snapshots.

Comparison scopes may be absent from the current worktree if a requested snapshot contains them. Automatic entry discovery includes non-partial stylesheets plus underscore-prefixed Sass files directly imported by scoped JS/TS through static imports, re-exports, import-equals declarations, or literal `import()` calls. Unimported Sass partials remain dependencies; use `--entry` to select one explicitly. Entry discovery and import-order analysis share one script read per file per side and retain only compact import data.

The comparison is order-sensitive and intentionally conservative. Treat its results as static evidence: Sass is compiled entry by entry, and the application build pipeline and browser behavior are not reproduced.

- `structurally-equal` - parsed CSS rules, declarations and at-rules have the same order and values after ignoring comments and insignificant selector spacing. Descendant combinators, quoted selector values, declaration prefixes such as `*`/`_`, duplicate declarations, and cascade-sensitive ordering are retained. This is **not** a browser test.
- `reordered` — the same canonicalized AST nodes and rule blocks appear in different order; a cascade change is possible.
- `changed` — declarations, selectors, at-rules, or entries changed.
- `error` - compilation or CSS/selector parsing could not be completed, including an added or removed entry whose existing side is malformed; the verification is **incomplete**, not a pass. Parsers are not full CSS specification validators.
- `importChanges` — JS/TS source that directly imports CSS/SCSS/Sass had its static import sequence changed, including TypeScript import-equals declarations. Such a change is treated as a *potential* CSS-order regression even if all compiled CSS ASTs are equal; this does not reproduce a bundler's complete dependency execution order.

JSON identifies the verification performed with `verification: {staticCss: true, applicationBuild: false, browser: false}`; `complete` and comparison statuses report whether that static analysis succeeded.

Even if the comparison is structurally equal, computed styles may differ because of React rendering, className expressions, routes, CSS bundling, PostCSS plugins, CSS Modules transformations, library versions, or UI state.

Sass resolves imports relative to the importing file. Additional search directories must be supplied with `--load-path`; the CLI does not implicitly add the repository root, scope, `src`, or `node_modules`. Match these arguments to the application build configuration. Project-local `--load-path` values, including absolute paths, resolve within each snapshot. Paths under `node_modules` and paths outside the repository use the current filesystem on both sides. Missing historical project imports fail verification instead of falling back to working-tree source. Compiler-reported loaded files are checked by their real paths: a historical or directory snapshot cannot load current project source through an absolute import or an external junction.

For historical Git comparisons, the current Sass compiler and current accessible `node_modules` are used on **both** sides; historical dependencies are not recreated. This isolates checked-in Sass source differences in many common cases but cannot reproduce historical production builds with dependency changes.

## Return codes

- **0** — completed successfully (`compare` may report differences without failing; `verify`/`--fail-on-diff` have stricter handling).
- **2** — `verify` or `compare --fail-on-diff` found structural CSS changes or potential CSS import-order changes.
- **3** - invalid arguments, failed required dependency, Sass compilation error, incomplete parsing, or no comparison entries. Never interpret exit 3 as no differences.

Use `$LASTEXITCODE` immediately after the CLI invocation in PowerShell. Structured JSON is emitted to stdout. Analysis warnings and per-entry failures appear in the report; fatal errors go to stderr and may prevent a JSON report from being emitted. Inspect `complete`, warnings, and comparison statuses as well as the exit code.

## Windows and operational properties

- No dependencies on POSIX tools (`grep`, `find`, `bash`, `sed`) or Unix path syntax.
- Git runs through native Node child processes, with shell execution disabled and Windows console windows hidden: no shell interpolation of user paths or Git ref names. Sass Embedded also launches its native compiler. Blob responses are consumed incrementally with binary length framing, bounded headers/diagnostics, and input backpressure. Git metadata listings are still buffered; the CLI does not bound total Sass/AST memory.
- All internal repo paths are normalized to `/` for stable JSON on Windows/Linux; filesystem access still uses OS-native paths.
- Source discovery skips built-in directories such as `.git`, `node_modules`, `dist`, `build`, `target`, `.next`, and `coverage`, plus symbolic-link files and directories. It does not read `.gitignore`. Tracked styles under ignored directories can still be materialized as Git snapshot dependencies, and Sass can load dependencies outside the discovery scope.
- Refuses `--scope` and file arguments that escape `--root` or pass through symbolic links/junctions below it; caps traversals at 100,000 files within the selected scope. Narrow `--scope` for a mixed React/Spring Boot repository.
- Git snapshots are written only to a temporary OS folder and are removed after success or failure, including failed snapshot writes and compiler disposal. The blob subprocess is terminated and awaited on stream/write failures. JSON reports are printed to stdout and are not saved automatically.

## Troubleshooting on Windows

| Symptom | What to check |
|---|---|
| `node`, `npm.cmd`, or `git` is not recognized | Reopen the terminal after installation; check that the relevant installer added its executable directory to `PATH`. |
| `npm.ps1 cannot be loaded` | Use `npm.cmd ci` or `npm.cmd test`; changing execution policy is unnecessary. |
| Script cannot be found | Set `$Tool` to the actual absolute path of `style-intel.mjs`; cloning into a custom folder requires updating the examples. |
| Dependency installation or Sass startup fails | Check Node is at least 20.19.0, run `npm.cmd ci` in the tool checkout, and keep platform optional dependencies enabled. Review npm's error before retrying; installing `sass` does not bypass a failed required dependency install. |
| `Scope directory not found` or no comparison entries | Check `$Repo` and `$Scope` against `inventory`. Comparisons need CSS/SCSS/Sass entries; select an unimported Sass partial explicitly with `--entry`. |
| Git revision cannot be resolved | Use the application's Git top-level directory as `--root` and a locally available commit/ref. A source-only folder can use `worktree` and directory comparisons without Git history. |
| Sass import cannot be found | Match the application's search paths with repeatable `--load-path` arguments, relative to `--root`. Current project files cannot fill missing historical imports. |
| Exit code 3 | Inspect stderr and report warnings/errors. It indicates incomplete analysis or invalid input, not a clean comparison. |

## Test coverage and known limits

`npm test` names the test files explicitly, so it works without shell wildcard expansion in Windows/PowerShell. The [GitHub Actions workflow](.github/workflows/test.yml) installs with `npm ci` and runs tests under PowerShell 7 (`pwsh`) on Windows and Ubuntu with Node.js 20 and 24. Hosted Windows runner tests establish automated Windows/PowerShell coverage; they do not establish manual Windows 11 installation, Windows PowerShell 5.1 compatibility, or application/browser acceptance.

The bundled `node:test` suite covers missing CSS Module definitions and stylesheets, scoped evidence, HTML/JSX false positives and source locations, React reverse imports and emitted-extension resolution, incomplete parsing/import traversal, paths containing spaces and junction rejection, binary Git stream framing and failures, snapshot cleanup, CSS formatting and meaningful changes, malformed one-sided entries, Sass resolution and historical isolation, import-order risks, directory baselines, output totals/truncation, and exit codes. Tests generate disposable local fixtures and do not require an external application.

### Suggested Codex instruction

> For CSS/SCSS investigations, consider `style-intel inventory`, `refs`, and `impact` for targeted evidence before broad source dumps. For regressions, compare CSS snapshots with `compare` or `verify`, inspect the warnings and unresolved cases, and use application builds/real browser states to verify important behavior. Do not equate zero detected differences with visual equivalence or a selector's absence from static references with safe deletion.

The tool focuses on reducing *deterministic repeated work*, leaving design and maintenance judgments to **developers**.
