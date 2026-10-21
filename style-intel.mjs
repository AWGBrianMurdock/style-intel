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
import { fileURLToPath } from 'node:url';
import { snapshotGitBlobs } from './git-snapshot.mjs';

const require = createRequire(import.meta.url);
const VERSION = '0.1.0';
const STYLE_EXT = /\.(?:css|scss|sass)$/i;
const MAIN_STYLE_EXT = /\.(?:css|scss|sass)$/i;
const SCRIPT_EXT = /\.(?:tsx|jsx|ts|js|mts|cts|mjs|cjs)$/i;
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
// These append-only evidence arrays retain their output order without repeated scans.
const uniqueValues = new WeakMap();
function pushUnique(arr, val) {
  let seen=uniqueValues.get(arr);
  if (!seen) {seen=new Set(arr);uniqueValues.set(arr,seen);}
  if (!seen.has(val)) {seen.add(val);arr.push(val);}
}
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
  // Historical/directory sides can contain a scope deleted from the worktree.
  if (!['compare','verify'].includes(command) && !fs.statSync(opts.scopeAbs, {throwIfNoEntry:false})?.isDirectory())
    throw new Error(`Scope directory not found: ${opts.scopeAbs}`);
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
    const truncated = {}, totals = {};
    if (payload.comparisons) payload.comparisons = [
      ...payload.comparisons.filter(c=>c.status!=='structurally-equal'),
      ...payload.comparisons.filter(c=>c.status==='structurally-equal'),
    ];
    for (const key of ['projects','sampleStyles','definitions','references','possibleDynamic',
                       'directConsumers','affectedFiles','possibleRoutes','warnings','comparisons','importChanges']) {
      if (Array.isArray(payload[key])) totals[key] = payload[key].length;
      if (Array.isArray(payload[key]) && payload[key].length > opts.limit) {
        truncated[key] = payload[key].length - opts.limit;
        payload[key] = payload[key].slice(0,opts.limit);
      }
    }
    if (payload.importChanges) payload.importChanges=payload.importChanges.map(change=>{
      const out={...change};
      for (const side of ['before','after']) {
        out[side+'Count']=change[side].length;
        out[side]=change[side].slice(0,opts.limit);
        if (change[side].length>opts.limit) out['truncated'+side[0].toUpperCase()+side.slice(1)]=change[side].length-opts.limit;
      }
      return out;
    });
    if (payload.comparisons) payload.comparisons = payload.comparisons.map(c => ({
      ...c,...(c.findings ? {findings:c.findings.slice(0,opts.limit),findingCount:c.findings.length,
        ...(c.findings.length>opts.limit ? {truncatedFindings:c.findings.length-opts.limit} : {})} : {})
    }));
    payload.totals = totals;
    if (Object.keys(truncated).length) payload.truncated = truncated;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  const prefix = `${result.command}: ${result.summary || ''}`;
  console.log(prefix);
  if (result.scope) console.log(`Scope: ${result.scope}`);
  if (result.staticResolution) console.log(`Static resolution: ${result.staticResolution}`);
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
    projects,
    counts:{files:all.length,css:styles.filter(f=>f.endsWith('.css')).length,
      scss:styles.filter(f=>f.endsWith('.scss')).length,sass:styles.filter(f=>f.endsWith('.sass')).length,
      scripts:js.length,html:all.filter(f=>/\.html?$/i.test(f)).length},
    sampleStyles:styles, warnings:[],
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
  const emitted = {'.js':['.ts','.tsx'],'.jsx':['.tsx'],'.mjs':['.mts'],'.cjs':['.cts']};
  const ext = path.posix.extname(stem);
  const attempts = [stem, ...(emitted[ext]||[]).map(x=>stem.slice(0,-ext.length)+x),
    ...['.ts','.tsx','.jsx','.js','.mts','.cts','.mjs','.cjs','.css','.scss','.sass'].map(x=>stem+x),
    ...['index.ts','index.tsx','index.jsx','index.js','index.mts','index.cts','index.mjs','index.cjs','index.css','index.scss','index.sass'].map(x=>stem+'/'+x)];
  const found = attempts.find(x=>known.has(x));
  return found ? [found] : [];
}
function staticModuleSpecifier(statement) {
  const t=ts();
  if (t.isImportEqualsDeclaration(statement) && t.isExternalModuleReference(statement.moduleReference))
    return statement.moduleReference.expression;
  if (t.isImportDeclaration(statement) || t.isExportDeclaration(statement)) return statement.moduleSpecifier;
}
function warnUnresolved(imports, file, warnings) {
  for (const {spec,targets,unsupported} of imports) {
    if (unsupported) {pushUnique(warnings,unsupported+' in '+file+'; import traversal is incomplete');continue;}
    if (spec.startsWith('.') && !targets.length &&
        (!path.posix.extname(spec) || SCRIPT_EXT.test(spec) || STYLE_EXT.test(spec)))
      pushUnique(warnings,'Unresolved relative import '+JSON.stringify(spec)+' in '+file+' (missing, outside scope, or unsupported resolution)');
  }
}
function importBindings(sf, importer, known) {
  const bindings = new Map();
  const imports = [];
  const t = ts();
  let checker;
  const getChecker=()=>checker??=bindingChecker(sf);
  for (const statement of sf.statements) {
    const specifier=staticModuleSpecifier(statement);
    if (specifier && t.isStringLiteral(specifier)) {
      const spec = specifier.text;
      const targets = moduleCandidates(spec,importer,known);
      imports.push({spec,targets});
      // A static CSS Module access is evidence even if the stylesheet is missing.
      const moduleSource = spec.startsWith('.') && /\.module\.(?:css|scss|sass)$/i.test(spec)
        ? path.posix.normalize(path.posix.join(path.posix.dirname(importer),slash(spec))) : null;
      const bindingTarget = moduleSource || targets[0];
      if (t.isImportDeclaration(statement) && statement.importClause && bindingTarget) {
        const clause = statement.importClause;
        if (clause.name) bindings.set(clause.name.text, bindingTarget);
        if (clause.namedBindings && t.isNamespaceImport(clause.namedBindings))
          bindings.set(clause.namedBindings.name.text,bindingTarget);
      }
      if (t.isImportEqualsDeclaration(statement) && bindingTarget) bindings.set(statement.name.text,bindingTarget);
    }
  }
  function isNodeRequireFactory(expression) {
    const member=t.isPropertyAccessExpression(expression);
    const identifier=member ? expression.expression : expression;
    if (!t.isIdentifier(identifier)) return false;
    return getChecker().getSymbolAtLocation(identifier)?.declarations?.some(declaration=>{
      const named=!member && t.isImportSpecifier(declaration) && (declaration.propertyName||declaration.name).text==='createRequire';
      const namespace=member && expression.name.text==='createRequire' && (t.isNamespaceImport(declaration)||t.isImportClause(declaration));
      if (!named && !namespace) return false;
      let statement=declaration.parent;
      while (statement && !t.isImportDeclaration(statement)) statement=statement.parent;
      return statement && ['node:module','module'].includes(statement.moduleSpecifier.text);
    }) || false;
  }
  function calls(node) {
    if (t.isCallExpression(node)) {
      if (node.expression.kind===t.SyntaxKind.ImportKeyword) {
        const arg=node.arguments[0];
        if (arg && t.isStringLiteralLike(arg)) imports.push({spec:arg.text,targets:moduleCandidates(arg.text,importer,known)});
        else imports.push({unsupported:'Unsupported computed import() at line '+(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1)});
      } else if (t.isIdentifier(node.expression) && node.expression.text==='require') {
        const symbol=getChecker().getSymbolAtLocation(node.expression);
        const locallyBound=symbol && (symbol.flags & (t.SymbolFlags.Value|t.SymbolFlags.Alias)) && symbol.declarations?.some(declaration=>{
          if (declaration.getSourceFile()!==sf || (t.getCombinedModifierFlags(declaration)&t.ModifierFlags.Ambient)) return false;
          // A locally created Node loader still performs module loading. Other
          // local functions, parameters and imported helpers do not imply it.
          return !(t.isVariableDeclaration(declaration) && declaration.initializer &&
            t.isCallExpression(declaration.initializer) && isNodeRequireFactory(declaration.initializer.expression));
        });
        if (!locallyBound) imports.push({unsupported:'Unsupported require() call at line '+(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1)});
      }
    }
    t.forEachChild(node,calls);
  }
  calls(sf);
  return {bindings,imports,getChecker};
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
// Match tags and attributes, skipping comments and raw-text element contents.
function htmlClasses(source) {
  const found=[];
  const tags=/<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  let tag;
  while ((tag=tags.exec(source))) {
    if (!tag[1] || tag[0].startsWith('</')) continue;
    const name=tag[1].toLowerCase();
    const offset=tag[0].indexOf(tag[1])+tag[1].length;
    const attrs=tag[0].slice(offset,-1);
    const attribute=/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
    let attr;
    while ((attr=attribute.exec(attrs))) {
      if (attr[1].toLowerCase()==='class') found.push({
        value:attr[2]??attr[3]??attr[4]??'',index:tag.index+offset+attr.index});
    }
    if (/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(name)) {
      const close=new RegExp('</'+name+'\\s*>','gi');
      close.lastIndex=tags.lastIndex;
      const end=close.exec(source);
      tags.lastIndex=end ? close.lastIndex : source.length;
    }
  }
  return found;
}
function gatherReferences(opts, queryName, definitions, files, warnings, scriptImports, selected=null) {
  const sourceFiles = files.filter(f => SCRIPT_EXT.test(f) || /\.html?$/i.test(f));
  const known = new Set(files);
  const refs=[], dynamic=[], seen = new Set();
  const moduleDefs = new Set(definitions.filter(d=>d.module).map(d=>d.file));
  const anyGlobal = definitions.some(d=>!d.module);
  const moduleAllowed=f=>/\.module\.(?:css|scss|sass)$/i.test(f) && (!selected || f===selected);
  const t = ts();
  for (const file of sourceFiles) {
    const abs = path.join(opts.root,file);
    if (/\.html?$/i.test(file)) {
      if (!anyGlobal) continue;
      const source = fs.readFileSync(abs,'utf8');
      for (const attr of htmlClasses(source)) {
        if (containsExactClass(attr.value,queryName)) addRef(refs,{file,line:source.slice(0,attr.index).split('\n').length,
          kind:'html-class',confidence:'strong',detail:attr.value},seen);
      }
      continue;
    }
    let sf;
    try {sf=sourceFile(file,abs);} catch (e) {
      scriptImports?.set(file,{error:e.message});
      pushUnique(warnings,'Unreadable source '+file+': '+e.message);continue;
    }
    const {bindings,imports,getChecker} = importBindings(sf,file,known);
    scriptImports?.set(file,{imports});
    warnUnresolved(imports,file,warnings);
    const checker=[...bindings.values()].some(f=>/\.module\.(?:css|scss|sass)$/i.test(f))?getChecker():null;
    function importedSource(expression) {
      // These TypeScript/JavaScript wrappers preserve the underlying binding.
      let identifier=expression;
      while (t.isParenthesizedExpression(identifier) || t.isAsExpression(identifier) ||
        t.isTypeAssertionExpression(identifier) || t.isNonNullExpression(identifier) || t.isSatisfiesExpression(identifier))
        identifier=identifier.expression;
      if (!t.isIdentifier(identifier)) return undefined;
      if (!checker || !bindings.has(identifier.text)) return undefined;
      const symbol=checker.getSymbolAtLocation(identifier);
      return symbol?.declarations?.some(d=>(t.isImportClause(d)||t.isNamespaceImport(d)||t.isImportEqualsDeclaration(d)) && d.getSourceFile()===sf)
        ? bindings.get(identifier.text) : undefined;
    }
    const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1;
    const moduleEvidence=source=>({definition:source,stylesheet:source,definitionFound:moduleDefs.has(source)});
    const fallback=[];
    function unclassified(node) {
      // Comments are not AST literals. Exclude module names, property keys,
      // element indices and JSX attributes from speculative string evidence.
      for (let p=node.parent;p;p=p.parent) {
        if (t.isJsxAttribute(p) || t.isImportDeclaration(p) || t.isExportDeclaration(p) || t.isImportEqualsDeclaration(p)) return false;
      }
      const p=node.parent;
      return !(t.isElementAccessExpression(p) && p.argumentExpression===node) &&
        !((t.isPropertyAssignment(p)||t.isMethodDeclaration(p)) && p.name===node);
    }
    function walk(node, inClassExpr=false) {
      if (t.isPropertyAccessExpression(node)) {
        const source = importedSource(node.expression);
        if (source && moduleAllowed(source) && node.name.text === queryName)
          addRef(refs,{file,line:line(node),kind:'css-module-property',confidence:'strong',...moduleEvidence(source),
            detail:node.expression.getText(sf)+'.'+queryName},seen);
      }
      if (t.isElementAccessExpression(node)) {
        const source = importedSource(node.expression);
        if (source && /\.module\.(?:css|scss|sass)$/i.test(source)) {
          if (moduleAllowed(source)) {
            if (node.argumentExpression && t.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === queryName)
              addRef(refs,{file,line:line(node),kind:'css-module-element',confidence:'strong',...moduleEvidence(source),
                detail:node.expression.getText(sf)+'['+JSON.stringify(queryName)+']'},seen);
            else if (!node.argumentExpression || !t.isStringLiteralLike(node.argumentExpression))
              dynamic.push({file,line:line(node),kind:'dynamic-css-module-index',...moduleEvidence(source)});
          }
          if (node.argumentExpression) walk(node.argumentExpression,false);
          return; // A module key is not a literal global class.
        }
      }
      if (t.isElementAccessExpression(node)) {
        walk(node.expression,inClassExpr);
        if (node.argumentExpression) walk(node.argumentExpression,false);
        return;
      }
      if (t.isJsxAttribute(node)) {
        if (node.name.text !== 'className' && node.name.text !== 'class') {
          t.forEachChild(node,child=>walk(child,false));return;
        }
        if (node.initializer && t.isStringLiteral(node.initializer)) {
          if (anyGlobal && containsExactClass(node.initializer.text,queryName))
            addRef(refs,{file,line:line(node),kind:'jsx-class',confidence:'strong',detail:node.initializer.text},seen);
        } else if (node.initializer && t.isJsxExpression(node.initializer)) {
          if (node.initializer.expression) walk(node.initializer.expression,true);
          return;
        }
      }
      if (inClassExpr && t.isConditionalExpression(node)) {
        walk(node.condition,false);walk(node.whenTrue,true);walk(node.whenFalse,true);return;
      }
      if (inClassExpr && t.isBinaryExpression(node)) {
        const op=node.operatorToken.kind;
        walk(node.left,op===t.SyntaxKind.PlusToken || op===t.SyntaxKind.BarBarToken || op===t.SyntaxKind.QuestionQuestionToken);
        walk(node.right,[t.SyntaxKind.PlusToken,t.SyntaxKind.AmpersandAmpersandToken,t.SyntaxKind.BarBarToken,t.SyntaxKind.QuestionQuestionToken].includes(op));
        return;
      }
      if (t.isStringLiteralLike(node) && anyGlobal) {
        if (inClassExpr && containsExactClass(node.text,queryName))
          addRef(refs,{file,line:line(node),kind:'jsx-class-expression',confidence:'probable',detail:node.text.slice(0,120)},seen);
        else if (!inClassExpr && node.text===queryName && unclassified(node))
          fallback.push({file,line:line(node),kind:'unclassified-string',confidence:'possible',detail:queryName});
      }
      if (inClassExpr && (t.isPropertyAssignment(node) || t.isShorthandPropertyAssignment(node))) {
        const key = node.name && (t.isIdentifier(node.name) || t.isStringLiteral(node.name)) ? node.name.text : null;
        if (anyGlobal && key === queryName) addRef(refs,{file,line:line(node),kind:'class-object-key',confidence:'probable',detail:key},seen);
        if (t.isPropertyAssignment(node)) walk(node.initializer,false);
        return;
      }
      if (inClassExpr && t.isTemplateExpression(node)) {
        dynamic.push({file,line:line(node),kind:'dynamic-class-template'});
        const parts=[node.head.text,...node.templateSpans.map(x=>x.literal.text)];
        if (anyGlobal) {
          // Do not treat interpolation boundaries as complete class tokens.
          if (containsExactClass(parts.join('\0'),queryName))
            addRef(refs,{file,line:line(node),kind:'static-template-segment',confidence:'probable',detail:queryName},seen);
          else if (parts.some(part=>part.trim() && queryName.startsWith(part.trim())))
            addRef(refs,{file,line:line(node),kind:'dynamic-template-prefix',confidence:'possible',detail:parts.join('...').slice(0,120)},seen);
        }
        for (let i=0;i<node.templateSpans.length;i++) {
          // Only promote interpolated values when surrounding literals delimit
          // whole tokens. Adjacent unknown values or glued prefixes may compose a class.
          const leftBoundary=(i===0 && parts[i]==='') || /\s$/.test(parts[i]);
          const rightBoundary=(i===node.templateSpans.length-1 && parts[i+1]==='') || /^\s/.test(parts[i+1]);
          walk(node.templateSpans[i].expression,leftBoundary && rightBoundary);
        }
        return;
      }
      if (t.isCallExpression(node) && t.isPropertyAccessExpression(node.expression) &&
          ['add','remove','toggle','contains','replace'].includes(node.expression.name.text) &&
          t.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'classList' && anyGlobal) {
        for (const arg of node.arguments) if (t.isStringLiteralLike(arg) && arg.text === queryName)
          addRef(refs,{file,line:line(node),kind:'classList',confidence:'strong',detail:arg.text},seen);
      }
      t.forEachChild(node, child=>walk(child,inClassExpr));
    }
    const firstRef=refs.length;
    walk(sf,false);
    const classifiedLines=new Set(refs.slice(firstRef).filter(r=>r.confidence!=='possible').map(r=>r.line));
    for (const ref of fallback) if (!classifiedLines.has(ref.line)) addRef(refs,ref,seen);
  }
  const confidenceRank={strong:0,probable:1,possible:2};
  refs.sort((a,b)=>confidenceRank[a.confidence]-confidenceRank[b.confidence] || a.file.localeCompare(b.file)||a.line-b.line||a.kind.localeCompare(b.kind));
  return {refs,dynamic:dynamic.filter(d=>d.definition ? moduleAllowed(d.definition) : anyGlobal)};
}
function refsCommand(opts, filesArg, scriptImports, selected=opts.file ? asRepoPath(opts.root,opts.scopeAbs,opts.file) : null) {
  if (!opts.selector) throw new Error('refs requires --selector .class-name');
  const name = opts.selector.replace(/^\./,'');
  if (!name || /[\s#\[:>,]/.test(name)) throw new Error('--selector must be one class name (e.g., .customer-card)');
  const files = filesArg || walkFiles(opts.root,opts.scopeAbs);
  const warnings=[];
  const cssFiles = selected===null ? files : files.filter(f=>f===selected);
  const definitions=styleDefinitions(opts,name,cssFiles,warnings);
  const {refs,dynamic}=gatherReferences(opts,name,definitions,files,warnings,scriptImports,selected);
  return {tool:'style-intel',version:VERSION,command:'refs',scope:opts.scope,selector:'.'+name,
    summary:`${definitions.length} selector definitions and ${refs.length} candidate references`,
    definitions,references:refs,possibleDynamic:dynamic,complete:warnings.length===0,staticResolution:'partial',
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
    warnUnresolved(imports,f,warnings);
    for (const {targets=[]} of imports) for (const target of targets) reverse.get(target)?.add(f);
  }
  return reverse;
}
function impactCommand(opts) {
  if (!opts.file && !opts.selector) throw new Error('impact requires --file PATH or --selector .class');
  const files=walkFiles(opts.root,opts.scopeAbs), warnings=[];
  const selected=opts.file ? asRepoPath(opts.root,opts.scopeAbs,opts.file) : null;
  const scriptImports=opts.selector?new Map():undefined;
  let starting=[];
  let refsReport=null;
  if (opts.selector) {
    refsReport=refsCommand(opts,files,scriptImports,selected);
    starting=[...new Set(refsReport.references.filter(r=>['strong','probable'].includes(r.confidence)).map(r=>r.file))];
  } else {
    starting=[selected];
    if (!files.includes(starting[0])) throw new Error(`Source file is not in the selected scope: ${starting[0]}`);
  }
  const reverse=buildGraph(opts,files,warnings,scriptImports);
  if (refsReport) for (const warning of refsReport.warnings) pushUnique(warnings,warning);
  const queue=[...starting], seen=new Set(starting);
  const direct=new Set();
  for (const start of starting) for (const consumer of reverse.get(start)||[]) direct.add(consumer);
  for (let cursor=0;cursor<queue.length;cursor++) {
    const file=queue[cursor];
    for (const consumer of reverse.get(file)||[]) if (!seen.has(consumer)) {seen.add(consumer);queue.push(consumer);}
  }
  const affected=sort(seen);
  return {tool:'style-intel',version:VERSION,command:'impact',scope:opts.scope,
    input:opts.selector ? {selector:opts.selector,...(selected===null ? {} : {file:selected})} : {file:starting[0]},
    summary:`${starting.length} seeds, ${direct.size} direct importers, ${affected.length} potentially related files`,
    directConsumers:sort(direct),affectedFiles:affected,
    possibleRoutes:affected.filter(x=>/(?:^|\/)(?:pages?|routes?|views?)\/|(?:^|\/)App\.[tj]sx?$/i.test(x)),
    selectorEvidence:refsReport?{definitions:refsReport.definitions.length,references:refsReport.references.length}:undefined,
    complete: warnings.length===0 && (!refsReport || refsReport.complete),staticResolution:'partial',warnings,limitations:['Relative ES imports, re-exports, import-equals and static import() calls are traversed; tsconfig aliases, require() calls, computed imports and runtime routes may be missed',
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
async function snapshotRevision(opts, rev, tempParent) {
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
  if (blobs.length) await snapshotGitBlobs(opts.root,blobs,item=>
    ensureUnder(snapshot,path.resolve(snapshot,item.name)));
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
  const scope=ensureUnder(root,path.join(root,opts.scope));
  const files=(fs.statSync(scope,{throwIfNoEntry:false})?.isDirectory() ? walkFiles(root,scope) : [])
    .filter(f=>eligible(f)&&(STYLE_EXT.test(f)||SCRIPT_EXT.test(f)));
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
async function prepareSide(opts, spec, tempParent) {
  const directory=path.resolve(spec);
  const side=spec.toLowerCase()==='worktree' ? filesystemSide(opts,opts.root,'worktree')
    : fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory() ? filesystemSide(opts,directory,'directory')
    : await snapshotRevision(opts,spec,tempParent);
  side.fileSet=new Set(side.files);
  side.scriptImports=new Map();
  return side;
}
function asEntryList(opts,a,b) {
  const inScope = f => opts.scope==='.' || f === opts.scope || f.startsWith(opts.scope+'/');
  const all = new Set([...a.files,...b.files].filter(f=>STYLE_EXT.test(f)&&inScope(f)&&(!path.posix.basename(f).startsWith('_')||/\.css$/i.test(f))));
  if (opts.entries.length) return sort(opts.entries.map(f=>{
    const r=slash(f);
    if (path.isAbsolute(f) || /^[A-Za-z]:\//.test(r)) {
      const candidate=relative(opts.root,ensureUnder(opts.root,f));
      if (a.fileSet.has(candidate)||b.fileSet.has(candidate)) return candidate;
      throw new Error(`--entry not found in either snapshot: ${f}`);
    }
    const rootCandidate=posix(path.normalize(r));
    const scopeCandidate=path.posix.normalize(path.posix.join(opts.scope,r));
    if (a.fileSet.has(rootCandidate) || b.fileSet.has(rootCandidate)) return rootCandidate;
    if (a.fileSet.has(scopeCandidate) || b.fileSet.has(scopeCandidate)) return scopeCandidate;
    throw new Error(`--entry not found in either snapshot: ${f}`);
  }));
  // Underscores denote Sass dependencies by convention, but JS can import one
  // as a standalone entry. Reuse the same compact import scan for order checks.
  for (const side of [a,b]) for (const file of side.files) {
    if (!SCRIPT_EXT.test(file) || !inScope(file)) continue;
    for (const spec of directImports(side,file).styles) {
      for (const target of moduleCandidates(spec,file,side.fileSet)) if (STYLE_EXT.test(target) && inScope(target)) all.add(target);
    }
  }
  return sort(all);
}
function canonicalCss(source, label) {
  const ast=postcss().parse(source,{from:label});
  const nodes=[];
  const blocks=[];
  const declaration=n=>{
    // PostCSS moves * and _ property hacks to the end of raws.before, which
    // can also contain insignificant whitespace and empty declarations.
    const prefix=(n.raws.before||'').match(/[*_]$/)?.[0] || '';
    return [prefix+n.prop,n.value.trim(),!!n.important];
  };
  const selector=n=>selectorParser()().processSync(n.selector,{lossless:false});
  function visit(container,parents) {
    for (const n of (container.nodes||[])) {
      if (n.type === 'comment') continue;
      if (n.type === 'decl') {
        nodes.push(['decl',...declaration(n)]);
      } else if (n.type === 'rule') {
        const normalized=selector(n);
        nodes.push(['rule',normalized]);
        const declarations=(n.nodes||[]).filter(x=>x.type==='decl').map(declaration);
        blocks.push({context:parents,selector:normalized,declarations});
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
function summarizeDifference(before,after) {
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
    }
    for (const b of before.blocks) if (!newBag.has(JSON.stringify(b))) {
      findings.push(`Removed/modified: ${[...b.context,b.selector].join(' > ')}`);
    }
  }
  if (before.nodes.length !== after.nodes.length) findings.push(`CSS AST node counts: ${before.nodes.length} → ${after.nodes.length}`);
  return {reorderedOnly:sameMultiset,findings};
}
function directImports(side,file) {
  if (!side.fileSet.has(file)) return {sequence:[],styles:[]};
  if (side.scriptImports.has(file)) return side.scriptImports.get(file);
  const sf=sourceFile(file,path.join(side.path,file));
  const sequence=[], styles=[];
  const t=ts();
  for (const statement of sf.statements) {
    const specifier=staticModuleSpecifier(statement);
    if (!specifier || !t.isStringLiteral(specifier)) continue;
    if (t.isImportDeclaration(statement) || t.isImportEqualsDeclaration(statement)) sequence.push(specifier.text);
    if (STYLE_EXT.test(specifier.text) || !path.posix.extname(specifier.text)) styles.push(specifier.text);
  }
  function dynamicStyles(node) {
    if (t.isCallExpression(node) && node.expression.kind===t.SyntaxKind.ImportKeyword) {
      const arg=node.arguments[0];
      if (arg && t.isStringLiteralLike(arg) && (STYLE_EXT.test(arg.text) || !path.posix.extname(arg.text))) styles.push(arg.text);
    }
    t.forEachChild(node,dynamicStyles);
  }
  dynamicStyles(sf);
  const result={sequence,styles};
  side.scriptImports.set(file,result); // Retain strings, never repository-wide ASTs.
  return result;
}
function compareStyleImportOrder(opts,baseline,candidate) {
  // React bundlers may have observable order-dependent CSS imports. An identical
  // compiled Sass AST is not sufficient when frontend import order changes.
  const inScope=f=>opts.scope==='.' || f.startsWith(opts.scope+'/');
  const all=sort(new Set([...baseline.files,...candidate.files].filter(f=>SCRIPT_EXT.test(f)&&inScope(f))));
  const findings=[];
  for (const file of all) {
    let before,after;
    try {
      before=directImports(baseline,file).sequence;
      after=directImports(candidate,file).sequence;
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
  // Sass resolves relative imports itself. Only explicitly supplied include paths
  // are valid; root/src/node_modules guesses can rescue invalid imports.
  return [...new Set(explicit)];
}
async function compareCommand(opts, verify=false) {
  const warnings=[], comparisons=[];
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'style-intel-'));
  let compiler=null;
  try {
    const baseline=await prepareSide(opts,opts.baseline,temp), candidate=await prepareSide(opts,opts.candidate,temp);
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
      if (!side.fileSet.has(file)) return {missing:true};
      const abs=ensureUnder(side.path,path.join(side.path,file));
      if (!fs.existsSync(abs)) return {error:'File absent from snapshot despite listing'};
      if (/\.css$/i.test(file)) return {css:fs.readFileSync(abs,'utf8')};
      try {
        const result=await compiler.compileAsync(abs,{style:'expanded',loadPaths:resolveLoadPaths(opts,side),
          sourceMap:false,quietDeps:true,logger:{warn:()=>{},debug:()=>{}}});
        // Absolute imports and external junctions must not bypass snapshot
        // isolation. Inspect actual loaded files, not just configured load paths.
        if (path.relative(opts.root,side.path)!=='') {
          const project=fs.realpathSync.native(opts.root), snapshot=fs.realpathSync.native(side.path);
          for (const url of result.loadedUrls||[]) {
            if (url.protocol!=='file:') continue;
            const loaded=fs.realpathSync.native(fileURLToPath(url));
            const fromSnapshot=path.relative(snapshot,loaded), fromProject=path.relative(project,loaded);
            const inside=p=>p!=='..' && !p.startsWith('..'+path.sep) && !path.isAbsolute(p);
            if (!inside(fromSnapshot) && inside(fromProject) && !fromProject.split(path.sep).includes('node_modules'))
              throw new Error('Snapshot isolation failed: Sass loaded current project source '+loaded+'. Use relative imports or project --load-path values so historical source comes from the snapshot.');
          }
        }
        return {css:result.css};
      } catch(e) {return {error:String(e.message).split('\n').slice(0,5).join(' | ')+'; If the build uses Sass include paths, pass --load-path explicitly.'};}
    }
    for (const entry of entries) {
      const [a,b]=[await compiled(baseline,entry),await compiled(candidate,entry)];
      if (a.error || b.error) {comparisons.push({entry,status:'error',details:`baseline: ${a.error||'OK'}; candidate: ${b.error||'OK'}`});continue;}
      if (a.missing && b.missing) {comparisons.push({entry,status:'error',details:'Entry absent from both snapshots'});continue;}
      let old,next;
      try {
        if (!a.missing) old=canonicalCss(a.css,entry);
        if (!b.missing) next=canonicalCss(b.css,entry);
      }
      catch(e) {comparisons.push({entry,status:'error',details:`CSS parsing failed: ${e.message}`});continue;}
      if (a.missing || b.missing) {comparisons.push({entry,status:'changed',details:a.missing?'Added stylesheet':'Removed stylesheet',
        findings:['Entry exists on only one side']});continue;}
      if (JSON.stringify(old.nodes)===JSON.stringify(next.nodes)) {
        comparisons.push({entry,status:'structurally-equal',rules:next.ruleCount});
      } else {
        const d=summarizeDifference(old,next);
        comparisons.push({entry,status:d.reorderedOnly?'reordered':'changed',
          details:d.reorderedOnly?'Possible cascade change':'CSS AST differs',
          findings:d.findings,rulesBefore:old.ruleCount,rulesAfter:next.ruleCount});
      }
    }
    const importChanges=compareStyleImportOrder(opts,baseline,candidate);
    const stats={compared:comparisons.length,equivalent:comparisons.filter(x=>x.status==='structurally-equal').length,
      changed:comparisons.filter(x=>['changed','reordered'].includes(x.status)).length,
      errors:comparisons.filter(x=>x.status==='error').length,importOrderChanges:importChanges.length};
    const result={tool:'style-intel',version:VERSION,command:verify?'verify':'compare',scope:opts.scope,
      baseline:baseline.kind==='git'?baseline.revision:baseline.kind,
      candidate:candidate.kind==='git'?candidate.revision:candidate.kind,
      summary:`${stats.equivalent}/${stats.compared} static CSS AST comparisons equal; ${importChanges.length} potential CSS import-order changes`,
      verification:{staticCss:true,applicationBuild:false,browser:false},
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
    try {if (compiler) await compiler.dispose();}
    finally {fs.rmSync(temp,{force:true,recursive:true,maxRetries:3,retryDelay:100});}
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
