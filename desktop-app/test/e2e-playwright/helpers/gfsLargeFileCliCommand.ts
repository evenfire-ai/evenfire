// E2E_GUARDIAN_IPC_FLOW: this helper builds the local CLI program; its calling
// Desktop journey owns the visible IPC progress/approval waits. No renderer
// HTTP request originates here.
// Test-only, read-only CSV proof program. The E2E approves this exact command,
// rather than accepting an arbitrary model-generated command by keywords.
export function largeCsvProofProgram(runKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runKey)) throw new Error('Invalid CSV proof run key')
  return [
    'const fs=require("node:fs"),crypto=require("node:crypto");',
    'const source=process.argv[1];',
    'let records=0,quoted=false,skipLF=false,started=false;',
    'const input=fs.createReadStream(source,{encoding:"utf8"});',
    'input.on("data",chunk=>{for(const ch of chunk){',
    'if(skipLF){skipLF=false;if(ch==="\\n")continue;}',
    'if(ch.charCodeAt(0)===34){quoted=!quoted;started=true;}',
    'else if(!quoted&&(ch==="\\r"||ch==="\\n")){records++;started=false;skipLF=ch==="\\r";}',
    'else started=true;}});',
    'input.on("error",()=>{process.exitCode=1;});',
    'input.on("end",()=>{if(quoted)throw new Error("Incomplete CSV record");',
    'if(started)records++;',
    'const fd=fs.openSync(source,"r");',
    'try{const size=fs.fstatSync(fd).size,tail=Buffer.alloc(Math.min(4096,size));',
    'let offset=0;while(offset<tail.length){',
    'const n=fs.readSync(fd,tail,offset,tail.length-offset,size-tail.length+offset);',
    'if(n===0)throw new Error("Incomplete proof tail");offset+=n;}',
    'const proof=crypto.createHash("sha256").update(tail).digest("hex").slice(0,16);',
    `console.log(${JSON.stringify(`RUN=${runKey} ROWS=`)}+records+" PROOF="+proof);`,
    '}finally{fs.closeSync(fd);}});',
  ].join('')
}

export function largeCsvProofCommand(runKey: string, workspacePath: string): string {
  if (!/^\.gfs-downloads\/[A-Za-z0-9_-]+\/source$/.test(workspacePath))
    throw new Error('CSV proof requires the governed workspace path')
  return `node -e '${largeCsvProofProgram(runKey)}' '${workspacePath}'`
}
