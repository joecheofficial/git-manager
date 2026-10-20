"use strict";
// Customer backups remain in the configured local recovery directory.
// Never infer a mounted drive, copy across volumes or remove a verified source.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
function manifest(root) {
  const rows=[];
  function walk(relative) {
    const file=path.join(root,relative),st=fs.lstatSync(file);
    const row={path:relative,mode:st.mode & 0o7777};
    if(st.isSymbolicLink()) Object.assign(row,{kind:"symlink",target:fs.readlinkSync(file)});
    else if(st.isDirectory()) row.kind="directory";
    else if(st.isFile()) {
      const h=crypto.createHash("sha256"),fd=fs.openSync(file,"r"),buf=Buffer.alloc(4*1024*1024);
      try {let n;while((n=fs.readSync(fd,buf,0,buf.length,null))>0)h.update(buf.subarray(0,n));} finally{fs.closeSync(fd);}
      const after=fs.lstatSync(file);
      if(["dev","ino","size","mtimeMs","ctimeMs"].some(k=>st[k]!==after[k]))throw Error("Source changed while hashing");
      Object.assign(row,{kind:"file",bytes:st.size,sha256:h.digest("hex")});
    } else throw Error("Special file cannot be relocated safely");
    rows.push(row);
    if(row.kind==="directory") for(const name of fs.readdirSync(file).sort())walk(path.join(relative,name));
  }
  walk("");return rows;
}
function hasCopyAndStagingSpace(freeBytes, sourceBytes, reserveBytes) {
  return freeBytes >= sourceBytes * 2 + reserveBytes;
}
function selectRoot(source,fallback) {
  if(!fallback) throw Error("A local recovery directory must be configured");
  let rows;
  try {rows=manifest(source);} catch(error) {
    if(!["EACCES","EPERM"].includes(error.code))throw error;
    // A same-filesystem rename preserves unreadable contents without opening them.
  }
  return {root:fallback,external:false,reason:"configured local recovery directory",rows};
}
function moveVerified(source,destination,rows) {
  const from=path.resolve(source),to=path.resolve(destination);
  try { fs.lstatSync(to); throw Error("Backup destination exists"); }
  catch(error) { if(error.code!=="ENOENT") throw error; }
  const parent=path.relative(from,to);
  if(!parent.startsWith(".."+path.sep)&&parent!==".."&&!path.isAbsolute(parent))throw Error("Backup destination must be outside the source");
  const original=fs.lstatSync(from);
  const expected=rows ? JSON.stringify(rows) : null;
  if(expected && JSON.stringify(manifest(from))!==expected)throw Error("Source verification mismatch; source retained");
  fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});
  // rename is atomic on one filesystem. EXDEV retains the original source.
  fs.renameSync(from,to);
  try {
    const relocated=fs.lstatSync(to);
    if(relocated.dev!==original.dev || relocated.ino!==original.ino)throw Error("Backup inode verification mismatch");
    if(expected && JSON.stringify(manifest(to))!==expected)throw Error("Backup verification mismatch");
  }
  catch(error) { try { fs.renameSync(to,from); } catch { throw Error("Backup verification failed; recovery retained at "+to); } throw error; }
}
module.exports={manifest,selectRoot,moveVerified,hasCopyAndStagingSpace};
