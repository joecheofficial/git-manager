"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {resolveRepositoryRoot}=require("../profile");
test("private profile selects a repository without changing its bytes",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"git-profile-"));
 const file=path.join(dir,"profile.json"),root=path.join(dir,"repository");
 const body=JSON.stringify({repositoryRoot:root});fs.writeFileSync(file,body);
 assert.equal(resolveRepositoryRoot(undefined,{GIT_MANAGER_PROFILE:file}),root);
 assert.equal(fs.readFileSync(file,"utf8"),body);
 assert.equal(resolveRepositoryRoot(dir,{GIT_MANAGER_PROFILE:file}),dir);
 assert.equal(resolveRepositoryRoot(undefined,{REPOSITORY_ROOT:dir,GIT_MANAGER_PROFILE:file}),dir);
 fs.writeFileSync(file,"invalid");assert.throws(()=>resolveRepositoryRoot(undefined,{GIT_MANAGER_PROFILE:file}));
 fs.writeFileSync(file,JSON.stringify({repositoryRoot:"relative"}));assert.throws(()=>resolveRepositoryRoot(undefined,{GIT_MANAGER_PROFILE:file}),/absolute/);
 assert.throws(()=>resolveRepositoryRoot(undefined,{GIT_MANAGER_PROFILE:path.join(dir,"missing")}),/ENOENT/);
 fs.rmSync(dir,{recursive:true});
});
