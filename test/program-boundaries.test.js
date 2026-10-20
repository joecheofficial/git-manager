"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync,spawnSync,spawn} = require("node:child_process");
const boundary = require("../src/program-boundaries");
const identity = {GIT_AUTHOR_NAME:"Boundary Test",GIT_AUTHOR_EMAIL:"boundary@example.invalid",GIT_COMMITTER_NAME:"Boundary Test",GIT_COMMITTER_EMAIL:"boundary@example.invalid",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"};
Object.assign(process.env,identity);
const git=(repo,...args)=>execFileSync("git",["-C",repo,...args],{encoding:"utf8",stdio:"pipe"}).trim();
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"gm-boundary-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const repo=path.join(root,"repo");fs.mkdirSync(repo);
  git(repo,"init","-b","main");
  for(const file of ["courses/cohort-4/lesson.md","courses/meta-ads/lesson.md","src/shared.js"]){fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});fs.writeFileSync(path.join(repo,file),"base\n");}
  git(repo,"add",".");git(repo,"commit","-m","initial");
  const config={claimsFile:path.join(root,"claims.json"),worktreeRoot:path.join(root,"trees"),carryBackupDir:path.join(root,"carry"),ownerSessions:[],enforcedRepos:[],programBoundaries:[{repo,requirePaths:true,programs:{"cohort-4":{roots:["courses/cohort-4"],patterns:["test/cohort-4-*.test.js"]},"meta-ads":{roots:["courses/meta-ads"]}}}]};
  const opts={config,env:{ALLSORTED_ACTOR:"codex"},owner:"codex",session:"codex-session",task:"cohort",paths:["courses/cohort-4"]};
  return {root,repo,config,opts,start:extra=>boundary.guardedStart(repo,{...opts,...extra})};
}
const refuse=(r,pattern)=>{assert.equal(r.ok,false,JSON.stringify(r));assert.match(r.reasons.join("\n"),pattern);};
function commit(repo,file,body="edited\n"){fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});fs.writeFileSync(path.join(repo,file),body);git(repo,"add",".");git(repo,"commit","-m","feat: boundary fixture");}
test("governed start requires a concrete single lane and rejects bypasses",t=>{
 const f=fixture(t);
 for(const paths of [[],["."],["courses"],["courses/cohort-4/*"],["courses/cohort-4","src/shared.js"],["courses/cohort-4","courses/meta-ads"]])refuse(f.start({paths}),/scope|lane|path|program/i);
 refuse(f.start({allowOverlap:true}),/allow.overlap/i);
 refuse(f.start({program:"meta-ads"}),/explicit program/);
 assert.equal(f.start().ok,true);
});
test("different provider identities author disjoint programs concurrently",t=>{
 const f=fixture(t),a=f.start();assert.equal(a.ok,true);
 const b=f.start({task:"ads",paths:["courses/meta-ads"],env:{ALLSORTED_ACTOR:"claude"},owner:"claude",session:"claude-session"});assert.equal(b.ok,true,JSON.stringify(b));
 const c=f.start({task:"shared",paths:["src/shared.js"],env:{ALLSORTED_ACTOR:"antigravity"},owner:"antigravity",session:"ag-session"});assert.equal(c.ok,true,JSON.stringify(c));
 refuse(f.start({task:"overlap",session:"other"}),/overlap/);
});
test("own reuse cannot expand scope and legacy empty claims reserve repository",t=>{
 const f=fixture(t);assert.equal(f.start().ok,true);assert.equal(f.start().reused,true);
 refuse(f.start({paths:["courses/meta-ads"]}),/reuse|expand|scope/);
 const store=JSON.parse(fs.readFileSync(f.config.claimsFile));store.claims[0].paths=[];fs.writeFileSync(f.config.claimsFile,JSON.stringify(store));
 refuse(f.start({task:"ads",paths:["courses/meta-ads"],session:"other"}),/legacy|repository|overlap/);
});
test("symlink escape and alternate-program aliases refuse",t=>{
 const f=fixture(t);fs.symlinkSync(f.root,path.join(f.repo,"outside"));refuse(f.start({paths:["outside/nope"]}),/symlink|outside|escape/);
 fs.symlinkSync("courses/meta-ads",path.join(f.repo,"alias"));refuse(f.start({paths:["alias"]}),/symlink|alias|lane/);
 fs.symlinkSync("src",path.join(f.repo,"shared-alias"));refuse(f.start({paths:["shared-alias"]}),/symlink|alias/);
});
test("finished diff must remain in claim and one program, including rename sources",t=>{
 const f=fixture(t),r=f.start();assert.equal(r.ok,true);const head=git(f.repo,"rev-parse","HEAD");
 commit(r.worktree,"courses/meta-ads/escape.md");
 refuse(boundary.guardedFinish(r.claim.id,{...f.opts,keepBranch:true}),/scope|claim|program/);
 assert.equal(git(f.repo,"rev-parse","HEAD"),head);assert.ok(fs.existsSync(r.worktree));
});
test("rename from shared into a claimed program refuses both sides",t=>{
 const f=fixture(t),r=f.start();git(r.worktree,"mv","src/shared.js","courses/cohort-4/moved.js");git(r.worktree,"commit","-m","feat: rename escape");
 refuse(boundary.guardedFinish(r.claim.id,{...f.opts,keepBranch:true}),/scope|claim|lane/);
});
test("same-program changes outside an exact file reservation still refuse",t=>{
 const f=fixture(t),r=f.start({paths:["courses/cohort-4/lesson.md"]});commit(r.worktree,"courses/cohort-4/unclaimed.md");
 refuse(boundary.guardedFinish(r.claim.id,{...f.opts,keepBranch:true}),/escape declared claim scope/);
});
test("valid governed finish integrates and preserves separate active program claim",t=>{
 const f=fixture(t),a=f.start(),b=f.start({task:"ads",paths:["courses/meta-ads"],session:"other"});
 commit(a.worktree,"courses/cohort-4/lesson.md");const r=boundary.guardedFinish(a.claim.id,{...f.opts,keepBranch:true});assert.equal(r.ok,true,JSON.stringify(r));assert.ok(fs.existsSync(b.worktree));
});
test("a user finish test moving tip into another program cannot evade validation",t=>{
 const f=fixture(t),a=f.start();commit(a.worktree,"courses/cohort-4/lesson.md");const main=git(f.repo,"rev-parse","HEAD");
 const testCommand="printf escaped > courses/meta-ads/escape.md && git add courses/meta-ads/escape.md && git commit -m 'feat: test race'";
 refuse(boundary.guardedFinish(a.claim.id,{...f.opts,testCommand,keepBranch:true}),/scope|claim|test command|HEAD moved/);
 assert.equal(git(f.repo,"rev-parse","HEAD"),main);assert.ok(fs.existsSync(a.worktree));
});
test("ungoverned repositories retain underlying unscoped lifecycle",t=>{
 const f=fixture(t);f.config.programBoundaries=[];assert.equal(f.start({paths:[]}).ok,true);
});
test("named program tests classify without claiming entire shared test directory",t=>{
 const f=fixture(t);assert.equal(boundary.classifyScope(f.repo,["test/cohort-4-lesson.test.js"],f.config).program,"cohort-4");
 refuse(f.start({paths:["test"]}),/scope|encompass|program/);
});
test("new symlink inside authoring worktree cannot escape finish scope",t=>{
 const f=fixture(t),r=f.start();fs.symlinkSync(f.root,path.join(r.worktree,"courses/cohort-4/outside"));git(r.worktree,"add",".");git(r.worktree,"commit","-m","feat: unsafe symlink");
 refuse(boundary.guardedFinish(r.claim.id,{...f.opts,keepBranch:true}),/symlink|escape/);
});
test("reused legacy broad claim must be refined by owner, not silently accepted",t=>{
 const f=fixture(t),r=f.start();const store=JSON.parse(fs.readFileSync(f.config.claimsFile));store.claims[0].paths=["courses"];fs.writeFileSync(f.config.claimsFile,JSON.stringify(store));
 refuse(f.start(),/scope|encompass/);assert.ok(fs.existsSync(r.worktree));
});
test("test-driven same-program tip changes still hit underlying tested-tip guard",t=>{
 const f=fixture(t),r=f.start();commit(r.worktree,"courses/cohort-4/lesson.md");const main=git(f.repo,"rev-parse","HEAD");
 const testCommand="printf raced >> courses/cohort-4/lesson.md && git add courses/cohort-4/lesson.md && git commit -m 'feat: within lane race'";
 refuse(boundary.guardedFinish(r.claim.id,{...f.opts,testCommand,keepBranch:true}),/HEAD moved/);assert.equal(git(f.repo,"rev-parse","HEAD"),main);
});
test("test cannot expand claim store to evade immutable finish snapshot",t=>{
 const f=fixture(t),r=f.start();commit(r.worktree,"courses/cohort-4/lesson.md");
 const script=path.join(f.root,"alter.js");fs.writeFileSync(script,`const fs=require('fs');const p=${JSON.stringify(f.config.claimsFile)};const s=JSON.parse(fs.readFileSync(p));s.claims[0].paths=['courses'];fs.writeFileSync(p,JSON.stringify(s));`);
 const testCommand=`${process.execPath} ${script}`;
 refuse(boundary.guardedFinish(r.claim.id,{...f.opts,testCommand,keepBranch:true}),/claim scope changed/);assert.ok(fs.existsSync(r.worktree));
});
test("public CLI enforces the configured program policy and accepts --program",t=>{
 const f=fixture(t),cli=path.resolve(__dirname,"../bin/git-manager.js");
 const run=args=>spawnSync(process.execPath,[cli,"start",f.repo,...args],{encoding:"utf8",env:{...process.env,ALLSORTED_ACTOR:"codex",ALLSORTED_SESSION_NAME:"cli-cohort",GIT_MANAGER_CONFIG_JSON:JSON.stringify(f.config)}});
 const valid=run(["--task","cli-cohort","--owner","codex","--paths","courses/cohort-4","--program","cohort-4"]);
 assert.equal(valid.status,0,valid.stdout+valid.stderr);
 const unscoped=run(["--task","cli-unscoped","--owner","codex"]);assert.notEqual(unscoped.status,0);assert.match(unscoped.stdout+unscoped.stderr,/scope|concrete|path/i);
 const bypass=run(["--task","cli-bypass","--owner","codex","--paths","courses/cohort-4","--allow-overlap"]);assert.notEqual(bypass.status,0);assert.match(bypass.stdout+bypass.stderr,/allow.overlap|boundar/i);
 f.config.programBoundaries=[];const legacy=run(["--task","cli-legacy","--owner","codex"]);assert.equal(legacy.status,0,legacy.stdout+legacy.stderr);
});
test("independent provider processes reserve separate program lanes concurrently",async t=>{
 const f=fixture(t);
 const script=path.join(f.root,"parallel.js");fs.writeFileSync(script,`const b=require(${JSON.stringify(path.resolve(__dirname,"../src/program-boundaries.js"))});const p=JSON.parse(Buffer.from(process.argv[2],'base64').toString());process.stdout.write(JSON.stringify(b.guardedStart(p.repo,p.opts)));`);
 const launches=[{task:"cohort",paths:["courses/cohort-4"],actor:"claude"},{task:"ads",paths:["courses/meta-ads"],actor:"codex"},{task:"shared",paths:["src/shared.js"],actor:"antigravity"}].map(item=>new Promise((resolve,reject)=>{
   const payload=Buffer.from(JSON.stringify({repo:f.repo,opts:{...f.opts,task:item.task,paths:item.paths,env:{ALLSORTED_ACTOR:item.actor},owner:item.actor,session:item.actor+"-native"}})).toString("base64");
   const child=spawn(process.execPath,[script,payload],{stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("error",reject);child.on("close",code=>code?reject(new Error(err)):resolve(JSON.parse(out)));
 }));
 const results=await Promise.all(launches);for(const result of results)assert.equal(result.ok,true,JSON.stringify(result));
 const claims=JSON.parse(fs.readFileSync(f.config.claimsFile)).claims;assert.equal(claims.length,3);assert.equal(new Set(claims.map(c=>c.worktree)).size,3);
});
