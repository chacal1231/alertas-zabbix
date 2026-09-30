import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

test('HTTP: login, CSRF, token, persistencia y recuperación',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alertas-test-'));
 const port=19000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`;
 const env={...process.env,PORT:String(port),DATA_DIR:dir,ADMIN_USER:'admin',ADMIN_PASSWORD:'test-password-123456',WEBHOOK_TOKEN:'test-token-12345678901234567890',MOCK_WHATSAPP:'true'};
 let child,logs='';
 const start=async()=>{child=spawn(process.execPath,['src/server.js'],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await wait(50);}throw new Error('No inicia: '+logs);};
 const stop=async()=>{if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await done;}};
 try{
 await start();
 assert.equal((await fetch(base+'/api/history')).status,401);
 assert.equal((await fetch(base+'/zabbix-webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'alertas'},body:JSON.stringify({username:'admin',password:env.ADMIN_PASSWORD})});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);assert.doesNotMatch(login.headers.get('set-cookie'),/; Secure/);
 const headers={'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf};
 assert.equal((await fetch(base+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/config',{method:'PUT',headers,body:JSON.stringify({groups:['123456@g.us'],minSeverity:0,hostContains:'',tag:'',updates:true})})).status,200);
 const p={event_id:'999',event_source:'0',event_value:'1',Host:'Router',Event:'Caído',event_nseverity:'4',problem_status:'Active'};
 const webhook=async body=>fetch(base+'/zabbix-webhook',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.WEBHOOK_TOKEN}`},body:JSON.stringify(body)});
 assert.equal((await webhook(p)).status,200);assert.equal((await (await webhook(p)).json()).duplicate,true);
 assert.equal((await webhook({...p,event_value:'0',problem_status:'Resolved'})).status,200);
 const h=await (await fetch(base+'/api/history',{headers})).json();assert.equal(h.incidents[0].status,'recovered');assert.equal(h.jobs.length,2);
 await stop();await start();
 assert.equal((await fetch(base+'/api/history',{headers})).status,401);
 assert.equal((await (await webhook(p)).json()).duplicate,true);
 }finally{await stop();rmSync(dir,{recursive:true,force:true});}
});
