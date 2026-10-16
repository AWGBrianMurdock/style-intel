import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

// cat-file's binary bodies are length framed, not newline delimited. Retain
// only a bounded header and the current stream chunk, never a complete blob.
export async function* readGitBatch(stream, items) {
  let index=0, header=Buffer.alloc(0), remaining=0, state='header';
  for await (const chunk of stream) {
    let offset=0;
    while (offset<chunk.length) {
      if (index>=items.length) throw new Error('Unexpected trailing Git cat-file output');
      if (state==='header') {
        const newline=chunk.indexOf(10,offset);
        const end=newline<0 ? chunk.length : newline;
        if (header.length+end-offset>256) throw new Error('Oversized Git cat-file header');
        header=Buffer.concat([header,chunk.subarray(offset,end)]);
        offset=newline<0 ? end : end+1;
        if (newline<0) continue;
        const match=/^([a-f\d]{40,64}) blob (0|[1-9]\d*)$/.exec(header.toString('utf8'));
        if (!match || match[1]!==items[index].oid) throw new Error('Malformed or unexpected Git cat-file header');
        remaining=Number(match[2]);
        if (!Number.isSafeInteger(remaining)) throw new Error('Invalid Git blob size');
        header=Buffer.alloc(0);
        state=remaining ? 'body' : 'delimiter';
        yield {type:'start',item:items[index]};
      } else if (state==='body') {
        const size=Math.min(remaining,chunk.length-offset);
        yield {type:'data',chunk:chunk.subarray(offset,offset+size)};
        offset+=size;
        remaining-=size;
        if (!remaining) state='delimiter';
      } else {
        if (chunk[offset++]!==10) throw new Error('Malformed Git blob delimiter');
        yield {type:'end'};
        index++;
        state='header';
      }
    }
  }
  if (index!==items.length || header.length || state!=='header')
    throw new Error('Incomplete Git cat-file output');
}

export async function snapshotGitBlobs(root, items, targetFor) {
  const child=spawn('git',['-C',root,'cat-file','--batch'],{
    shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
  });
  let spawnError, timedOut=false;
  const closed=new Promise(resolve=>{
    child.once('error',error=>{spawnError=error;});
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  const stderr=[];
  let stderrBytes=0;
  child.stderr.on('data',chunk=>{
    const part=chunk.subarray(0,Math.max(0,16384-stderrBytes));
    if (part.length) {stderr.push(part);stderrBytes+=part.length;}
  });
  const timeout=setTimeout(()=>{
    timedOut=true;
    child.kill();
    child.stdout.destroy(new Error('Git cat-file timed out'));
  },120000);
  timeout.unref();
  function* requests() {for (const item of items) yield item.oid+'\n';}
  // Feed requests concurrently with reading responses to avoid pipe deadlocks.
  const input=pipeline(Readable.from(requests()),child.stdin).catch(error=>{
    child.kill();
    return error;
  });
  let fd, failure;
  try {
    try {
      for await (const event of readGitBatch(child.stdout,items)) {
        if (event.type==='start') {
          const target=targetFor(event.item);
          fs.mkdirSync(path.dirname(target),{recursive:true});
          fd=fs.openSync(target,'w');
        } else if (event.type==='data') {
          // writeFileSync handles short writes and advances the descriptor offset.
          fs.writeFileSync(fd,event.chunk);
        } else {
          fs.closeSync(fd);
          fd=undefined;
        }
      }
    } catch(error) {
      failure=error;
    } finally {
      if (fd!==undefined) {
        try {fs.closeSync(fd);} catch(error) {failure??=error;}
      }
      if (failure) child.kill();
    }
    const inputError=await input;
    const exit=await closed;
    if (spawnError || timedOut || (exit.code!==0 && !failure))
      throw new Error('git cat-file failed: '+(spawnError?.message || (timedOut?'timed out':Buffer.concat(stderr).toString('utf8').trim() || 'exit '+exit.code)));
    if (failure) {
      const detail=Buffer.concat(stderr).toString('utf8').trim();
      throw new Error(failure.message+(detail ? ': '+detail : ''),{cause:failure});
    }
    if (inputError) throw new Error('Cannot send Git blob requests: '+inputError.message,{cause:inputError});
  } finally {
    clearTimeout(timeout);
  }
}
