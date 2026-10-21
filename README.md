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

If PowerShell blocks the `npm.ps1` shim under its execution policy, use `npm.cmd install` and `npm.cmd test`. No policy change is needed.

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

By default, text output is brief. JSON limits selected evidence arrays to `--limit` (default **30**), reports full array counts under `totals`, and reports omitted items under `truncated`. Counts include all discovered evidence before formatting. Each CSS comparison includes `findingCount` and, when needed, `truncatedFindings`. Import-sequence evidence includes `beforeCount`/`afterCount` and `truncatedBefore`/`truncatedAfter`. Increase `--limit` when deeper evidence is needed. Write generated reports **outside** the target repository if you want to keep it untouched.

`refs` and `impact` also report `staticResolution: "partial"` in JSON and `Static resolution: partial` in text. This describes the method's coverage independently of `complete`, which indicates whether the supported analysis finished without warnings. A successful command does not establish exhaustive application or runtime coverage.

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

A `--file` narrows definitions and the stylesheet identity of CSS Module references; it does not restrict the consumer source files searched. Static CSS Module property and string-index accesses are reported even when the selector definition or imported stylesheet is absent. Module references include `stylesheet` and `definitionFound`; the existing `definition` field retains the stylesheet path for compatibility. A missing stylesheet also produces an unresolved-import warning and exit 3. Selector impact can trace these consumers without a matching definition.

Evidence confidence levels are `strong`, `probable`, and `possible`; unresolved dynamic class lookups are listed separately under `possibleDynamic`. HTML evidence comes from literal class attributes, including unquoted values, with comments and script/style/raw-text contents skipped. JSX module keys, unrelated attributes, and predicate strings are excluded from global-class evidence. Other exact JavaScript string literals may still be reported as `possible`, never proof of runtime class use. HTML entity decoding and full HTML error recovery are not implemented.

Relative ES imports, re-exports, TypeScript `import name = require("./module")` declarations, and string-literal `import()` calls are traversed. Resolution recognizes common emitted extensions (`.js` to `.ts`/`.tsx`, `.jsx` to `.tsx`, `.mjs` to `.mts`, `.cjs` to `.cts`), preferring an exact existing file, and includes `.mts`/`.cts` index files. Extensionless source and index lookup prefer `.ts` to `.tsx`; this fixed policy does not reproduce custom bundler resolution. CSS Module accesses retain their imported identity through parentheses, type assertions, non-null assertions, and `satisfies`, while respecting local shadowing. Missing relative script/style imports, source parse errors, computed `import()` expressions, and unsupported standalone `require()` calls produce warnings and `complete: false` (exit 3). Nonrelative packages and tsconfig aliases are not resolved. `complete` describes completion of the supported static analysis, not full application coverage; dynamic class expressions and runtime rendering remain unresolved.

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

`--baseline` and `--candidate` accept `worktree`, an immutable Git commit or ref, or a directory containing a mirror of the original repository tree. For Git refs, the tool resolves the commit, streams blobs using `git cat-file --batch`, writes CSS/SCSS and scoped JS/TS files into a **unique OS temporary directory**, and deletes that directory at the end. It does **not** change branches, stash, checkout, or reset Git files.

Comparison scopes may be absent from the current worktree if a requested snapshot contains them. Automatic entry discovery includes non-partial stylesheets plus underscore-prefixed Sass files directly imported by scoped JS/TS through static imports, re-exports, import-equals declarations, or literal `import()` calls. Unimported Sass partials remain dependencies; use `--entry` to select one explicitly. Entry discovery and import-order analysis share one script read per file per side and retain only compact import data.

The comparison is order-sensitive and intentionally conservative. Treat its results as static evidence: Sass is compiled entry by entry, and the application build pipeline and browser behavior are not reproduced.

- `structurally-equal` - parsed CSS rules, declarations and at-rules have the same order and values after ignoring comments and insignificant selector spacing. Descendant combinators, quoted selector values, declaration prefixes such as `*`/`_`, duplicate declarations, and cascade-sensitive ordering are retained. This is **not** a browser test.
- `reordered` — the same canonicalized AST nodes and rule blocks appear in different order; a cascade change is possible.
- `changed` — declarations, selectors, at-rules, or entries changed.
- `error` - compilation or CSS/selector parsing could not be completed, including an added or removed entry whose existing side is malformed; the verification is **incomplete**, not a pass. Parsers are not full CSS specification validators.
- `importChanges` — React/JS source that directly imports CSS/SCSS/Sass had its ES import sequence changed. Such a change is treated as a *potential* CSS-order regression even if all compiled CSS ASTs are equal.

JSON identifies the verification performed with `verification: {staticCss: true, applicationBuild: false, browser: false}`; `complete` and comparison statuses report whether that static analysis succeeded.

Even if the comparison is structurally equal, computed styles may differ because of React rendering, className expressions, routes, CSS bundling, PostCSS plugins, CSS Modules transformations, library versions, or UI state.

Sass resolves imports relative to the importing file. Additional search directories must be supplied with `--load-path`; the CLI does not implicitly add the repository root, scope, `src`, or `node_modules`. Match these arguments to the application build configuration. Project-local `--load-path` values, including absolute paths, resolve within each snapshot. Paths under `node_modules` and paths outside the repository use the current filesystem on both sides. Missing historical project imports fail verification instead of falling back to working-tree source. Compiler-reported loaded files are checked by their real paths: a historical or directory snapshot cannot load current project source through an absolute import or an external junction.

For historical Git comparisons, the current Sass compiler and current accessible `node_modules` are used on **both** sides; historical dependencies are not recreated. This isolates checked-in Sass source differences in many common cases but cannot reproduce historical production builds with dependency changes.

## Return codes

- **0** — completed successfully (`compare` may report differences without failing; `verify`/`--fail-on-diff` have stricter handling).
- **2** — `verify` or `compare --fail-on-diff` found structural CSS changes or potential CSS import-order changes.
- **3** - invalid arguments, failed required dependency, Sass compilation error, incomplete parsing, or no comparison entries. Never interpret exit 3 as no differences.

Use `$LASTEXITCODE` immediately after the CLI invocation in PowerShell. Structured JSON is emitted to stdout; errors go to stderr.

## Windows and operational properties

- No dependencies on POSIX tools (`grep`, `find`, `bash`, `sed`) or Unix path syntax.
- Native Node child processes for Git commands, with shell execution disabled and Windows console windows hidden: no shell interpolation of user paths or Git ref names. Blob responses are consumed incrementally with binary length framing, bounded headers/diagnostics, and input backpressure. Git metadata listings are still buffered; the CLI does not bound total Sass/AST memory.
- All internal repo paths are normalized to `/` for stable JSON on Windows/Linux; filesystem access still uses OS-native paths.
- Skips directories such as `.git`, `node_modules`, `dist`, `build`, `target`, `.next`, `coverage`, and symbolic-link directories.
- Refuses `--scope` and file arguments that escape `--root` or pass through symbolic links/junctions below it; caps traversals at 100,000 files within the selected scope. Narrow `--scope` for a mixed React/Spring Boot repository.
- Git snapshots are written only to a temporary OS folder and are removed after success or failure, including failed snapshot writes and compiler disposal. The blob subprocess is terminated and awaited on stream/write failures. JSON reports are streamed to stdout and are not saved automatically.

## Test coverage and known limits

The bundled `node:test` suite covers missing CSS Module definitions and stylesheets, scoped evidence, HTML/JSX false positives and source locations, React reverse imports and emitted-extension resolution, incomplete parsing/import traversal, paths containing spaces and junction rejection, binary Git stream framing and failures, snapshot cleanup, CSS formatting and meaningful changes, malformed one-sided entries, Sass resolution and historical isolation, import-order risks, directory baselines, output totals/truncation, and exit codes. Tests generate disposable local fixtures and do not require an external application.

### Suggested Codex instruction

> For CSS/SCSS investigations, consider `style-intel inventory`, `refs`, and `impact` for targeted evidence before broad source dumps. For regressions, compare CSS snapshots with `compare` or `verify`, inspect the warnings and unresolved cases, and use application builds/real browser states to verify important behavior. Do not equate zero detected differences with visual equivalence or a selector's absence from static references with safe deletion.

The tool focuses on reducing *deterministic repeated work*, leaving design and maintenance judgments to **developers**.
