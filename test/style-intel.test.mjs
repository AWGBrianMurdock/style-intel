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