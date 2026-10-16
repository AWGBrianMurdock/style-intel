import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readGitBatch,snapshotGitBlobs} from '../git-snapshot.mjs';

const oid='a'.repeat(40), other='b'.repeat(40);
const frame=(id,body)=>Buffer.concat([Buffer.from(id+' blob '+body.length+'\n'),body,Buffer.from('\n')]);
async function collect(chunks,items) {
  const blobs=[];
  let parts=[];
  for await(const event of readGitBatch(chunks,items)) {
    if(event.type==='start') parts=[];
    else if(event.type==='data') parts.push(event.chunk);
    else blobs.push(Buffer.concat(parts));
  }
  return blobs;
}

test('Git binary framing survives every split point, empty blobs and repeated OIDs',async()=>{
  const binary=Buffer.from([0,10,13,255,128,32,240,10,0]);
  const empty=Buffer.alloc(0);
  const data=Buffer.concat([frame(oid,binary),frame(other,empty),frame(oid,binary)]);
  const items=[{oid},{oid:other},{oid}];
  for(let split=0;split<=data.length;split++) {
    const actual=await collect([data.subarray(0,split),data.subarray(split)],items);
    assert.deepEqual(actual,[binary,empty,binary]);
  }
  assert.deepEqual(await collect(Array.from(data,byte=>Buffer.from([byte])),items),[binary,empty,binary]);
});

test('Git reader emits body chunks incrementally with bounded headers',async()=>{
  const body=Buffer.alloc(65536,255), data=frame(oid,body);
  function* fragments(){for(let i=0;i<data.length;i+=113) yield data.subarray(i,i+113);}
  let bytes=0,events=0;
  for await(const event of readGitBatch(fragments(),[{oid}])) {
    if(event.type==='data') {
      assert.ok(event.chunk.length<=113);
      bytes+=event.chunk.length;events++;
    }
  }
  assert.equal(bytes,body.length);
  assert.ok(events>500);
});

const malformed=[
  ['missing header',Buffer.alloc(0),/Incomplete/],
  ['missing object',Buffer.from(oid+' missing\n'),/header/],
  ['wrong object',frame(other,Buffer.alloc(0)),/header/],
  ['negative size',Buffer.from(oid+' blob -1\n'),/header/],
  ['unsafe size',Buffer.from(oid+' blob 9007199254740992\n'),/size/],
  ['oversized header',Buffer.alloc(257,97),/Oversized/],
  ['truncated body',Buffer.from(oid+' blob 2\nx'),/Incomplete/],
  ['missing delimiter',Buffer.from(oid+' blob 1\nx'),/Incomplete/],
  ['wrong delimiter',Buffer.from(oid+' blob 1\nx!'),/delimiter/],
  ['trailing data',Buffer.concat([frame(oid,Buffer.alloc(0)),Buffer.from('!')]),/trailing/],
];
for(const [name,data,message] of malformed) test('Git framing rejects '+name,async()=>{
  await assert.rejects(collect([data],[{oid}]),message);
});

test('Git framing propagates input failures and closes the input iterator',async()=>{
  let closed=false;
  async function* broken(){
    try {yield Buffer.from(oid+' blob 2\nx');throw new Error('synthetic stream failure');}
    finally {closed=true;}
  }
  await assert.rejects(collect(broken(),[{oid}]),/synthetic stream failure/);
  assert.equal(closed,true);
});

function repository(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'style intel batch '));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3}));
  const init=spawnSync('git',['-C',root,'init','-q'],{encoding:'utf8',windowsHide:true});
  assert.equal(init.status,0,init.stderr);
  return root;
}
function object(root,body) {
  const result=spawnSync('git',['-C',root,'hash-object','-w','--stdin'],{input:body,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}

test('streaming snapshot materializes exact binary bytes into paths with spaces',async t=>{
  const root=repository(t), body=Buffer.from(Array.from({length:65536},(_,i)=>i%256));
  const items=[{oid:object(root,body),name:'nested folder/binary.css'},
    {oid:object(root,Buffer.alloc(0)),name:'empty.css'}];
  await snapshotGitBlobs(root,items,item=>path.join(root,'snapshot',item.name));
  assert.deepEqual(fs.readFileSync(path.join(root,'snapshot',items[0].name)),body);
  assert.equal(fs.statSync(path.join(root,'snapshot/empty.css')).size,0);
});

test('streaming snapshot reports Git subprocess failures',async t=>{
  const root=repository(t);
  await assert.rejects(snapshotGitBlobs(path.join(root,'missing'),[{oid}],()=>path.join(root,'out.css')),/git|fatal|Git/);
});

test('streaming snapshot terminates and awaits Git after a destination failure', {timeout:10000}, async t=>{
  const root=repository(t), id=object(root,Buffer.alloc(4096,97));
  await assert.rejects(snapshotGitBlobs(root,Array.from({length:2000},()=>({oid:id})),()=>{
    throw new Error('synthetic destination failure');
  }),/synthetic destination failure/);
});


test('streaming snapshot reports a missing Git executable without hanging',t=>{
  const root=repository(t),env={...process.env};
  for(const key of Object.keys(env)) if(key.toLowerCase()==='path') delete env[key];
  env.PATH=root;
  const source='import assert from "node:assert/strict"; import {snapshotGitBlobs} from '+
    JSON.stringify(new URL('../git-snapshot.mjs',import.meta.url).href)+'; '+
    'await assert.rejects(snapshotGitBlobs(process.cwd(),[{oid:"'+oid+'"}],()=>"unused"),/ENOENT/);';
  const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{
    cwd:root,env,encoding:'utf8',windowsHide:true,timeout:10000,
  });
  assert.equal(result.status,0,result.stderr);
});
