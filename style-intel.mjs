#!/usr/bin/env node
/**
 * style-intel: read-only, evidence-oriented CSS/SCSS intelligence for React repositories.
 * Node >=20; intended for Windows 11/PowerShell, also works on macOS/Linux.
 * All project paths are internally normalized; no shell commands or repo writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VERSION = '0.1.0';
const STYLE_EXT = /\.(?:css|scss|sass)$/i;
const MAIN_STYLE_EXT = /\.(?:css|scss|sass)$/i;
const SCRIPT_EXT = /\.(?:tsx|jsx|ts|js|mjs|cjs)$/i;
const DEFAULT_IGNORES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next',
  '.angular', '.turbo', '.cache', '.gradle', '.idea', '.venv', 'vendor',
  'storybook-static', '.output', '.parcel-cache', '.pnpm-store',
]);
const MAX_FILES = 100_000;
let tsModule, postcssModule, selectorModule, scssModule;
const posix = p => p.split(path.sep).join('/');
const sort = values => [...values].sort((a, b) => a.localeCompare(b, 'en'));
function relative(root, abs) { return posix(path.relative(root, abs)); }
function slash(s) { return String(s).replaceAll('\\', '/'); }
function ensureUnder(root, full) {
  const r = path.resolve(root), p = path.resolve(full);
  const rr = process.platform === 'win32' ? r.toLowerCase() : r;
  const pp = process.platform === 'win32' ? p.toLowerCase() : p;
  if (pp !== rr && !pp.startsWith(rr + path.sep)) throw new Error(`Path is outside --root: ${full}`);
  // Reject symlinks and junctions below root, including intermediate components.
  // This also protects paths whose final file does not exist.
  let current=r;
  for (const part of path.relative(r,p).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    if (fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())
      throw new Error(`Symbolic link paths are unsupported beneath --root: ${full}`);
  }
  return p;
}
function asRepoPath(root, scope, input) {
  // Accept root-relative, scope-relative, and absolute paths. Prefer existing paths.
  const s = slash(input);
  if (path.isAbsolute(input) || /^[A-Za-z]:\//.test(s)) return relative(root, ensureUnder(root, input));
  const possible = [path.resolve(root,input),path.resolve(scope,input)].filter(p=>{
    try { ensureUnder(root,p); return true; } catch { return false; }
  });
  if (!possible.length) throw new Error(`Path is outside --root: ${input}`);
  const found=possible.find(p=>fs.existsSync(p));
  return relative(root, found || possible[possible.length-1]);
}
function pushUnique(arr, val) { if (!arr.includes(val)) arr.push(val); }
function required(id, hint) {
  try { return require(id); } catch (error) {
    throw new Error(`${id} is required for this command. Run npm install in the style-intel directory. ${hint || ''}`.trim(), {cause:error});
  }
}
function postcss() { return postcssModule ??= required('postcss'); }
function ts() { return tsModule ??= required('typescript'); }
function selectorParser() { return selectorModule ??= required('postcss-selector-parser'); }
function postcssScss() { return scssModule ??= required('postcss-scss'); }
function mainHelp() {
  return `style-intel ${VERSION} — read-only React / CSS / Sass analysis

Usage: node style-intel.mjs <command> [options]

Commands:
  inventory             Detect frontend projects, services, styles, and source counts
  refs --selector .name  Find class definitions and probable React/HTML consumers
  impact --file PATH     Explore reverse JS/TS imports and likely affected routes
  impact --selector .x   Explore consumer imports for a CSS class
  compare                Compare compiled CSS snapshots, HEAD vs worktree by default
  verify                 Same comparison; exit nonzero on detected differences

Common options:
  --root PATH            Repository root (default current directory)
  --scope PATH           Subtree to analyze, relative to root (default whole repository)
  --format text|json     Structured or concise output (default text)
  --limit N              Maximum findings/locations to print (default 30)

Command-specific options:
  --selector .name       Exact CSS class (leading dot optional)
  --file PATH            Style/source file relative to --root or --scope
  --entry PATH           Compile/compare only this entry (repeatable)
  --baseline REF|worktree|DIR  Git revision, worktree, or snapshot folder (default HEAD)
  --candidate REF|worktree|DIR  Git revision, worktree, or snapshot folder (default worktree)
  --load-path PATH       Additional Sass import search directory (repeatable)
  --fail-on-diff         compare: exit code 2 on detected change
  --help                 Show this help

Exit codes: 0 success, 2 detected differences (verify/--fail-on-diff),
            3 incomplete verification or invalid arguments/tool errors.

Notes: Does NOT modify project files, install dependencies, execute app scripts,
render pages, or guarantee browser/cascade equivalence. Git snapshots use OS temp.
`;
}
function parseArgs(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return {help:true};
  const command = argv[0];
  const accepted = new Set(['inventory','refs','impact','compare','verify']);
  if (!accepted.has(command)) throw new Error(`Unknown command: ${command}`);
  const opts = {command, root:process.cwd(), scope:'.', format:'text', limit:30,
    baseline:'HEAD', candidate:'worktree', entries:[], loadPaths:[], failOnDiff:false};
  for (let i=1; i<argv.length; i++) {
    const raw = argv[i];
    if (raw === '--fail-on-diff') { opts.failOnDiff = true; continue; }
    const at = raw.indexOf('=');
    const flag = at < 0 ? raw : raw.slice(0,at);
    const value = at < 0 ? argv[++i] : raw.slice(at+1);
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case '--root': opts.root = value; break;
      case '--scope': opts.scope = value; break;
      case '--format': opts.format = value; break;
      case '--limit': opts.limit = Number(value); break;
      case '--selector': opts.selector = value; break;
      case '--file': opts.file = value; break;
      case '--entry': opts.entries.push(value); break;
      case '--baseline': opts.baseline = value; break;
      case '--candidate': opts.candidate = value; break;
      case '--load-path': opts.loadPaths.push(value); break;
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!['text','json'].includes(opts.format)) throw new Error('--format must be text or json');
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 10000) throw new Error('--limit must be 1..10000');
  opts.root = path.resolve(opts.root);
  if (!fs.statSync(opts.root, {throwIfNoEntry:false})?.isDirectory()) throw new Error(`Root directory not found: ${opts.root}`);
  opts.scopeAbs = ensureUnder(opts.root, path.resolve(opts.root, opts.scope));
  if (!fs.statSync(opts.scopeAbs, {throwIfNoEntry:false})?.isDirectory()) throw new Error(`Scope directory not found: ${opts.scopeAbs}`);
  opts.scope = relative(opts.root, opts.scopeAbs) || '.';
  return opts;
}
function eligibleFile(file) {
  return !slash(file).split('/').slice(0,-1).some(part=>DEFAULT_IGNORES.has(part));
}
function walkFiles(root, from = root) {
  ensureUnder(root,from);
  if (!eligibleFile(relative(root,from)+'/') || !fs.existsSync(from)) return [];
  const out = [];
  const dirs = [from];
  while (dirs.length) {
    const dir = dirs.pop();
    for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory() && !DEFAULT_IGNORES.has(ent.name)) dirs.push(p);
      else if (ent.isFile()) {
        out.push(relative(root,p));
        if (out.length > MAX_FILES) throw new Error(`Scope exceeds ${MAX_FILES} files; use --scope to narrow the analysis.`);
      }
      // Intentionally do not traverse symlinked directories, avoiding cycles/out-of-root content.
    }
  }
  return sort(out);
}
function display(result, opts) {
  if (opts.format === 'json') {
    // Large JSON responses are expensive for agents; expose counts but cap evidence arrays.
    const payload = {...result};
    const truncated = {};
    if (payload.comparisons) payload.comparisons = [
      ...payload.comparisons.filter(c=>c.status!=='structurally-equal'),
      ...payload.comparisons.filter(c=>c.status==='structurally-equal'),
    ];
    for (const key of ['projects','sampleStyles','definitions','references','possibleDynamic',
                       'directConsumers','affectedFiles','possibleRoutes','warnings','comparisons','importChanges']) {
      if (Array.isArray(payload[key]) && payload[key].length > opts.limit) {
        truncated[key] = payload[key].length - opts.limit;
        payload[key] = payload[key].slice(0,opts.limit);
      }
    }
    if (payload.comparisons) payload.comparisons = payload.comparisons.map(c => ({
      ...c,...(c.findings ? {findings:c.findings.slice(0,opts.limit)} : {})
    }));
    if (Object.keys(truncated).length) payload.truncated = truncated;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  const prefix = `${result.command}: ${result.summary || ''}`;
  console.log(prefix);
  if (result.scope) console.log(`Scope: ${result.scope}`);
  if (result.projects) {
    for (const p of result.projects.slice(0, opts.limit)) console.log(`  ${p.kind.padEnd(16)} ${p.path}`);
    console.log(`Source: ${JSON.stringify(result.counts)}`);
  }
  if (result.definitions) {
    console.log(`Definitions (${result.definitions.length}):`);
    for (const d of result.definitions.slice(0, opts.limit)) console.log(`  ${d.file}:${d.line} ${d.selector}`);
    console.log(`References (${result.references.length}):`);
    for (const r of result.references.slice(0, opts.limit)) console.log(`  ${r.file}:${r.line} [${r.confidence}] ${r.kind} ${r.detail || ''}`);
    if (result.possibleDynamic?.length) console.log(`Unresolved dynamic class expressions: ${result.possibleDynamic.length}`);
  }
  if (result.affectedFiles) {
    console.log(`Direct consumers: ${result.directConsumers.length}; transitive consumers: ${result.affectedFiles.length}`);
    for (const f of result.affectedFiles.slice(0, opts.limit)) console.log(`  ${f}`);
    if (result.possibleRoutes?.length) console.log('Possible routes/pages: ' + result.possibleRoutes.slice(0,opts.limit).join(', '));
  }
  if (result.comparisons) {
    console.log(`Compared ${result.summaryCounts.compared} entries: ${result.summaryCounts.equivalent} structurally equal, ${result.summaryCounts.changed} changed, ${result.summaryCounts.importOrderChanges} import-order risks, ${result.summaryCounts.errors} errors`);
    for (const issue of (result.importChanges||[]).slice(0,opts.limit)) console.log(`  [css-import-order-risk] ${issue.file}`);
    for (const c of result.comparisons.filter(x => x.status !== 'structurally-equal').slice(0,opts.limit)) {
      console.log(`  [${c.status}] ${c.entry}${c.details ? ` — ${c.details}` : ''}`);
      for (const f of (c.findings || []).slice(0, Math.min(5,opts.limit))) console.log(`    ${f}`);
    }
  }
  for (const warning of (result.warnings || []).slice(0,opts.limit)) console.log(`WARNING: ${warning}`);
  if (result.limitations) console.log(`Limits: ${result.limitations.join('; ')}`);
}
function inventory(opts) {
  const all = walkFiles(opts.root,opts.scopeAbs);
  const styles = all.filter(f => STYLE_EXT.test(f));
  const js = all.filter(f => SCRIPT_EXT.test(f));
  const projects = [];
  for (const file of all) {
    const base = path.posix.basename(file);
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(opts.root,file),'utf8'));
        const deps = {...pkg.dependencies,...pkg.devDependencies};
        if (deps.react || deps['react-dom']) projects.push({kind:'react-frontend',path:path.posix.dirname(file),name:pkg.name||null});
        else projects.push({kind:'node-project',path:path.posix.dirname(file),name:pkg.name||null});
      } catch { projects.push({kind:'package-json-error',path:file}); }
    }
    if (base === 'pom.xml' || /^build\.gradle(?:\.kts)?$/.test(base))
      projects.push({kind:'java-build',path:path.posix.dirname(file),manifest:base});
  }
  const result = {tool:'style-intel',version:VERSION,command:'inventory',scope:opts.scope,
    summary:`${styles.length} stylesheets, ${js.length} JavaScript/TypeScript files, ${projects.length} project/build manifests`,
    projects:projects.slice(0,200),
    counts:{files:all.length,css:styles.filter(f=>f.endsWith('.css')).length,
      scss:styles.filter(f=>f.endsWith('.scss')).length,sass:styles.filter(f=>f.endsWith('.sass')).length,
      scripts:js.length,html:all.filter(f=>/\.html?$/i.test(f)).length},
    sampleStyles:styles.slice(0,opts.limit), warnings:[],
    limitations:['Folder traversal skips generated/vendor directories and symbolic links','Build manifests do not establish runtime integration']};
  return result;
}
function getClasses(selector, warnings, location='') {
  const classes = new Set();
  try {
    selectorParser()(selectors => selectors.walkClasses(node => classes.add(node.value))).processSync(selector);
  } catch (e) {
    pushUnique(warnings,`Could not parse selector ${location}: ${String(e.message).split('\n')[0]}`);
  }
  return classes;
}
function parseStyles(file, root, warnings) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.sass') {
    pushUnique(warnings,`Indented .sass selector mapping is unsupported: ${file}`);
    return null;
  }
  const source = fs.readFileSync(path.join(root,file),'utf8');
  const parser = ext === '.scss' ? postcssScss() : postcss();
  try {
    return parser.parse(source,{from:file});
  } catch (e) {
    pushUnique(warnings,`Could not parse ${file}: ${String(e.message).split('\n')[0]}`);
    return null;
  }
}
function styleDefinitions(opts, queryName, files, warnings) {
  const defs = [];
  for (const file of files.filter(x => STYLE_EXT.test(x))) {
    const ast = parseStyles(file,opts.root,warnings);
    if (!ast) continue;
    ast.walkRules(rule => {
      const names = getClasses(rule.selector,warnings,`${file}:${rule.source?.start?.line || '?'}`);
      if (names.has(queryName)) defs.push({file,line:rule.source?.start?.line||1,selector:rule.selector,
        module:/\.module\.(css|scss|sass)$/i.test(file),
        hasSassNesting:rule.selector.includes('&') || rule.selector.includes('#{')});
    });
  }
  return defs.sort((a,b)=>a.file.localeCompare(b.file) || a.line-b.line);
}
function tsScriptKind(file) {
  const t = ts();
  if (/\.tsx$/i.test(file)) return t.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return t.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(file)) return t.ScriptKind.JS;
  return t.ScriptKind.TS;
}
function sourceFile(file, abs) {
  const text = fs.readFileSync(abs,'utf8');
  const t=ts();
  const sf=t.createSourceFile(file,text,t.ScriptTarget.Latest,true,tsScriptKind(file));
  if (sf.parseDiagnostics.length) {
    const diagnostic=sf.parseDiagnostics[0];
    const position=sf.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(`Cannot parse ${file}:${position.line+1}:${position.character+1}: ${t.flattenDiagnosticMessageText(diagnostic.messageText,' ')}`);
  }
  return sf;
}
function moduleCandidates(spec, importer, known) {
  if (!spec.startsWith('.')) return [];
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(importer),slash(spec)));
  const attempts = [stem, ...['.tsx','.ts','.jsx','.js','.mjs','.cjs','.css','.scss','.sass'].map(x=>stem+x),
    ...['index.tsx','index.ts','index.jsx','index.js','index.css','index.scss'].map(x=>stem+'/'+x)];
  return attempts.filter(x=>known.has(x));
}
function importBindings(sf, importer, known) {
  const bindings = new Map();
  const imports = [];
  const t = ts();
  for (const statement of sf.statements) {
    if ((t.isImportDeclaration(statement) || t.isExportDeclaration(statement)) && statement.moduleSpecifier && t.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text;
      const targets = moduleCandidates(spec,importer,known);
      imports.push({spec,targets});
      if (t.isImportDeclaration(statement) && statement.importClause && targets.length) {
        const clause = statement.importClause;
        if (clause.name) bindings.set(clause.name.text, targets[0]);
        if (clause.namedBindings && t.isNamespaceImport(clause.namedBindings))
          bindings.set(clause.namedBindings.name.text,targets[0]);
      }
    }
  }
  return {bindings,imports};
}
function addRef(refs, ref, seen) {
  const key = `${ref.file}:${ref.line}:${ref.kind}:${ref.definition || ''}`;
  if (!seen.has(key)) {seen.add(key); refs.push(ref);}
}
function containsExactClass(text, className) {
  return String(text).split(/[\s\t\r\n]+/).includes(className);
}
function bindingChecker(sf) {
  // Bind this file without resolving dependencies or performing type checking.
  const t=ts(), options={noLib:true,noResolve:true,allowJs:true,jsx:t.JsxEmit.Preserve};
  const host=t.createCompilerHost(options);
  host.getSourceFile=name=>name===sf.fileName?sf:undefined;
  host.fileExists=name=>name===sf.fileName;
  host.readFile=()=>undefined;
  return t.createProgram([sf.fileName],options,host).getTypeChecker();
}
function gatherReferences(opts, queryName, definitions, files, warnings, scriptImports) {
  const sourceFiles = files.filter(f => SCRIPT_EXT.test(f) || /\.html?$/i.test(f));
  const known = new Set(files);
  const refs=[], dynamic=[], seen = new Set();
  const moduleDefs = new Set(definitions.filter(d=>d.module).map(d=>d.file));
  const anyGlobal = definitions.some(d=>!d.module);
  const t = ts();
  function refAllowed(defFile) { return !defFile || moduleDefs.has(defFile); }
  for (const file of sourceFiles) {
    const abs = path.join(opts.root,file);
    if (/\.html?$/i.test(file)) {
      if (!anyGlobal) continue;
      const source = fs.readFileSync(abs,'utf8');
      let match; const re = /\bclass\s*=\s*["']([^"']+)["']/g;
      while ((match = re.exec(source))) {
        if (containsExactClass(match[1],queryName)) addRef(refs,{file,line:1+source.slice(0,match.index).split('\n').length-1,
          kind:'html-class',confidence:'strong',detail:match[1]},seen);
      }
      continue;
    }
    let sf;
    try {sf=sourceFile(file,abs);} catch (e) {
      scriptImports?.set(file,{error:e.message});
      pushUnique(warnings,`Unreadable source ${file}: ${e.message}`);continue;
    }
    const {bindings,imports} = importBindings(sf,file,known);
    // Retain only import records for graph building, allowing each AST to be released.
    scriptImports?.set(file,{imports});
    const checker=[...bindings.values()].some(f=>moduleDefs.has(f))?bindingChecker(sf):null;
    function importedSource(identifier) {
      if (!checker || !bindings.has(identifier.text)) return undefined;
      const symbol=checker.getSymbolAtLocation(identifier);
      return symbol?.declarations?.some(d=>(t.isImportClause(d)||t.isNamespaceImport(d)) && d.getSourceFile()===sf)
        ? bindings.get(identifier.text) : undefined;
    }
    const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1;
    function walk(node, inClassExpr=false) {
      // CSS Modules: imported names are tied to the declaring stylesheet.
      if (t.isPropertyAccessExpression(node) && t.isIdentifier(node.expression)) {
        const source = importedSource(node.expression);
        if (source && moduleDefs.has(source) && node.name.text === queryName) {
          addRef(refs,{file,line:line(node),kind:'css-module-property',confidence:'strong',definition:source,
            detail:`${node.expression.text}.${queryName}`},seen);
        }
      }
      if (t.isElementAccessExpression(node) && t.isIdentifier(node.expression)) {
        const source = importedSource(node.expression);
        if (source && moduleDefs.has(source)) {
          if (node.argumentExpression && t.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === queryName)
            addRef(refs,{file,line:line(node),kind:'css-module-element',confidence:'strong',definition:source,
              detail:`${node.expression.text}[${JSON.stringify(queryName)}]`},seen);
          else if (!node.argumentExpression || !t.isStringLiteralLike(node.argumentExpression))
            dynamic.push({file,line:line(node),kind:'dynamic-css-module-index',definition:source});
        }
      }
      if (t.isJsxAttribute(node) && (node.name.text === 'className' || node.name.text === 'class')) {
        if (node.initializer && t.isStringLiteral(node.initializer)) {
          if (anyGlobal && containsExactClass(node.initializer.text,queryName))
            addRef(refs,{file,line:line(node),kind:'jsx-class',confidence:'strong',detail:node.initializer.text},seen);
        } else if (node.initializer && t.isJsxExpression(node.initializer)) {
          if (node.initializer.expression) walk(node.initializer.expression,true);
          // Do not recurse again: avoids mistaking CSS Modules strings as global classes.
          return;
        }
      }
      if (t.isStringLiteralLike(node) && inClassExpr && anyGlobal) {
        if (containsExactClass(node.text,queryName))
          addRef(refs,{file,line:line(node),kind:'jsx-class-expression',confidence:'probable',detail:node.text.slice(0,120)},seen);
      }
      // clsx({ 'active-state': predicate }) or { active: predicate } inside className expression
      if (inClassExpr && (t.isPropertyAssignment(node) || t.isShorthandPropertyAssignment(node)) && anyGlobal) {
        const key = node.name && (t.isIdentifier(node.name) || t.isStringLiteral(node.name)) ? node.name.text : null;
        if (key === queryName) addRef(refs,{file,line:line(node),kind:'class-object-key',confidence:'probable',detail:key},seen);
      }
      if (inClassExpr && t.isTemplateExpression(node)) {
        dynamic.push({file,line:line(node),kind:'dynamic-class-template'});
        if (anyGlobal) {
          const parts=[node.head.text,...node.templateSpans.map(x=>x.literal.text)];
          if (parts.some(part=>containsExactClass(part,queryName)))
            addRef(refs,{file,line:line(node),kind:'static-template-segment',confidence:'probable',detail:queryName},seen);
          else if (parts.some(part=>part.trim() && queryName.startsWith(part.trim())))
            addRef(refs,{file,line:line(node),kind:'dynamic-template-prefix',confidence:'possible',detail:parts.join('...').slice(0,120)},seen);
        }
      }
      // Also pick up classList.add/remove or class-map strings outside JSX as possible usage.
      if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) &&
          ['add','remove','toggle','contains','replace'].includes(node.expression.name.text) &&
          t.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'classList' && anyGlobal) {
        for (const arg of node.arguments) if (t.isStringLiteralLike(arg) && arg.text === queryName)
          addRef(refs,{file,line:line(node),kind:'classList',confidence:'strong',detail:arg.text},seen);
      }
      t.forEachChild(node, child=>walk(child,inClassExpr));
    }
    walk(sf,false);
    // Search exact JS strings outside JSX as a fallback. This is NOT proof of runtime class use.
    if (anyGlobal) {
      const source = sf.text;
      const safe = queryName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const occurrences = [...source.matchAll(new RegExp(`(['"\\x60])${safe}\\1`,'g'))].slice(0,50);
      for (const m of occurrences) {
        const ln=source.slice(0,m.index).split('\n').length;
        if (!refs.some(x=>x.file===file && x.line===ln && x.confidence!=='possible'))
          addRef(refs,{file,line:ln,kind:'unclassified-string',confidence:'possible',detail:queryName},seen);
      }
    }
  }
  const confidenceRank={strong:0,probable:1,possible:2};
  refs.sort((a,b)=>confidenceRank[a.confidence]-confidenceRank[b.confidence] || a.file.localeCompare(b.file)||a.line-b.line||a.kind.localeCompare(b.kind));
  const dyn = dynamic.filter(d=>d.definition ? moduleDefs.has(d.definition) : anyGlobal);
  return {refs,dynamic:dyn.slice(0,300)};
}
function refsCommand(opts, filesArg, scriptImports) {
  if (!opts.selector) throw new Error('refs requires --selector .class-name');
  const name = opts.selector.replace(/^\./,'');
  if (!name || /[\s#\[:>,]/.test(name)) throw new Error('--selector must be one class name (e.g., .customer-card)');
  const files = filesArg || walkFiles(opts.root,opts.scopeAbs);
  const warnings=[];
  const cssFiles = opts.file ? files.filter(f=>f===asRepoPath(opts.root,opts.scopeAbs,opts.file)) : files;
  const definitions=styleDefinitions(opts,name,cssFiles,warnings);
  const {refs,dynamic}=gatherReferences(opts,name,definitions,files,warnings,scriptImports);
  return {tool:'style-intel',version:VERSION,command:'refs',scope:opts.scope,selector:'.'+name,
    summary:`${definitions.length} selector definitions and ${refs.length} candidate references`,
    definitions,references:refs,possibleDynamic:dynamic,complete:warnings.length===0,
    warnings,limitations:['Class references are static evidence, not DOM/runtime coverage',
      'SCSS interpolation/nesting and TS aliases may evade resolution',
      'No references found never proves a selector is unused']};
}
function buildGraph(opts,files,warnings,scriptImports) {
  const known = new Set(files);
  const reverse = new Map();
  for (const f of files) reverse.set(f,new Set());
  for (const f of files.filter(x=>SCRIPT_EXT.test(x))) {
    let imports;
    const cached=scriptImports?.get(f);
    if (cached) {
      if (cached.error !== undefined) {pushUnique(warnings,`Unreadable ${f}: ${cached.error}`);continue;}
      imports=cached.imports;
    } else {
      let sf;
      try { sf=sourceFile(f,path.join(opts.root,f)); }
      catch (e) {pushUnique(warnings,`Unreadable ${f}: ${e.message}`);continue;}
      ({imports}=importBindings(sf,f,known));
    }
    for (const {targets} of imports) for (const target of targets) reverse.get(target)?.add(f);
  }
  return reverse;
}
function impactCommand(opts) {
  if (!opts.file && !opts.selector) throw new Error('impact requires --file PATH or --selector .class');
  const files=walkFiles(opts.root,opts.scopeAbs), warnings=[];
  const scriptImports=opts.selector?new Map():undefined;
  let starting=[];
  let refsReport=null;
  if (opts.selector) {
    refsReport=refsCommand(opts,files,scriptImports);
    starting=[...new Set(refsReport.references.filter(r=>['strong','probable'].includes(r.confidence)).map(r=>r.file))];
  } else {
    starting=[asRepoPath(opts.root,opts.scopeAbs,opts.file)];
    if (!files.includes(starting[0])) throw new Error(`Source file is not in the selected scope: ${starting[0]}`);
  }
  const reverse=buildGraph(opts,files,warnings,scriptImports);
  if (refsReport) warnings.push(...refsReport.warnings);
  const queue=[...starting], seen=new Set(starting);
  const direct=new Set();
  for (const start of starting) for (const consumer of reverse.get(start)||[]) direct.add(consumer);
  while(queue.length) {
    const file=queue.shift();
    for (const consumer of reverse.get(file)||[]) if (!seen.has(consumer)) {seen.add(consumer);queue.push(consumer);}
  }
  const affected=sort(seen);
  return {tool:'style-intel',version:VERSION,command:'impact',scope:opts.scope,
    input:opts.file?{file:starting[0]}:{selector:opts.selector},
    summary:`${starting.length} seeds, ${direct.size} direct importers, ${affected.length} potentially related files`,
    directConsumers:sort(direct),affectedFiles:affected,
    possibleRoutes:affected.filter(x=>/(?:^|\/)(?:pages?|routes?|views?)\/|(?:^|\/)App\.[tj]sx?$/i.test(x)),
    selectorEvidence:refsReport?{definitions:refsReport.definitions.length,references:refsReport.references.length}:undefined,
    complete: warnings.length===0 && (!refsReport || refsReport.complete), warnings,limitations:['Module imports are resolved only for relative paths; tsconfig aliases, barrels, code-splitting, and runtime routes may be missed',
      'Import reachability is not evidence a component renders or a CSS rule applies']};
}
function git(root,args, options={}) {
  const result = spawnSync('git',['-C',root,...args],{
    windowsHide:true,encoding:null,input:options.input || undefined,
    maxBuffer:256*1024*1024,timeout:120000,
  });
  if (result.error || result.status !== 0) {
    const message=(result.stderr||Buffer.alloc(0)).toString('utf8').trim();
    throw new Error(`git ${args.slice(0,2).join(' ')} failed: ${message || result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
}
function snapshotRevision(opts, rev, tempParent) {
  // Resolve to immutable commit ID and use one `cat-file --batch` invocation.
  // No shell; filenames are copied only beneath a unique OS temporary directory.
  if (rev.startsWith('-') || /[\r\n\0]/.test(rev)) throw new Error('Invalid Git revision');
  const sha=git(opts.root,['rev-parse','--verify','--end-of-options',`${rev}^{commit}`]).toString('utf8').trim();
  if (!/^[a-fA-F0-9]{40,64}$/.test(sha)) throw new Error(`Cannot resolve Git revision: ${rev}`);
  const list=git(opts.root,['ls-tree','-rz','--full-tree',sha]);
  const blobs=[];
  const inScope = f => opts.scope==='.' || f===opts.scope || f.startsWith(opts.scope+'/');
  for (const entry of list.toString('utf8').split('\0')) {
    if (!entry) continue;
    const tab=entry.indexOf('\t');
    const head=entry.slice(0,tab).split(' '), name=entry.slice(tab+1);
    // Materialize all tracked style sources for Sass dependency resolution.
    // Ignored files stay out of side.files, which controls entry discovery.
    if (head[1] === 'blob' && ['100644','100755'].includes(head[0]) &&
        (STYLE_EXT.test(name) || (eligibleFile(name) && SCRIPT_EXT.test(name) && inScope(name)))) blobs.push({oid:head[2],name});
  }
  const snapshot=path.join(tempParent,sha.slice(0,12));
  fs.mkdirSync(snapshot,{recursive:true});
  if (blobs.length) {
    const data=git(opts.root,['cat-file','--batch'],{input:Buffer.from(blobs.map(x=>x.oid).join('\n')+'\n')});
    let offset=0;
    for (const item of blobs) {
      const nl=data.indexOf(10,offset);
      if (nl < 0) throw new Error('Malformed Git cat-file output (missing header)');
      const header=data.subarray(offset,nl).toString('utf8');
      const m=/^[a-f\d]+ blob (\d+)$/.exec(header);
      if (!m) throw new Error(`Malformed Git cat-file output: ${header}`);
      const size=Number(m[1]);
      const contents=data.subarray(nl+1,nl+1+size);
      if (contents.length !== size || data[nl+1+size] !== 10) throw new Error('Incomplete Git blob in cat-file output');
      const target=ensureUnder(snapshot,path.resolve(snapshot,item.name));
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,contents);
      offset=nl+1+size+1;
    }
  }
  return {kind:'git',revision:sha,path:snapshot,files:blobs.map(x=>x.name).filter(eligibleFile)};
}
function trackedSymlinks(root) {
  // Directory-only comparisons also work without Git or repository metadata.
  const probe=spawnSync('git',['-C',root,'rev-parse','--is-inside-work-tree'],{
    encoding:'utf8',windowsHide:true,timeout:10000,
  });
  if (probe.status!==0 || probe.stdout.trim()!=='true') return new Set();
  const links=new Set();
  const listing=git(root,['ls-files','--stage','-z']).toString('utf8');
  for (const entry of listing.split('\0')) {
    const tab=entry.indexOf('\t');
    if (tab<0 || entry.slice(0,tab).split(' ')[0]!=='120000') continue;
    const file=entry.slice(tab+1);
    links.add(process.platform==='win32'?file.toLowerCase():file);
  }
  return links;
}
function filesystemSide(opts,root,kind) {
  const links=trackedSymlinks(root);
  const eligible=file=>eligibleFile(file) && !links.has(process.platform==='win32'?file.toLowerCase():file);
  const files=walkFiles(root,path.join(root,opts.scope)).filter(f=>eligible(f)&&(STYLE_EXT.test(f)||SCRIPT_EXT.test(f)));
  // Explicit entries may live outside scope. Sass reads other dependencies
  // directly from this side, so discovery need not traverse the whole tree.
  for (const entry of opts.entries) {
    const candidates=path.isAbsolute(entry)
      ? [relative(opts.root,ensureUnder(opts.root,entry))]
      : [slash(entry),path.posix.join(opts.scope,slash(entry))];
    for (const file of candidates) {
      let abs;
      try {abs=ensureUnder(root,path.resolve(root,file));}
      catch(error) {
        // A relative entry has root-relative and scope-relative interpretations.
        // Discard an invalid interpretation while still trying the other one.
        if (path.isAbsolute(entry)) throw error;
        continue;
      }
      if (eligible(relative(root,abs)) && STYLE_EXT.test(file) && fs.statSync(abs,{throwIfNoEntry:false})?.isFile())
        pushUnique(files,relative(root,abs));
    }
  }
  return {kind,revision:null,path:root,files};
}
function prepareSide(opts, spec, tempParent) {
  if (spec.toLowerCase()==='worktree') return filesystemSide(opts,opts.root,'worktree');
  const directory=path.resolve(spec);
  if (fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory()) return filesystemSide(opts,directory,'directory');
  return snapshotRevision(opts,spec,tempParent);
}
function asEntryList(opts,a,b) {
  const inScope = f => opts.scope==='.' || f === opts.scope || f.startsWith(opts.scope+'/');
  const all = new Set([...a.files,...b.files].filter(f=>STYLE_EXT.test(f)&&inScope(f)&&(!path.posix.basename(f).startsWith('_')||/\.css$/i.test(f))));
  if (opts.entries.length) return sort(opts.entries.map(f=>{
    const r=slash(f);
    if (path.isAbsolute(f) || /^[A-Za-z]:\//.test(r)) {
      const candidate=relative(opts.root,ensureUnder(opts.root,f));
      if (a.files.includes(candidate)||b.files.includes(candidate)) return candidate;
      throw new Error(`--entry not found in either snapshot: ${f}`);
    }
    const rootCandidate=posix(path.normalize(r));
    const scopeCandidate=path.posix.normalize(path.posix.join(opts.scope,r));
    if (a.files.includes(rootCandidate) || b.files.includes(rootCandidate)) return rootCandidate;
    if (a.files.includes(scopeCandidate) || b.files.includes(scopeCandidate)) return scopeCandidate;
    throw new Error(`--entry not found in either snapshot: ${f}`);
  }));
  return sort(all);
}
function canonicalCss(source, label) {
  const ast=postcss().parse(source,{from:label});
  const nodes=[];
  const blocks=[];
  function visit(container,parents) {
    for (const n of (container.nodes||[])) {
      if (n.type === 'comment') continue;
      if (n.type === 'decl') {
        nodes.push(['decl',n.prop,n.value.trim(),!!n.important]);
      } else if (n.type === 'rule') {
        nodes.push(['rule',n.selector.trim()]);
        const declarations=(n.nodes||[]).filter(x=>x.type==='decl').map(x=>[x.prop,x.value.trim(),!!x.important]);
        blocks.push({context:parents,selector:n.selector.trim(),declarations});
        visit(n,parents);
        nodes.push(['/rule']);
      } else if (n.type === 'atrule') {
        nodes.push(['@'+n.name,n.params.trim(),Boolean(n.nodes)]);
        if (n.nodes) {visit(n,[...parents,`@${n.name} ${n.params.trim()}`]);nodes.push(['/@'+n.name]);}
      }
    }
  }
  visit(ast,[]);
  return {nodes,blocks,ruleCount:blocks.length};
}
function bag(items) {
  const counts=new Map();
  for (const item of items) counts.set(item,(counts.get(item)||0)+1);
  return counts;
}
function countDelta(before,after) {
  const b=bag(before),a=bag(after); let plus=0,minus=0;
  for (const [s,n] of a) plus+=Math.max(0,n-(b.get(s)||0));
  for (const [s,n] of b) minus+=Math.max(0,n-(a.get(s)||0));
  return {added:plus,removed:minus};
}
function summarizeDifference(before,after,limit) {
  const old=before.blocks.map(x=>JSON.stringify(x)), newer=after.blocks.map(x=>JSON.stringify(x));
  const delta=countDelta(old,newer);
  const nodeDelta=countDelta(before.nodes.map(JSON.stringify),after.nodes.map(JSON.stringify));
  const sameMultiset=delta.added===0 && delta.removed===0 && nodeDelta.added===0 && nodeDelta.removed===0;
  const findings=[];
  if (sameMultiset) findings.push('CSS AST nodes and rule blocks are reordered; the cascade or at-rule behavior may change');
  else {
    findings.push(`${delta.added} added/modified rule blocks; ${delta.removed} removed/modified rule blocks`);
    const oldBag=bag(old), newBag=bag(newer);
    for (const b of after.blocks) if ((oldBag.get(JSON.stringify(b))||0) < (newBag.get(JSON.stringify(b))||0)) {
      findings.push(`Added/modified: ${[...b.context,b.selector].join(' > ')}`);
      if (findings.length>=limit) break;
    }
    for (const b of before.blocks) if (!newBag.has(JSON.stringify(b))) {
      findings.push(`Removed/modified: ${[...b.context,b.selector].join(' > ')}`);
      if (findings.length>=limit) break;
    }
  }
  if (before.nodes.length !== after.nodes.length) findings.push(`CSS AST node counts: ${before.nodes.length} → ${after.nodes.length}`);
  return {reorderedOnly:sameMultiset,findings:findings.slice(0,limit)};
}
function directImports(side,file) {
  if (!side.files.includes(file)) return [];
  const sf=sourceFile(file,path.join(side.path,file));
  return sf.statements
    .filter(x=>ts().isImportDeclaration(x) && x.moduleSpecifier && ts().isStringLiteral(x.moduleSpecifier))
    .map(x=>x.moduleSpecifier.text);
}
function compareStyleImportOrder(opts,baseline,candidate,limit) {
  // React bundlers may have observable order-dependent CSS imports. An identical
  // compiled Sass AST is not sufficient when frontend import order changes.
  const inScope=f=>opts.scope==='.' || f.startsWith(opts.scope+'/');
  const all=sort(new Set([...baseline.files,...candidate.files].filter(f=>SCRIPT_EXT.test(f)&&inScope(f))));
  const findings=[];
  for (const file of all) {
    let before,after;
    try {
      before=directImports(baseline,file);
      after=directImports(candidate,file);
    } catch(e) {
      throw new Error(`Cannot inspect frontend source imports in ${file}: ${e.message}`);
    }
    const hasStyles=[...before,...after].some(x=>STYLE_EXT.test(x));
    if (!hasStyles || JSON.stringify(before)===JSON.stringify(after)) continue;
    findings.push({file,kind:'potential-css-import-order-change',before,after,
      explanation:'ES import sequence changed in a file that imports styles; global CSS order may change'});
  }
  return findings;
}
function resolveLoadPaths(opts,side) {
  const explicit=opts.loadPaths.map(p=>{
    const absolute=path.resolve(opts.root,p), local=path.relative(opts.root,absolute);
    const internal=local!=='..' && !local.startsWith('..'+path.sep) && !path.isAbsolute(local);
    // Current dependency directories are intentionally shared, as documented.
    // Other project load paths must resolve inside the selected snapshot.
    return internal && !local.split(path.sep).includes('node_modules')
      ? ensureUnder(side.path,path.resolve(side.path,local)) : absolute;
  });
  const candidates=[
    path.join(side.path,opts.scope),side.path,
    path.join(side.path,opts.scope,'src'),
    path.join(opts.root,'node_modules'),
    path.join(opts.root,opts.scope,'node_modules'),
    ...explicit,
  ];
  return [...new Set(candidates.filter(x=>fs.statSync(x,{throwIfNoEntry:false})?.isDirectory()))];
}
async function compareCommand(opts, verify=false) {
  const warnings=[], comparisons=[];
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'style-intel-'));
  let compiler=null;
  try {
    const baseline=prepareSide(opts,opts.baseline,temp), candidate=prepareSide(opts,opts.candidate,temp);
    const entries=asEntryList(opts,baseline,candidate);
    if (!entries.length) warnings.push('No non-partial CSS/SCSS/Sass entries found in scope');
    if (entries.some(f=>/\.(scss|sass)$/i.test(f))) {
      let sass;
      try {sass=require('sass-embedded');}
      catch {sass=required('sass','Install sass-embedded (preferred) or sass.');}
      if (typeof sass.initAsyncCompiler === 'function') compiler=await sass.initAsyncCompiler();
      else compiler={compileAsync:(...args)=>sass.compileAsync(...args),dispose:async()=>{}};
    }
    async function compiled(side,file) {
      if (!side.files.includes(file)) return {missing:true};
      const abs=ensureUnder(side.path,path.join(side.path,file));
      if (!fs.existsSync(abs)) return {error:'File absent from snapshot despite listing'};
      if (/\.css$/i.test(file)) return {css:fs.readFileSync(abs,'utf8')};
      try {
        const result=await compiler.compileAsync(abs,{style:'expanded',loadPaths:resolveLoadPaths(opts,side),
          sourceMap:false,quietDeps:true,logger:{warn:()=>{},debug:()=>{}}});
        return {css:result.css};
      } catch(e) {return {error:String(e.message).split('\n').slice(0,5).join(' | ')};}
    }
    for (const entry of entries) {
      const [a,b]=[await compiled(baseline,entry),await compiled(candidate,entry)];
      if (a.error || b.error) {comparisons.push({entry,status:'error',details:`baseline: ${a.error||'OK'}; candidate: ${b.error||'OK'}`});continue;}
      if (a.missing && b.missing) {comparisons.push({entry,status:'error',details:'Entry absent from both snapshots'});continue;}
      if (a.missing || b.missing) {comparisons.push({entry,status:'changed',details:a.missing?'Added stylesheet':'Removed stylesheet',
        findings:['Entry exists on only one side']});continue;}
      let old,next;
      try {old=canonicalCss(a.css,entry);next=canonicalCss(b.css,entry);}
      catch(e) {comparisons.push({entry,status:'error',details:`CSS parsing failed: ${e.message}`});continue;}
      if (JSON.stringify(old.nodes)===JSON.stringify(next.nodes)) {
        comparisons.push({entry,status:'structurally-equal',rules:next.ruleCount});
      } else {
        const d=summarizeDifference(old,next,opts.limit);
        comparisons.push({entry,status:d.reorderedOnly?'reordered':'changed',
          details:d.reorderedOnly?'Possible cascade change':'CSS AST differs',
          findings:d.findings,rulesBefore:old.ruleCount,rulesAfter:next.ruleCount});
      }
    }
    const importChanges=compareStyleImportOrder(opts,baseline,candidate,opts.limit);
    const stats={compared:comparisons.length,equivalent:comparisons.filter(x=>x.status==='structurally-equal').length,
      changed:comparisons.filter(x=>['changed','reordered'].includes(x.status)).length,
      errors:comparisons.filter(x=>x.status==='error').length,importOrderChanges:importChanges.length};
    const result={tool:'style-intel',version:VERSION,command:verify?'verify':'compare',scope:opts.scope,
      baseline:baseline.kind==='git'?baseline.revision:baseline.kind,
      candidate:candidate.kind==='git'?candidate.revision:candidate.kind,
      summary:`${stats.equivalent}/${stats.compared} static CSS AST comparisons equal; ${importChanges.length} potential CSS import-order changes`,
      summaryCounts:stats,complete:stats.errors===0&&stats.compared>0,comparisons,importChanges,warnings,
      limitations:[
        'AST structural equality is NOT computed-style or visual equivalence',
        'Sass compilation does not run Vite/Webpack/PostCSS application plugins or CSS Modules transformations',
        'External node_modules and compiler versions are read from the current environment for both snapshots',
        'Changed global rule ordering may alter the cascade even when declarations match',
        'Stylesheet lists are per side; ignored/generated styles are omitted',
      ]};
    return result;
  } finally {
    if (compiler) await compiler.dispose();
    fs.rmSync(temp,{force:true,recursive:true,maxRetries:3,retryDelay:100});
  }
}
async function main() {
  let opts;
  try {
    opts=parseArgs(process.argv.slice(2));
    if (opts.help) {console.log(mainHelp());return;}
    let result;
    if (opts.command==='inventory') result=inventory(opts);
    else if (opts.command==='refs') result=refsCommand(opts);
    else if (opts.command==='impact') result=impactCommand(opts);
    else result=await compareCommand(opts,opts.command==='verify');
    display(result,opts);
    if (result.comparisons) {
      if (!result.complete) process.exitCode=3;
      else if ((opts.command==='verify'||opts.failOnDiff) && (result.summaryCounts.changed>0 || result.summaryCounts.importOrderChanges>0)) process.exitCode=2;
    } else if (result.complete===false) process.exitCode=3;
  } catch(e) {
    console.error(`style-intel: ${e.message}`);
    if (process.env.STYLE_INTEL_DEBUG==='1') console.error(e.stack);
    process.exitCode=3;
  }
}
await main();