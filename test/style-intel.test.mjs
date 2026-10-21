import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const CLI=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../style-intel.mjs');

function execute(command,args=[],opts={}) {
  const r=spawnSync(process.execPath,[...(opts.nodeArgs||[]),CLI,command,...args],{cwd:opts.cwd||process.cwd(),
    encoding:'utf8',windowsHide:true,timeout:60000});
  return {status:r.status,stdout:r.stdout,stderr:r.stderr,data:r.stdout.startsWith('{') ? JSON.parse(r.stdout):null};
}
function git(root,args) {
  const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,`git ${args.join(' ')}: ${r.stderr}`);
}
function put(root,file,text) {
  const abs=path.join(root,file);
  fs.mkdirSync(path.dirname(abs),{recursive:true});
  fs.writeFileSync(abs,text,'utf8');
}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'style intel fixture '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:2}));
  put(root,'frontend/package.json',JSON.stringify({name:'frontend',dependencies:{react:'^19.0.0'}}));
  put(root,'backend/customer-service/pom.xml','<project />');
  put(root,'frontend/src/styles/global.css','.customer-card { color: red; }\n.warning { color: orange; }\n');
  put(root,'frontend/src/components/CustomerCard.module.css','.root { display:flex; }\n.warning { color:purple; }\n');
  put(root,'frontend/src/components/Other.module.css','.warning { font-weight:bold; }\n');
  put(root,'frontend/src/components/CustomerCard.tsx',`
import styles from './CustomerCard.module.css';
import '../styles/global.css';
export function CustomerCard({flag}) {
  return <div className={styles.root + ' customer-card'}>
    <p className={flag ? styles.warning : ''}>Here</p>
  </div>;
}
`);
  put(root,'frontend/src/pages/Dashboard.tsx',`
import {CustomerCard} from '../components/CustomerCard';
export function Dashboard(){return <CustomerCard/>;}
`);
  put(root,'frontend/src/App.tsx',`
import {Dashboard} from './pages/Dashboard';
export default function App(){return <Dashboard/>;}
`);
  put(root,'frontend/src/pages/Unrelated.tsx','export function Unrelated(){return null;}');
  put(root,'frontend/src/views/status.html','<div class="customer-card warning">Hi</div>');
  git(root,['init','-q']);
  git(root,['config','user.name','Test']);
  git(root,['config','user.email','test@example.invalid']);
  git(root,['add','.']);
  git(root,['commit','-qm','Initial']);
  return root;
}
const args = root => ['--root',root,'--scope','frontend','--format','json'];

test('inventory detects React and Java manifests in a path containing spaces',t=>{
  const root=fixture(t);
  const run=execute('inventory',['--root',root,'--format','json']);
  assert.equal(run.status,0,run.stderr);
  assert.ok(run.data.projects.some(x=>x.kind==='react-frontend'));
  assert.ok(run.data.projects.some(x=>x.kind==='java-build'));
  assert.equal(run.data.counts.css,3);
});

test('refs maps CSS module property usages to the correct imported module',t=>{
  const root=fixture(t);
  const run=execute('refs',[...args(root),'--selector','.root']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.definitions.length,1);
  assert.ok(run.data.references.some(x=>x.kind==='css-module-property'&&x.definition.endsWith('CustomerCard.module.css')));
});

test('refs distinguishes separate CSS modules and flags unknown usage rather than declaring unused',t=>{
  const root=fixture(t);
  const run=execute('refs',[...args(root),'--selector','.warning','--file','src/components/Other.module.css']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.definitions.length,1);
  assert.equal(run.data.references.length,0);
  assert.ok(run.data.limitations.some(x=>x.includes('never proves')));
});

test('refs sees JSX global selectors and HTML consumers',t=>{
  const root=fixture(t);
  const run=execute('refs',[...args(root),'--selector','.customer-card']);
  assert.equal(run.status,0,run.stderr);
  assert.ok(run.data.references.some(x=>x.kind==='html-class'));
  assert.ok(run.data.references.some(x=>x.kind==='jsx-class-expression'));
});

test('impact walks module consumers to pages and App but not unrelated files',t=>{
  const root=fixture(t);
  const run=execute('impact',[...args(root),'--file','src/components/CustomerCard.module.css']);
  assert.equal(run.status,0,run.stderr);
  assert.ok(run.data.affectedFiles.some(f=>f.endsWith('pages/Dashboard.tsx')));
  assert.ok(run.data.affectedFiles.some(f=>f.endsWith('/App.tsx')));
  assert.ok(!run.data.affectedFiles.some(f=>f.includes('Unrelated.tsx')));
});

for (const selector of ['.root','.customer-card','.warning']) test(`impact ${selector} reads each script once per command`,t=>{
  const root=fixture(t);
  const broken=selector==='.warning';
  if (broken) put(root,'frontend/src/broken.ts','const x = ;');
  const countsFile=path.join(root,'script-reads.json');
  const preload=path.join(root,'count-reads.cjs');
  put(root,'count-reads.cjs',`
const fs=require('node:fs'), path=require('node:path');
const read=fs.readFileSync, counts={};
// Match the CLI's --root spelling; __dirname resolves symlinked temp directories.
const sourceRoot=path.join(${JSON.stringify(root)},'frontend')+path.sep;
fs.readFileSync=function(file,...args) {
  const name=String(file);
  if (name.startsWith(sourceRoot) && /\\.[cm]?[jt]sx?$/i.test(name))
    counts[name]=(counts[name]||0)+1;
  return read.call(this,file,...args);
};
process.on('exit',()=>fs.writeFileSync(${JSON.stringify(countsFile)},JSON.stringify(counts)));
`);
  const run=execute('impact',[...args(root),'--selector',selector],{nodeArgs:['--require',preload]});
  assert.equal(run.status,broken?3:0,run.stderr);
  assert.equal(run.data.complete,!broken);
  assert.ok(run.data.affectedFiles.some(f=>f.endsWith('components/CustomerCard.tsx')));
  assert.ok(run.data.affectedFiles.some(f=>f.endsWith('pages/Dashboard.tsx')));
  assert.ok(run.data.affectedFiles.some(f=>f.endsWith('/App.tsx')));
  assert.ok(!run.data.affectedFiles.some(f=>f.includes('Unrelated.tsx')));
  if (selector==='.customer-card') assert.ok(run.data.affectedFiles.some(f=>f.endsWith('views/status.html')));
  if (broken) {
    assert.ok(run.data.warnings.some(w=>w.startsWith('Unreadable frontend/src/broken.ts:')));
    assert.ok(run.data.warnings.some(w=>w.startsWith('Unreadable source frontend/src/broken.ts:')));
  }
  const counts=JSON.parse(fs.readFileSync(countsFile,'utf8'));
  assert.equal(Object.keys(counts).length,broken?5:4);
  for (const [file,count] of Object.entries(counts)) assert.equal(count,1,`Repeated script read: ${file}`);
});

test('compare reports static equality at HEAD and ignores whitespace/comments',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/global.css','/* A comment */\n.customer-card{color:red}\n.warning {color:orange}\n');
  const run=execute('compare',[...args(root)]);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.changed,0);
  assert.equal(run.data.summaryCounts.errors,0);
  assert.equal(run.data.complete,true);
  assert.equal(run.data.summaryCounts.compared,3);
});

test('verify reports property differences and exits 2',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/global.css','.customer-card { color: blue; }\n.warning { color: orange; }\n');
  const run=execute('verify',[...args(root)]);
  assert.equal(run.status,2,run.stderr);
  assert.equal(run.data.summaryCounts.changed,1);
  assert.ok(run.data.comparisons.some(x=>x.status==='changed'));
});

test('compare recognizes rule-order changes as cascade-sensitive',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/global.css','.warning { color: orange; }\n.customer-card { color: red; }\n');
  const run=execute('compare',[...args(root)]);
  assert.equal(run.status,0,run.stderr);
  assert.ok(run.data.comparisons.some(x=>x.status==='reordered'));
});

test('verify handles removed stylesheets and shows correct status',t=>{
  const root=fixture(t);
  fs.rmSync(path.join(root,'frontend/src/styles/global.css'));
  const run=execute('verify',[...args(root)]);
  assert.equal(run.status,2,run.stderr);
  assert.ok(run.data.comparisons.some(x=>x.details==='Removed stylesheet'));
});

test('rejects paths outside repository',t=>{
  const root=fixture(t);
  const run=execute('impact',[...args(root),'--file','../../../../elsewhere.tsx']);
  assert.equal(run.status,3);
  assert.match(run.stderr,/outside --root/i);
});

test('provides actionable Sass missing dependency diagnostics when dependency is not installed',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/new.scss','a{color:red}');
  const run=execute('compare',[...args(root)]);
  if (run.status===3) assert.match(run.stderr,/sass|install/i);
  else assert.equal(run.status,0,run.stderr); // environment has Sass installed
});

test('verify flags CSS import-order changes even when stylesheet contents are identical',t=>{
  const root=fixture(t);
  put(root,'frontend/src/first.css','.first{color:red}');
  put(root,'frontend/src/second.css','.second{color:blue}');
  put(root,'frontend/src/main.tsx',`import './first.css';\nimport './second.css';\n`);
  git(root,['add','.']);git(root,['commit','-qm','Add style imports']);
  put(root,'frontend/src/main.tsx',`import './second.css';\nimport './first.css';\n`);
  const run=execute('verify',[...args(root)]);
  assert.equal(run.status,2,run.stderr);
  assert.equal(run.data.summaryCounts.changed,0);
  assert.equal(run.data.summaryCounts.importOrderChanges,1);
  assert.ok(run.data.importChanges.some(x=>x.file.endsWith('main.tsx')));
});

test('refs reports unresolved CSS module property expressions',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx',`
import styles from './CustomerCard.module.css';
const state='warning';
export function CustomerCard(){return <div className={styles[state]}/>}
`);
  const run=execute('refs',[...args(root),'--selector','.warning',
    '--file','src/components/CustomerCard.module.css']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.references.length,0);
  assert.ok(run.data.possibleDynamic.some(x=>x.kind==='dynamic-css-module-index'));
});

test('compare accepts a separately captured directory snapshot as baseline',t=>{
  const root=fixture(t);
  const backup=fs.mkdtempSync(path.join(os.tmpdir(),'style intel baseline '));
  t.after(()=>fs.rmSync(backup,{recursive:true,force:true,maxRetries:2}));
  fs.cpSync(path.join(root,'frontend'),path.join(backup,'frontend'),{recursive:true});
  put(root,'frontend/src/styles/global.css','.customer-card{color:green}\n');
  const run=execute('compare',[...args(root),'--baseline',backup]);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.baseline,'directory');
  assert.equal(run.data.summaryCounts.changed,1);
});

test('JSON response limits large evidence arrays and reports truncation',t=>{
  const root=fixture(t);
  const run=execute('inventory',['--root',root,'--format','json','--limit','1']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.projects.length,1);
  assert.ok(run.data.truncated.projects>=1);
});

test('compare --entry only evaluates chosen stylesheet',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/global.css','.changed{color:red}');
  const run=execute('verify',[...args(root),'--entry','src/components/CustomerCard.module.css']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.compared,1);
});

for (const absolute of [false,true]) test(`F1: ${absolute?'absolute':'relative'} project load paths isolate Sass snapshots`,t=>{
  const root=fixture(t);
  put(root,'frontend/shared/_tokens.scss','$color: red;');
  put(root,'frontend/src/styles/main.scss','@use "tokens"; .sample {color: tokens.$color}');
  git(root,['add','.']);git(root,['commit','-qm','Add Sass entry']);
  put(root,'frontend/shared/_tokens.scss','$color: blue;');
  const run=execute('verify',[...args(root),'--entry','src/styles/main.scss',
    '--load-path',absolute?path.join(root,'frontend/shared'):'frontend/shared']);
  assert.equal(run.status,2,run.stderr);
  assert.equal(run.data.summaryCounts.changed,1);
});

test('F1: relative load paths cannot fill missing historical project imports from worktree',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/main.scss','@use "newtokens"; .sample {color: newtokens.$color}');
  git(root,['add','.']);git(root,['commit','-qm','Commit unresolved historical import']);
  put(root,'frontend/shared/_newtokens.scss','$color: blue;');
  const run=execute('verify',[...args(root),'--entry','src/styles/main.scss','--load-path','frontend/shared']);
  assert.equal(run.status,3,run.stderr);
  assert.equal(run.data.complete,false);
  assert.equal(run.data.summaryCounts.errors,1);
});

test('F2: automatically compares underscore-prefixed plain CSS',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/_theme.css','.theme{color:red}');
  put(root,'frontend/src/theme.ts',"import './styles/_theme.css';");
  git(root,['add','.']);git(root,['commit','-qm','Add CSS entry']);
  put(root,'frontend/src/styles/_theme.css','.theme{color:blue}');
  const run=execute('verify',args(root));
  assert.equal(run.status,2,run.stderr);
  assert.ok(run.data.comparisons.some(x=>x.entry.endsWith('_theme.css')&&x.status==='changed'));
});

test('F3: tracked generated styles are ignored on both sides',t=>{
  const root=fixture(t);
  put(root,'frontend/dist/app.css','.generated{color:red}');
  git(root,['add','-f','frontend/dist/app.css']);git(root,['commit','-qm','Track generated CSS']);
  const run=execute('verify',args(root));
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.compared,3);
});

test('F3: Git symlink blobs are excluded rather than reconstructed as CSS',t=>{
  const root=fixture(t);
  const blob=spawnSync('git',['-C',root,'hash-object','-w','--stdin'],{
    input:'src/styles/global.css',encoding:'utf8',windowsHide:true});
  assert.equal(blob.status,0,blob.stderr);
  git(root,['update-index','--add','--cacheinfo',`120000,${blob.stdout.trim()},frontend/link.css`]);
  git(root,['commit','-qm','Track CSS symlink']);
  const run=execute('verify',args(root));
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.compared,3);
});

test('F4: scoped comparisons do not traverse unrelated directories',t=>{
  const root=fixture(t);
  const hook=`import fs from 'node:fs'; import path from 'node:path';
    const original=fs.readdirSync;
    fs.readdirSync=function(dir,...rest){
      if(path.basename(String(dir))==='backend') throw new Error('Unrelated directory was traversed');
      return original.call(this,dir,...rest);
    };`;
  const r=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(hook)}`,
    CLI,'verify',...args(root)],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(r.status,0,r.stderr);
  assert.equal(JSON.parse(r.stdout).summaryCounts.compared,3);
});

test('F5: CSS module references respect parameter, block, and function hoisting shadows',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx',`
    import styles from './CustomerCard.module.css';
    function parameter(styles){return <div className={styles.warning}/>;}
    function block(){ { const styles={warning:'local'}; return styles['warning']; } }
    function hoisted(){ return styles.warning; var styles; }
    export const actual=styles.warning;
  `);
  const run=execute('refs',[...args(root),'--selector','.warning','--file','src/components/CustomerCard.module.css']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.references.length,1);
  assert.equal(run.data.references[0].line,6);
});

test('F6: rejects a scope junction or symlink outside root, including nested scopes',t=>{
  const root=fixture(t);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'style intel external '));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true,maxRetries:2}));
  put(outside,'nested/outside.css','.outside{color:red}');
  const link=path.join(root,'external');
  try {fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');}
  catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip(e.message);return;}throw e;}
  try {
    for(const scope of ['external','external/nested']) {
      const run=execute('inventory',['--root',root,'--scope',scope,'--format','json']);
      assert.equal(run.status,3,run.stderr);
      assert.match(run.stderr,/symlink|symbolic|outside --root/i);
    }
    for(const command of ['impact','verify']) {
      const run=execute(command,[...args(root),command==='impact'?'--file':'--entry',path.join(link,'nested/outside.css')]);
      assert.equal(run.status,3,run.stderr);
      assert.match(run.stderr,/symlink|symbolic|outside --root/i);
    }
  } finally {
    // Unlink before fixture cleanup, without traversing the external target.
    fs.unlinkSync(link);
  }
});

for (const command of ['refs','impact','verify']) test(`F7: ${command} rejects incomplete JS/TS parsing`,t=>{
  const root=fixture(t);
  put(root,'frontend/src/broken.ts','const x = ;');
  const extra=command==='refs'?['--selector','.warning']:
    command==='impact'?['--file','src/styles/global.css']:[];
  const run=execute(command,[...args(root),...extra]);
  assert.equal(run.status,3,run.stderr);
  if(run.data){assert.equal(run.data.complete,false);assert.match(run.data.warnings.join('\n'),/broken.ts/);}
  else assert.match(run.stderr,/broken.ts/);
});

test('F8: absolute entries missing from both sides are invalid arguments',t=>{
  const root=fixture(t);
  const run=execute('verify',[...args(root),'--entry',path.join(root,'frontend/missing.css')]);
  assert.equal(run.status,3,run.stderr);
  assert.match(run.stderr,/not found in either snapshot/i);
});

for (const loadPath of ['external','node_modules']) test(`F1: preserves shared ${loadPath} Sass dependencies`,t=>{
  const root=fixture(t);
  const external=fs.mkdtempSync(path.join(os.tmpdir(),'style intel Sass dependency '));
  t.after(()=>fs.rmSync(external,{recursive:true,force:true,maxRetries:2}));
  const dependency=loadPath==='external'?external:path.join(root,'frontend/node_modules/theme');
  put(dependency,'_tokens.scss','$color: red;');
  put(root,'frontend/src/styles/main.scss','@use "tokens"; .sample{color:tokens.$color}');
  git(root,['add','frontend/src/styles/main.scss']);git(root,['commit','-qm','Add shared dependency import']);
  const run=execute('verify',[...args(root),'--entry','src/styles/main.scss','--load-path',dependency]);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.equivalent,1);
});

test('F4: scoped Sass entries can use checked-in dependencies outside scope',t=>{
  const root=fixture(t);
  put(root,'shared/_tokens.scss','$color: red;');
  put(root,'frontend/src/styles/main.scss','@use "tokens"; .sample{color:tokens.$color}');
  git(root,['add','.']);git(root,['commit','-qm','Add out of scope Sass dependency']);
  put(root,'shared/_tokens.scss','$color: blue;');
  const run=execute('verify',[...args(root),'--entry','src/styles/main.scss','--load-path','shared']);
  assert.equal(run.status,2,run.stderr);
  assert.equal(run.data.summaryCounts.changed,1);
});

test('F8: absolute entries present on only one side retain addition and removal reports',t=>{
  const root=fixture(t);
  const removed=path.join(root,'frontend/src/styles/global.css');
  fs.unlinkSync(removed);
  put(root,'frontend/added.css','.added{color:blue}');
  const run=execute('verify',[...args(root),'--entry',removed,'--entry',path.join(root,'frontend/added.css')]);
  assert.equal(run.status,2,run.stderr);
  assert.equal(run.data.summaryCounts.changed,2);
  assert.ok(run.data.comparisons.some(x=>x.details==='Added stylesheet'));
  assert.ok(run.data.comparisons.some(x=>x.details==='Removed stylesheet'));
});


test('F4: scope-relative explicit entries may point to a sibling within root',t=>{
  const root=fixture(t);
  put(root,'shared/entry.css','.shared{color:red}');
  git(root,['add','.']);git(root,['commit','-qm','Add sibling CSS entry']);
  const run=execute('verify',[...args(root),'--entry','../shared/entry.css']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.compared,1);
  assert.equal(run.data.comparisons[0].entry,'shared/entry.css');
});

test('R1: ignored tracked Sass remains available as a snapshot dependency',t=>{
  const root=fixture(t);
  put(root,'frontend/vendor/_tokens.scss','$color: red;');
  put(root,'frontend/src/main.scss','@use "../vendor/tokens"; .sample{color:tokens.$color}');
  git(root,['add','-f','frontend/vendor/_tokens.scss','frontend/src/main.scss']);
  git(root,['commit','-qm','Add ignored Sass dependency']);
  const unchanged=execute('verify',args(root));
  assert.equal(unchanged.status,0,unchanged.stderr);
  assert.equal(unchanged.data.summaryCounts.compared,4);
  assert.ok(unchanged.data.comparisons.every(x=>!x.entry.includes('/vendor/')));
  put(root,'frontend/vendor/_tokens.scss','$color: blue;');
  const changed=execute('verify',args(root));
  assert.equal(changed.status,2,changed.stderr);
  assert.ok(changed.data.comparisons.some(x=>x.entry==='frontend/src/main.scss'&&x.status==='changed'));
});

test('R2: excludes materialized Git symlink placeholders from worktree comparisons',t=>{
  const root=fixture(t);
  git(root,['config','core.symlinks','false']);
  const blob=spawnSync('git',['-C',root,'hash-object','-w','--stdin'],{
    input:'src/styles/global.css',encoding:'utf8',windowsHide:true});
  assert.equal(blob.status,0,blob.stderr);
  git(root,['update-index','--add','--cacheinfo',`120000,${blob.stdout.trim()},frontend/link.css`]);
  git(root,['commit','-qm','Track CSS symlink']);
  git(root,['checkout-index','--force','--','frontend/link.css']);
  assert.equal(fs.lstatSync(path.join(root,'frontend/link.css')).isSymbolicLink(),false);
  assert.equal(fs.readFileSync(path.join(root,'frontend/link.css'),'utf8'),'src/styles/global.css');
  const run=execute('verify',args(root));
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.compared,3);
  const explicit=execute('verify',[...args(root),'--entry','link.css']);
  assert.equal(explicit.status,3,explicit.stderr);
  assert.match(explicit.stderr,/not found in either snapshot/);
});


test('R2: directory-only comparisons work without Git metadata',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'style intel no Git '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:2}));
  put(root,'main.css','.sample{color:red}');
  const run=execute('verify',['--root',root,'--baseline','worktree','--format','json']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.summaryCounts.equivalent,1);
});


for (const missingSheet of [false,true]) test('CSS Module usages survive missing '+(missingSheet?'stylesheet':'selector definitions'),t=>{
  const root=fixture(t);
  const sheet=missingSheet?'Gone.module.css':'CustomerCard.module.css';
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'import styles from "./'+sheet+'";',
    'import other from "./Other.module.css";',
    'export const a=styles.absent;',
    'export const b=styles["absent"];',
    'export const c=other.absent;',
    'function shadow(styles){return styles.absent;}',
  ].join('\n'));
  const scoped=[...args(root),'--selector','.absent','--file','src/components/'+sheet];
  const run=execute('refs',scoped);
  assert.equal(run.status,missingSheet?3:0,run.stderr);
  assert.equal(run.data.definitions.length,0);
  assert.deepEqual(run.data.references.map(r=>r.line),[3,4]);
  for(const ref of run.data.references){
    assert.equal(ref.definitionFound,false);
    assert.equal(ref.stylesheet,'frontend/src/components/'+sheet);
    assert.equal(ref.definition,ref.stylesheet);
  }
  if(missingSheet) assert.match(run.data.warnings.join('\n'),/Unresolved relative import/);
  const impact=execute('impact',scoped);
  assert.equal(impact.status,missingSheet?3:0,impact.stderr);
  assert.ok(impact.data.affectedFiles.includes('frontend/src/App.tsx'));
  assert.equal(impact.data.selectorEvidence.references,2);
  assert.deepEqual(impact.data.input,{selector:'.absent',file:'frontend/src/components/'+sheet});
});

test('CSS Module references report matched definitions separately',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx','import s from "./CustomerCard.module.css";\nexport const a=s.absent;\nexport const b=s.warning;');
  const missing=execute('refs',[...args(root),'--selector','.absent']);
  assert.equal(missing.status,0,missing.stderr);
  assert.equal(missing.data.references.length,1);
  assert.equal(missing.data.references[0].definitionFound,false);
  const found=execute('refs',[...args(root),'--selector','.warning','--file','src/components/CustomerCard.module.css']);
  assert.equal(found.status,0,found.stderr);
  assert.equal(found.data.references[0].definitionFound,true);
});

test('HTML class evidence ignores comments, raw text, data attributes, and quoted markup',t=>{
  const root=fixture(t);
  put(root,'frontend/src/views/status.html',[
    '<!-- <div class="warning"> -->',
    '<div data-class="warning" title="class=warning"></div>',
    '<script>const template = "<div class=warning>";</script>',
    '<style>.x::after{content:"<b class=warning>"}</style>',
    '<textarea><span class=warning></textarea>',
    '<div title="<span class=warning>"></div>',
    '<DIV CLASS=warning>real</DIV>',
    '<div\n class="warning other">real</div>',
    '<!-- <div class="warning">',
  ].join('\n'));
  const run=execute('refs',[...args(root),'--selector','.warning','--file','src/styles/global.css']);
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(run.data.references.filter(r=>r.kind==='html-class').map(r=>r.line),[7,9]);
});

test('JSX global evidence excludes module keys, other attributes, conditions and comment text',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'import styles from "./CustomerCard.module.css";',
    '// "warning"',
    'const mapping={"warning":true};',
    'export const a=<div title="warning" data-class="warning"/>;',
    'export const b=<div className={styles["warning"]}/>;',
    'export const c=<div className={state === "warning" ? "other" : ""}/>;',
    'export const d=<div className={cx({warning: state === "warning"})}/>;',
    'export const e=<div className={cx(styles["warning"], "warning")}/>;',
    'export const text="warning";',
  ].join('\n'));
  const run=execute('refs',[...args(root),'--selector','.warning','--file','src/styles/global.css']);
  assert.equal(run.status,0,run.stderr);
  const refs=run.data.references.filter(r=>r.file.endsWith('CustomerCard.tsx'));
  assert.deepEqual(refs.map(r=>[r.line,r.kind]),[[7,'class-object-key'],[8,'jsx-class-expression'],[9,'unclassified-string']]);
});

test('template segments require complete class token boundaries',t=>{
  const root=fixture(t), tick=String.fromCharCode(96);
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'export const a=<div className={'+tick+'warning$'+'{suffix}'+tick+'}/>;',
    'export const b=<div className={'+tick+'warning $'+'{suffix}'+tick+'}/>;',
    'export const c=<div className={'+tick+'$'+'{prefix}warning'+tick+'}/>;',
  ].join('\n'));
  const run=execute('refs',[...args(root),'--selector','.warning','--file','src/styles/global.css']);
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(run.data.references.filter(r=>r.file.endsWith('CustomerCard.tsx')&&r.confidence==='probable').map(r=>r.line),[2]);
});

for (const prefix of ['*','_']) test('CSS comparison retains significant '+prefix+' declaration prefix',t=>{
  const root=fixture(t);
  put(root,'frontend/src/styles/global.css','.warning{'+prefix+'color:red}');
  git(root,['add','.']);git(root,['commit','-qm','Prefixed declaration']);
  put(root,'frontend/src/styles/global.css','.warning{color:red}');
  const run=execute('verify',[...args(root),'--entry','src/styles/global.css']);
  assert.equal(run.status,2,run.stderr);
  assert.equal(run.data.summaryCounts.changed,1);
});

test('CSS selector formatting is insignificant while combinators and quoted values matter',t=>{
  const root=fixture(t),entry='frontend/src/styles/global.css';
  put(root,entry,'.warning  > .child , [data-x="a  b"] { color: red }');
  git(root,['add','.']);git(root,['commit','-qm','Selector fixture']);
  put(root,entry,'.warning>.child,[data-x="a  b"]{color:red}');
  const equal=execute('verify',[...args(root),'--entry',entry]);
  assert.equal(equal.status,0,equal.stderr);
  assert.deepEqual(equal.data.verification,{staticCss:true,applicationBuild:false,browser:false});
  for(const css of ['.warning .child,[data-x="a  b"]{color:red}', '.warning>.child,[data-x="a b"]{color:red}']) {
    put(root,entry,css);
    const changed=execute('verify',[...args(root),'--entry',entry]);
    assert.equal(changed.status,2,changed.stderr);
  }
});

for(const side of ['both','added','removed']) test('Malformed '+side+' CSS is incomplete verification',t=>{
  const root=fixture(t),entry='frontend/broken.css';
  if(side!=='added') {
    put(root,entry,'.broken { color: red;');
    git(root,['add','.']);git(root,['commit','-qm','Broken CSS']);
  }
  if(side==='removed') fs.unlinkSync(path.join(root,entry));
  else put(root,entry,'.broken { color: blue;');
  const run=execute('verify',[...args(root),'--entry',entry]);
  assert.equal(run.status,3,run.stderr);
  assert.equal(run.data.complete,false);
  assert.equal(run.data.comparisons[0].status,'error');
  assert.match(run.data.comparisons[0].details,/CSS parsing failed/);
});

for(const loadPath of ['.','frontend','frontend/src','frontend/node_modules/theme']) test('Sass requires explicit include path '+loadPath,t=>{
  const root=fixture(t);
  put(root,loadPath+'/_tokens.scss','$color:red;');
  put(root,'frontend/src/styles/main.scss','@use "tokens"; .warning{color:tokens.$color}');
  git(root,['add','-f',loadPath+'/_tokens.scss','frontend/src/styles/main.scss']);
  git(root,['commit','-qm','Sass path fixture']);
  const implicit=execute('verify',[...args(root),'--entry','src/styles/main.scss']);
  assert.equal(implicit.status,3,implicit.stderr);
  assert.match(implicit.data.comparisons[0].details,/--load-path/);
  const explicit=execute('verify',[...args(root),'--entry','src/styles/main.scss','--load-path',loadPath]);
  assert.equal(explicit.status,0,explicit.stderr);
});

test('relative imports resolve emitted JS extensions and mts/cts index files conservatively',t=>{
  const root=fixture(t);
  put(root,'frontend/src/source.ts','export const source=1;');
  put(root,'frontend/src/esm.mts','export {source} from "./source.js";');
  put(root,'frontend/src/cjs.cts','export {source} from "./esm.mjs";');
  put(root,'frontend/src/folder/index.mts','export {source} from "../cjs.cjs";');
  put(root,'frontend/src/top.ts','export {source} from "./folder";');
  const run=execute('impact',[...args(root),'--file','src/source.ts']);
  assert.equal(run.status,0,run.stderr);
  for(const file of ['source.ts','esm.mts','cjs.cts','folder/index.mts','top.ts'])
    assert.ok(run.data.affectedFiles.includes('frontend/src/'+file));
  put(root,'frontend/src/esm.mjs','export const source=2;');
  const exact=execute('impact',[...args(root),'--file','src/source.ts']);
  assert.equal(exact.status,0,exact.stderr);
  assert.ok(!exact.data.affectedFiles.includes('frontend/src/cjs.cts'));
});

for(const command of ['refs','impact']) test(command+' reports unresolved relative imports as incomplete',t=>{
  const root=fixture(t);
  put(root,'frontend/src/unresolved.ts','export {x} from "./missing.js";');
  const run=execute(command,[...args(root),...(command==='refs'?['--selector','.warning']:['--file','src/styles/global.css'])]);
  assert.equal(run.status,3,run.stderr);
  assert.equal(run.data.complete,false);
  assert.match(run.data.warnings.join('\n'),/missing.js/);
});

test('evidence totals include all dynamic and speculative references before output limits',t=>{
  const root=fixture(t);
  put(root,'frontend/src/many.ts','import styles from "./components/CustomerCard.module.css";\n'+
    Array.from({length:350},(_,i)=>'const d'+i+'=styles[key'+i+'];').join('\n')+'\n'+
    Array.from({length:75},(_,i)=>'const s'+i+'="warning";').join('\n'));
  const run=execute('refs',[...args(root),'--selector','.warning','--limit','10']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.totals.possibleDynamic,350);
  assert.equal(run.data.truncated.possibleDynamic,340);
  assert.ok(run.data.totals.references>=75);
  assert.equal(run.data.references.length,10);
});

test('inventory no longer silently caps project manifests at 200',t=>{
  const root=fixture(t);
  for(let i=0;i<205;i++) put(root,'packages/p'+i+'/package.json','{}');
  const run=execute('inventory',['--root',root,'--format','json','--limit','201']);
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.data.totals.projects,207);
  assert.equal(run.data.projects.length,201);
  assert.equal(run.data.truncated.projects,6);
  assert.equal(run.data.totals.sampleStyles,3);
});

test('nested CSS findings report accurate totals and truncation',t=>{
  const root=fixture(t),entry='frontend/src/styles/global.css';
  put(root,entry,Array.from({length:8},(_,i)=>'.c'+i+'{color:red}').join('\n'));
  git(root,['add','.']);git(root,['commit','-qm','Many rules']);
  put(root,entry,Array.from({length:8},(_,i)=>'.c'+i+'{color:blue}').join('\n'));
  const run=execute('verify',[...args(root),'--entry',entry,'--limit','2']);
  assert.equal(run.status,2,run.stderr);
  const result=run.data.comparisons[0];
  assert.equal(result.findingCount,17);
  assert.equal(result.findings.length,2);
  assert.equal(result.truncatedFindings,15);
});


test('impact follows static import() and reports computed imports and require calls',t=>{
  const root=fixture(t);
  put(root,'frontend/src/lazy.ts','export const page=import("./pages/Dashboard.js");');
  const good=execute('impact',[...args(root),'--file','src/components/CustomerCard.module.css']);
  assert.equal(good.status,0,good.stderr||good.stdout);
  assert.ok(good.data.affectedFiles.includes('frontend/src/lazy.ts'));
  put(root,'frontend/src/dynamic.ts','const a=import(name); const b=require("./lazy");');
  const incomplete=execute('impact',[...args(root),'--file','src/components/CustomerCard.module.css']);
  assert.equal(incomplete.status,3,incomplete.stderr||incomplete.stdout);
  assert.equal(incomplete.data.complete,false);
  assert.match(incomplete.data.warnings.join('\n'),/computed import/);
  assert.match(incomplete.data.warnings.join('\n'),/require/);
});

test('CSS Module usages in other JSX attributes remain discoverable',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx','import styles from "./CustomerCard.module.css";\nexport const a=<div title={styles.absent} data-value={styles["absent"]}/>;');
  const run=execute('refs',[...args(root),'--selector','.absent']);
  assert.equal(run.status,0,run.stderr||run.stdout);
  assert.deepEqual(run.data.references.map(r=>r.kind).sort(),['css-module-element','css-module-property']);
});

test('CSS comparison preserves declaration ordering, importance, and at-rule parameters',t=>{
  const root=fixture(t), entry='frontend/src/styles/global.css';
  put(root,entry,'@media (min-width: 10px){.x{color:red;color:blue}}');
  git(root,['add','.']);git(root,['commit','-qm','Cascade fixture']);
  for(const css of [
    '@media (min-width: 10px){.x{color:blue;color:red}}',
    '@media (min-width: 10px){.x{color:red!important;color:blue}}',
    '@media (min-width: 11px){.x{color:red;color:blue}}',
  ]) {
    put(root,entry,css);
    const run=execute('verify',[...args(root),'--entry',entry]);
    assert.equal(run.status,2,run.stderr||run.stdout);
  }
});

for(const failure of ['snapshot write','compiler disposal']) test('comparison cleans temporary snapshots after '+failure+' failure',t=>{
  const root=fixture(t),log=path.join(root,'temps.json');
  if(failure==='compiler disposal') put(root,'frontend/main.scss','.x{color:red}');
  const hook=(
    "const fs=require('node:fs'),path=require('node:path'); const original=fs.mkdtempSync; let temp;\n"+
    "fs.mkdtempSync=function(prefix,...args){const dir=original.call(this,prefix,...args);if(path.basename(String(prefix))==='style-intel-'){temp=dir;fs.writeFileSync("+JSON.stringify(log)+",JSON.stringify(dir));}return dir;};\n"+
    (failure==='snapshot write' ?
      "const open=fs.openSync;fs.openSync=function(file,...args){if(temp&&String(file).startsWith(temp+path.sep)&&String(file).endsWith('.css'))throw new Error('synthetic snapshot write failure');return open.call(this,file,...args);};" :
      "const Module=require('node:module'),load=Module._load;Module._load=function(id,...args){if(id==='sass-embedded')return {initAsyncCompiler:async()=>({compileAsync:async()=>({css:'.x{color:red}'}),dispose:async()=>{throw new Error('synthetic compiler disposal failure');}})};return load.call(this,id,...args);};")
  );
  put(root,'failure-hook.cjs',hook);
  const run=execute('verify',args(root),{nodeArgs:['--require',path.join(root,'failure-hook.cjs')]});
  assert.equal(run.status,3,run.stderr||run.stdout);
  assert.match(run.stderr,/synthetic/);
  const temp=JSON.parse(fs.readFileSync(log,'utf8'));
  assert.equal(path.dirname(temp),os.tmpdir());
  assert.ok(path.basename(temp).startsWith('style-intel-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true,maxRetries:3}));
  assert.equal(fs.existsSync(temp),false);
});

test('import sequence output limits include nested counts',t=>{
  const root=fixture(t);
  put(root,'frontend/src/imports.ts',Array.from({length:5},(_,i)=>'import "./s'+i+'.css";').join('\n'));
  git(root,['add','.']);git(root,['commit','-qm','Import sequence fixture']);
  put(root,'frontend/src/imports.ts',Array.from({length:5},(_,i)=>'import "./s'+(4-i)+'.css";').join('\n'));
  const run=execute('verify',[...args(root),'--limit','2']);
  assert.equal(run.status,2,run.stderr||run.stdout);
  const change=run.data.importChanges[0];
  assert.equal(change.beforeCount,5);
  assert.equal(change.afterCount,5);
  assert.equal(change.before.length,2);
  assert.equal(change.truncatedBefore,3);
  assert.equal(change.truncatedAfter,3);
});


test('absolute Sass imports cannot load missing historical project source from worktree',t=>{
  const root=fixture(t),tokens=path.join(root,'frontend/shared/_tokens.scss');
  put(root,'frontend/main.scss','@use "'+tokens.replaceAll('\\','/').replace(/^[A-Za-z]:/,'')+'" as tokens; .x{color:tokens.$color}');
  git(root,['add','.']);git(root,['commit','-qm','Absolute Sass import']);
  put(root,'frontend/shared/_tokens.scss','$color:blue;');
  const current=execute('verify',[...args(root),'--baseline','worktree','--entry','main.scss']);
  assert.equal(current.status,0,current.stderr||current.stdout);
  const historical=execute('verify',[...args(root),'--entry','main.scss']);
  assert.equal(historical.status,3,historical.stderr||historical.stdout);
  assert.equal(historical.data.complete,false);
  assert.match(historical.data.comparisons[0].details,/Snapshot isolation failed/);
});

test('external Sass load-path junctions cannot alias current project source into history',t=>{
  const root=fixture(t), external=fs.mkdtempSync(path.join(os.tmpdir(),'style intel alias '));
  t.after(()=>fs.rmSync(external,{recursive:true,force:true,maxRetries:3}));
  put(root,'frontend/main.scss','@use "tokens"; .x{color:tokens.$color}');
  git(root,['add','.']);git(root,['commit','-qm','Unresolved historical Sass import']);
  put(root,'frontend/shared/_tokens.scss','$color:blue;');
  const alias=path.join(external,'source');
  try {fs.symlinkSync(path.join(root,'frontend/shared'),alias,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip(error.message);return;}throw error;}
  try {
    const run=execute('verify',[...args(root),'--entry','main.scss','--load-path',alias]);
    assert.equal(run.status,3,run.stderr||run.stdout);
    assert.equal(run.data.complete,false);
    assert.match(run.data.comparisons[0].details,/Snapshot isolation failed/);
  } finally {fs.unlinkSync(alias);}
});


test('computed CSS Module indices retain nested static module references',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'import styles from "./CustomerCard.module.css";',
    'import other from "./Other.module.css";',
    'export const a=<div className={styles[other.absent]}/>;',
  ].join('\n'));
  const run=execute('refs',[...args(root),'--selector','.absent','--file','src/components/Other.module.css']);
  assert.equal(run.status,0,run.stderr||run.stdout);
  assert.equal(run.data.references.length,1);
  assert.equal(run.data.references[0].stylesheet,'frontend/src/components/Other.module.css');
  assert.equal(run.data.references[0].definitionFound,false);
});


// Review remediation: R1 preserves class values without treating keys or
// predicates as class tokens, and keeps interpolation boundaries significant.
test('R1: refs and impact retain class values in interpolations and indexed arrays',t=>{
  const root=fixture(t), tick=String.fromCharCode(96);
  const expression='flag ? "warning" : ""';
  const interpolate=(before,value,after)=>tick+before+'$'+'{'+value+'}'+after+tick;
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'import styles from "./CustomerCard.module.css";',
    'export function CustomerCard(){return <div className={'+interpolate('',expression,'')+'}/>;}',
    'export const spaced=<div className={'+interpolate('base ',expression,' tail')+'}/>;',
    'export const indexed=<div className={["warning","other"][index]}/>;',
    'export const predicate=<div className={'+interpolate('','state === "warning" ? "other" : ""','')+'}/>;',
    'export const key=<div className={lookup["warning"]}/>;',
    'export const prefix=<div className={'+interpolate('prefix',expression,'')+'}/>;',
    'export const suffix=<div className={'+interpolate('',expression,'suffix')+'}/>;',
    'export const moduleKey=<div className={'+interpolate('','styles["warning"]','')+'}/>;',
  ].join('\n'));
  const scoped=[...args(root),'--selector','.warning','--file','src/styles/global.css'];
  const refs=execute('refs',scoped);
  assert.equal(refs.status,0,refs.stderr||refs.stdout);
  assert.deepEqual(refs.data.references.filter(r=>r.file.endsWith('CustomerCard.tsx')).map(r=>r.line),[2,3,4]);
  const impact=execute('impact',scoped);
  assert.equal(impact.status,0,impact.stderr||impact.stdout);
  assert.ok(impact.data.affectedFiles.includes('frontend/src/App.tsx'));
});

for(const hacks of [false,true]) test('R2: empty CSS declarations preserve equality'+(hacks?' alongside property hacks':''),t=>{
  const root=fixture(t), entry='frontend/src/styles/global.css';
  const normal=hacks?'.a{*color:red;_width:1px}':'.a{color:red;background:blue}';
  put(root,entry,normal);
  git(root,['add','.']);git(root,['commit','-qm','Empty declaration regression baseline']);
  const variants=hacks?['.a{;*color:red;;_width:1px;;}']:
    ['.a{;color:red;background:blue}', '.a{color:red;;background:blue}', '.a{;; color:red;\n; background:blue;;}'];
  for(const css of variants) {
    put(root,entry,css);
    const run=execute('verify',[...args(root),'--entry',entry]);
    assert.equal(run.status,0,run.stderr||run.stdout);
    assert.equal(run.data.comparisons[0].status,'structurally-equal');
  }
});

test('R3: local require bindings do not mark static analysis incomplete',t=>{
  const root=fixture(t);
  put(root,'frontend/src/local-loader.ts','export default function require(value){return value;}');
  put(root,'frontend/src/imported-loader.ts','import require from "./local-loader"; export const value=require("field");');
  put(root,'frontend/src/local-require.ts',[
    'export function parameter(require){require("field");}',
    'export function block(){ {const require=value=>value;require("field");} }',
    'export function hoisted(){require("field");var require=value=>value;}',
    'export function named(){require("field");function require(value){return value;}}',
    'export function caught(){try{}catch({require}){require("field");}}',
    'export function factoryShadow(createRequire){const require=createRequire();require("field");}',
  ].join('\n'));
  for(const command of ['refs','impact']) {
    const run=execute(command,[...args(root),'--selector','.warning']);
    assert.equal(run.status,0,run.stderr||run.stdout);
    assert.equal(run.data.complete,true);
    assert.ok(!run.data.warnings.some(w=>/Unsupported require/.test(w)));
  }
});

for(const declaration of ['', 'declare function require(id:string):unknown;\n'])
  test('R3: '+(declaration?'ambient':'unbound')+' require calls remain unsupported',t=>{
    const root=fixture(t);
    put(root,'frontend/src/module-loader.ts',declaration+'export const value=require("./missing");');
    const run=execute('impact',[...args(root),'--selector','.warning']);
    assert.equal(run.status,3,run.stderr||run.stdout);
    assert.equal(run.data.complete,false);
    assert.match(run.data.warnings.join('\n'),/Unsupported require/);
  });


for(const factory of ['named','namespace']) test('R3: Node createRequire '+factory+' loaders remain unsupported',t=>{
  const root=fixture(t);
  const source=factory==='named' ?
    'import {createRequire as makeRequire} from "node:module"; const require=makeRequire(import.meta.url);' :
    'import * as Module from "node:module"; const require=Module.createRequire(import.meta.url);';
  put(root,'frontend/src/node-loader.ts',source+'require("./missing");');
  const run=execute('impact',[...args(root),'--selector','.warning']);
  assert.equal(run.status,3,run.stderr||run.stdout);
  assert.equal(run.data.complete,false);
  assert.match(run.data.warnings.join('\n'),/Unsupported require/);
});

test('review R1: imported underscore Sass entries are compared and scripts are read once',t=>{
  const root=fixture(t);
  for (const [name,source] of [
    ['static',"import './styles/_static';"],
    ['dynamic',"export const theme=import('./styles/_dynamic.scss');"],
    ['equals',"import theme = require('./styles/_equals.sass');"],
  ]) put(root,`frontend/src/${name}.ts`,source);
  for (const name of ['static','dynamic']) put(root,`frontend/src/styles/_${name}.scss`,'.warning{color:red}');
  put(root,'frontend/src/styles/_equals.sass','.warning\n  color: red\n');
  put(root,'shared/_outside.scss','.outside{color:red}');
  put(root,'frontend/src/outside.ts','import "../../shared/_outside.scss";');
  // Unimported partials must stay dependencies rather than automatic entries.
  put(root,'frontend/src/styles/_unused.scss','@error "not an entry";');
  git(root,['add','.']);git(root,['commit','-qm','Direct Sass entries']);
  for (const name of ['static','dynamic']) put(root,`frontend/src/styles/_${name}.scss`,'.warning{color:blue}');
  put(root,'frontend/src/styles/_equals.sass','.warning\n  color: blue\n');
  const hook=`import fs from 'node:fs';const read=fs.readFileSync,counts=new Map();
    fs.readFileSync=function(file,...rest){const name=String(file);if(/\\.(?:tsx?|jsx?)$/.test(name))counts.set(name,(counts.get(name)||0)+1);return read.call(this,file,...rest);};
    process.on('exit',()=>{for(const [name,count]of counts)if(count>1)console.error('REPEATED_SCRIPT_READ '+name+' '+count);});`;
  const run=execute('verify',args(root),{nodeArgs:['--import',`data:text/javascript,${encodeURIComponent(hook)}`]});
  assert.equal(run.status,2,run.stderr||run.stdout);
  assert.equal(run.data.summaryCounts.changed,3);
  assert.equal(run.data.summaryCounts.compared,6);
  assert.equal(run.data.complete,true);
  assert.ok(run.data.comparisons.every(c=>c.entry.startsWith('frontend/')));
  assert.ok(!run.data.comparisons.some(c=>c.entry.includes('_unused')));
  assert.doesNotMatch(run.stderr,/REPEATED_SCRIPT_READ/);
});

test('review R2: extensionless TypeScript imports prefer ts to tsx for files and indexes',t=>{
  const root=fixture(t);
  for (const stem of ['Choice','folder/index']) {
    put(root,`frontend/src/${stem}.ts`,"import './"+(stem.includes('/')?'../':'')+"styles/global.css'; export const choice=1;");
    put(root,`frontend/src/${stem}.tsx`,"import './"+(stem.includes('/')?'../':'')+"components/Other.module.css'; export const choice=2;");
  }
  put(root,'frontend/src/ResolutionApp.tsx','import {choice} from "./Choice"; import "./folder";');
  const actual=execute('impact',[...args(root),'--file','src/styles/global.css']);
  assert.equal(actual.status,0,actual.stderr);
  assert.ok(actual.data.affectedFiles.includes('frontend/src/ResolutionApp.tsx'));
  const other=execute('impact',[...args(root),'--file','src/components/Other.module.css']);
  assert.equal(other.status,0,other.stderr);
  assert.ok(!other.data.affectedFiles.includes('frontend/src/ResolutionApp.tsx'));
});

test('review R3: import-equals bindings support CSS Module evidence, shadowing and reverse edges',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'import styles = require("./CustomerCard.module.css");',
    'export const CustomerCard=()=> <div className={styles.warning}/>;',
    'function shadow(styles){return styles.warning;}',
  ].join('\n'));
  put(root,'frontend/src/EqualsApp.tsx','import Card = require("./components/CustomerCard"); export const value=Card;');
  const refs=execute('refs',[...args(root),'--selector','.warning','--file','src/components/CustomerCard.module.css']);
  assert.equal(refs.status,0,refs.stderr);
  assert.deepEqual(refs.data.references.map(r=>r.line),[2]);
  const impact=execute('impact',[...args(root),'--file','src/components/CustomerCard.module.css']);
  assert.equal(impact.status,0,impact.stderr);
  assert.ok(impact.data.affectedFiles.includes('frontend/src/EqualsApp.tsx'));
  put(root,'frontend/src/unresolved.ts','import missing = require("./missing.js");');
  const incomplete=execute('impact',[...args(root),'--file','src/components/CustomerCard.module.css']);
  assert.equal(incomplete.status,3,incomplete.stderr);
  assert.match(incomplete.data.warnings.join('\n'),/Unresolved relative import.*missing.js/);
});

test('review R4: transparent CSS Module receiver wrappers preserve references and shadowing',t=>{
  const root=fixture(t);
  put(root,'frontend/src/components/CustomerCard.tsx',[
    'import styles from "./CustomerCard.module.css";',
    'export const CustomerCard=()=> <div className={(styles).warning}/>;',
    'export const a=styles!.warning;',
    'export const b=(styles as Record<string,string>).warning;',
    'export const c=(styles satisfies Record<string,string>)["warning"];',
    'function shadow(styles){return (styles as Record<string,string>).warning;}',
  ].join('\n'));
  const run=execute('refs',[...args(root),'--selector','.warning','--file','src/components/CustomerCard.module.css']);
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(run.data.references.map(r=>r.line),[2,3,4,5]);
  const impact=execute('impact',[...args(root),'--selector','.warning','--file','src/components/CustomerCard.module.css']);
  assert.equal(impact.status,0,impact.stderr);
  assert.ok(impact.data.affectedFiles.includes('frontend/src/App.tsx'));
});

test('review R5: historical comparisons work after the current scope is removed or replaced',t=>{
  const root=fixture(t);
  fs.rmSync(path.join(root,'frontend'),{recursive:true});
  git(root,['add','-A']);git(root,['commit','-qm','Remove frontend']);
  for (const candidate of ['HEAD','worktree']) {
    const run=execute('verify',[...args(root),'--baseline','HEAD~1','--candidate',candidate]);
    assert.equal(run.status,2,run.stderr);
    assert.equal(run.data.summaryCounts.changed,3);
    assert.equal(run.data.complete,true);
  }
  put(root,'frontend','Scope replaced by a file');
  const replaced=execute('verify',[...args(root),'--baseline','HEAD~1','--candidate','HEAD']);
  assert.equal(replaced.status,2,replaced.stderr);
  for (const command of ['inventory','refs','impact']) {
    const run=execute(command,[...args(root),'--selector','.warning']);
    assert.equal(run.status,3,run.stderr);
    assert.match(run.stderr,/Scope directory not found/);
  }
});

test('review performance: file-filter resolution and warning deduplication stay bounded',t=>{
  const root=fixture(t);
  for (let i=0;i<150;i++) put(root,`notes/${i}.txt`,'unrelated');
  put(root,'frontend/src/missing.ts',Array.from({length:120},(_,i)=>`import "./missing-${i}";`).join('\n'));
  const selected=path.join(root,'frontend/src/components/CustomerCard.module.css');
  const hook=`import fs from 'node:fs';let paths=0,warningSearches=0;const lstat=fs.lstatSync,includes=Array.prototype.includes;
    fs.lstatSync=function(p,...args){if(String(p)===${JSON.stringify(selected)})paths++;return lstat.call(this,p,...args);};
    Array.prototype.includes=function(value,...args){if(typeof value==='string'&&value.startsWith('Unresolved relative import'))warningSearches+=this.length;return includes.call(this,value,...args);};
    process.on('exit',()=>console.error('WORK='+JSON.stringify({paths,warningSearches})));`;
  for (const command of ['refs','impact']) {
    const run=execute(command,[...args(root),'--scope','.','--selector','.warning','--file','frontend/src/components/CustomerCard.module.css'],
      {nodeArgs:['--import',`data:text/javascript,${encodeURIComponent(hook)}`]});
    assert.equal(run.status,3,run.stderr);
    assert.equal(run.data.totals.warnings,120);
    const work=JSON.parse(run.stderr.match(/WORK=(.*)/)[1]);
    assert.ok(work.paths<=2,`Repeated ${command} file path checks: ${work.paths}`);
    assert.ok(work.warningSearches<=120,`Quadratic warning searches: ${work.warningSearches}`);
  }
});
