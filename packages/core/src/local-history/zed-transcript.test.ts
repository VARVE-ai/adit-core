import {it,expect} from 'vitest';
import Database from 'better-sqlite3';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalHistory} from './archive.js';
it('projects Zed tagged text into summary and visible transcript blocks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'adit-zed-text-')),db=new Database(':memory:');
 try{mkdirSync(join(root,'threads'));const native=new Database(join(root,'threads/threads.db'));
 native.exec('CREATE TABLE threads(id TEXT,summary TEXT,updated_at TEXT,data_type TEXT,data BLOB,folder_paths TEXT,created_at TEXT)');
 native.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?)').run('s','','2026-10-28T09:00:00Z','json',Buffer.from(JSON.stringify({messages:[{User:{id:'u',content:[{Text:'你好'}]}}]})),root,'2026-10-28T09:00:00Z');native.close();
 const a=new LocalHistory(db);expect((await a.scan(root,[{id:'zed',paths:[root]}])).errors).toEqual([]);
 expect(db.prepare('SELECT first_prompt FROM adit_history_sessions').get()).toEqual({first_prompt:'你好'});
 expect(db.prepare('SELECT kind,text_content FROM adit_history_blocks').all()).toContainEqual({kind:'text',text_content:'你好'});
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
