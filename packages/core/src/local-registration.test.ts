import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {assertSelectedRepositories,repositoryOriginUrl} from './local-registration.js';
it('requires origin and rejects a selected repository after its remote is removed',()=>{
 const root=mkdtempSync(join(tmpdir(),'adit-origin-'));
 const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 try{git('init');expect(repositoryOriginUrl(root)).toBeNull();expect(()=>assertSelectedRepositories(root,[root])).toThrow("No git remote 'origin'");git('remote','add','origin','https://example.invalid/repo.git');expect(()=>assertSelectedRepositories(root,[root])).not.toThrow();expect(()=>assertSelectedRepositories(root,[])).toThrow('Select at least one');git('remote','remove','origin');expect(()=>assertSelectedRepositories(root,[root])).toThrow("No git remote 'origin'");}finally{rmSync(root,{recursive:true,force:true});}
});
