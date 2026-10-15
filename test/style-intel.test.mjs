import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const CLI=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../style-intel.mjs');

function execute(command,args=[],opts={}) {
  const r=spawnSync(process.execPath,[CLI,command,...args],{cwd:opts.cwd||process.cwd(),
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
