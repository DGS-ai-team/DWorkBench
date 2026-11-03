import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { workspaceChecks, workspaceBrowserChecks } from './workspace.mjs';
import { reviewApiChecks, reviewBrowserChecks } from './review-regression.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'src/LogDesk.Client/package.json'));
const {Server,utils}=require('ssh2');
const {HubConnectionBuilder,LogLevel}=require('@microsoft/signalr');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await pause(100)}throw new Error('Condition timed out')}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";

async function fixture(label){
  const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey;
  const files=new Map();const dir='/var/log/team';
  for(let i=0;i<230;i++)files.set(`${dir}/archive-${String(i).padStart(3,'0')}.log`,Buffer.from(`2026-11-02 09:40:00.001 INFO [${label}] archived log ${i}\n`));
  const logPath=dir+"/api space's.log";files.set(logPath,Buffer.from(`2026-11-02 10:15:00.002 INFO  [${label}] 服务已启动\n2026-11-02 10:15:00.014 WARN  [${label}] queue latency 125ms\n`));
  files.set(dir+'/worker.log',Buffer.from(`2026-11-02 10:15:01.002 INFO  [${label}] worker ready\n`));
  let authenticationCount=0,active=0,holdReads=false;const pendingReads=[];const sockets=new Set();
  const server=new Server({hostKeys:[key]},client=>{
    sockets.add(client);client.on('error',e=>{if(process.env.DEBUG_FIXTURE)console.log('SSH fixture:',e.message)});client.on('close',()=>sockets.delete(client));
    client.on('authentication',ctx=>{if(ctx.method==='password'){authenticationCount++;if(ctx.username==='reader'&&ctx.password==='FixtureSecret123')return ctx.accept()}ctx.reject(['password'])});
    client.on('ready',()=>client.on('session',accept=>{const session=accept();
      // SFTP-only fixture: shell/exec requests are never accepted.
      session.on('exec',(_accept,reject)=>reject());
      session.on('sftp',accept=>{
        const s=accept(),handles=new Map();let next=1,openCount=0,timer,counted=false,closed=false;
        const track=()=>{const paths=[...new Set([...handles.values()].filter(h=>h.path).map(h=>h.path))];if(paths.length&&!counted){active++;counted=true}if(!paths.length&&counted){active--;counted=false}if(!paths.length){clearInterval(timer);timer=undefined}else if(openCount>=2&&!timer)timer=setInterval(()=>{for(const p of paths)files.set(p,Buffer.concat([files.get(p),Buffer.from(`2026-11-02 10:15:02.125 INFO  [${label}] request completed duration=12ms ✓\n`)]))},180)};
        const close=()=>{closed=true;handles.clear();track();client.removeListener('close',close)};s.on('close',close);s.on('error',close);client.on('close',close);
        const handle=value=>{const b=Buffer.alloc(4);b.writeUInt32BE(next++);handles.set(b.toString('hex'),value);return b};
        const attr=p=>({mode:p===dir?0o040755:p.endsWith('link.log')?0o120777:0o100644,size:files.get(p)?.length??0,uid:1000,gid:1000,atime:Math.floor(Date.now()/1000),mtime:1770000000+(p===logPath?1000:Number(p.match(/(\d+)\.log$/)?.[1]??0))});
        s.on('REALPATH',(id,p)=>s.name(id,[{filename:p,longname:p,attrs:attr(p)}]));
        for(const command of ['STAT','LSTAT'])s.on(command,(id,p)=>files.has(p)||p===dir||p.endsWith('/link.log')?s.attrs(id,attr(p)):s.status(id,2));
        s.on('OPENDIR',(id,p)=>p===dir?s.handle(id,handle({dir:true,done:false})):s.status(id,2));
        s.on('READDIR',(id,h)=>{const entry=handles.get(h.toString('hex'));if(!entry||entry.done)return s.status(id,1);entry.done=true;
          s.name(id,[...files.keys(),dir+'/link.log'].map(p=>({filename:p.slice(dir.length+1),longname:p,attrs:attr(p)})))});
        s.on('OPEN',(id,p,flags)=>{if(!files.has(p))return s.status(id,2);if(flags!==1)return s.status(id,3);openCount++;s.handle(id,handle({path:p}));track()});
        s.on('FSTAT',(id,h)=>{const entry=handles.get(h.toString('hex'));entry?.path?s.attrs(id,attr(entry.path)):s.status(id,2)});
        s.on('READ',(id,h,offset,len)=>{const read=()=>{if(closed)return;const file=files.get(handles.get(h.toString('hex'))?.path);if(!file)return s.status(id,2);if(offset>=file.length)return s.status(id,1);s.data(id,file.subarray(offset,offset+len))};if(holdReads)pendingReads.push(read);else read()});
        s.on('CLOSE',(id,h)=>{handles.delete(h.toString('hex'));track();s.status(id,0)});
        s.on('EXTENDED',id=>s.status(id,8));
      });
    }));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {port:server.address().port,files,logPath,get authenticationCount(){return authenticationCount},get active(){return active},get pendingReads(){return pendingReads.length},holdDownloads:()=>{holdReads=true},releaseDownloads:()=>{holdReads=false;pendingReads.splice(0).forEach(read=>read())},disconnect:()=>{for(const client of sockets)client.end()},close:async()=>{for(const client of sockets)client.end();await new Promise(r=>server.close(r))}};
}

class Client{
  cookies=new Map();csrf='';
  constructor(base){this.base=base}
  cookie(){return [...this.cookies].map(([k,v])=>`${k}=${v}`).join('; ')}
  async request(route,body,method=body===undefined?'GET':'POST',expected=200,csrf=true){
    const response=await fetch(this.base+'/api'+route,{method,headers:{Cookie:this.cookie(),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(csrf?{'X-CSRF-Token':this.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    for(const raw of response.headers.getSetCookie()){const [name,...rest]=raw.split(';')[0].split('=');this.cookies.set(name,rest.join('='))}
    const raw=await response.text();let value;try{value=raw?JSON.parse(raw):null}catch{value=raw}
    assert.equal(response.status,expected,`${method} ${route}: ${raw}`);return value;
  }
  async session(){const result=await this.request('/session');this.csrf=result.csrfToken;return result}
  async login(username,password){await this.session();await this.request('/login',{username,password});await this.session()}
}
await mkdir(path.join(root,'.local'),{recursive:true});const storage=await mkdtemp(path.join(root,'.local/integration-'));
const a=await fixture('api-01'),b=await fixture('worker-02');const appPort=await port();const production=process.env.TEST_PRODUCTION==='1';const base=`${production?'https':'http'}://127.0.0.1:${appPort}`;
const dotnet=process.env.DOTNET_EXE??path.join(root,'.tools/dotnet',process.platform==='win32'?'dotnet.exe':'dotnet');
const testProvider=process.env.TEST_DATABASE_PROVIDER??'Sqlite';
let app=spawn(dotnet,[process.env.TEST_SERVER_DLL??path.join(root,'src/LogDesk.Server/bin/Debug/net10.0/LogDesk.Server.dll')],{
  cwd:path.join(root,'src/LogDesk.Server'),windowsHide:true,
  env:{...process.env,ASPNETCORE_ENVIRONMENT:production?'Production':'Development',ASPNETCORE_URLS:base,Database__Provider:testProvider,Storage__Root:storage,Bootstrap__Token:'test-only-bootstrap-'+appPort}
});
let output='';app.stdout.on('data',c=>output+=c);app.stderr.on('data',c=>output+=c);
let browser;
try{
  await until(async()=>{try{return(await fetch(base+'/api/health')).ok}catch{return false}},30000).catch(()=>{throw new Error(output)});
  const admin=new Client(base);assert.equal((await admin.session()).setupRequired,true);
  await admin.request('/setup',{username:'admin',password:'IntegrationAdmin123',setupToken:'incorrect'},'POST',403);
  await admin.request('/setup',{username:'admin',password:'IntegrationAdmin123',setupToken:'test-only-bootstrap-'+appPort});await admin.session();
  assert.equal((await admin.request('/config')).hosts.length,0);
  await admin.request('/hosts',{name:'csrf',address:'127.0.0.1',port:a.port,username:'reader',password:'FixtureSecret123'},'POST',400,false);
  async function makeHost(f,name){const host=await admin.request('/hosts',{name,address:'127.0.0.1',port:f.port,username:'reader',password:'FixtureSecret123'});assert.equal(host.fingerprint,null);
    const probe=await admin.request(`/hosts/${host.id}/probe`,{});assert.match(probe.fingerprint,/^SHA256:/);assert.equal(probe.connected,false);assert.equal(f.authenticationCount,0,'untrusted host must not receive password');
    await admin.request(`/hosts/${host.id}/trust`,{fingerprint:'SHA256:forged'},'POST',409);
    await admin.request(`/hosts/${host.id}/trust`,{fingerprint:probe.fingerprint});const trusted=await admin.request(`/hosts/${host.id}/probe`,{});assert.equal(trusted.connected,true,JSON.stringify(trusted));return host}
  const ha=await makeHost(a,'prod-api-01'),hb=await makeHost(b,'prod-worker-02');
  const previewInput={hostId:ha.id,name:'目录预览',directory:'/var/log/team',pattern:'*.log',encoding:'utf-8'};
  const preview=await admin.request('/sources/preview',previewInput);
  assert.equal(preview.files.length,20);assert.equal(preview.limited,true);
  assert.equal((await admin.request('/config')).sources.length,0,'preview must not create a source');
  const noMatch=await admin.request('/sources/preview',{...previewInput,pattern:'missing-*.log'});
  assert.equal(noMatch.files.length,0);assert.equal(noMatch.limited,false);
  await admin.request('/sources/preview',{...previewInput,directory:'/missing'},'POST',502);
  await admin.request('/sources/preview',{...previewInput,directory:'/var/../etc'},'POST',400);
  const sa=await admin.request('/sources',{hostId:ha.id,name:'API 应用日志',directory:'/var/log/team',pattern:'*.log',encoding:'utf-8'});
  const sb=await admin.request('/sources',{hostId:hb.id,name:'Worker 任务日志',directory:'/var/log/team',pattern:'*.log',encoding:'utf-8'});
  await admin.request('/sources',{hostId:ha.id,name:'invalid',directory:'/var/log/../etc',pattern:'*',encoding:'utf-8'},'POST',400);
  const group=await admin.request('/groups',{name:'生产环境',description:'跨主机服务排查 · API / Worker',sourceIds:[sa.id,sb.id]});
  await admin.request(`/groups/${group.id}/scan`,{sourceIds:[sa.id,sb.id]},'POST',202);
  const page=await until(async()=>{const p=await admin.request(`/groups/${group.id}/files`);return p.sources.every(s=>s.scan?.state==='completed')?p:false});
  assert.equal(page.total,464,'symlinks must be excluded');assert.equal(page.files.length,200);assert.ok(page.nextCursor);
  const second=await admin.request(`/groups/${group.id}/files?cursor=${page.nextCursor}`);assert.ok(second.files.every(f=>!page.files.some(p=>p.id===f.id)));
  const special=await admin.request(`/groups/${group.id}/files?q=${encodeURIComponent("api space's")}`);assert.equal(special.total,2);
  const fa=special.files.find(f=>f.sourceId===sa.id),fb=special.files.find(f=>f.sourceId===sb.id);
  const bytes=await fetch(`${base}/api/groups/${group.id}/files/${fa.id}/download`,{headers:{Cookie:admin.cookie()}}).then(r=>r.arrayBuffer());
  assert.deepEqual(Buffer.from(bytes),a.files.get(a.logPath),'download must preserve original UTF-8 bytes');
  const viewer=await admin.request('/users',{username:'viewer',displayName:'研发查看者',role:'Viewer',password:'IntegrationViewer123',enabled:true});
  const v=new Client(base);await v.login('viewer','IntegrationViewer123');assert.equal((await v.request('/config')).groups.length,0);
  await v.request('/sources/preview',previewInput,'POST',403);
  await v.request(`/sources/preview?sourceId=${sa.id}`,previewInput,'POST',403);
  await v.request(`/groups/${group.id}/files`,undefined,'GET',403);
  await admin.request(`/users/${viewer.id}/grants`,[{scope:'group',resourceId:group.id,download:false,manage:false},{scope:'host',resourceId:ha.id,download:false,manage:false}],'PUT',204);
  const visible=await v.request(`/groups/${group.id}/files`);assert.equal(visible.total,232);assert.ok(visible.files.every(f=>f.hostId===ha.id));
  await v.request(`/groups/${group.id}/files/${fb.id}/download-check`,undefined,'GET',403);
  await v.request(`/groups/${group.id}/files/${fa.id}/download-check`,undefined,'GET',403);
  await v.request('/hosts',{name:'no',address:'127.0.0.1',port:22,username:'root',password:'x'},'POST',403);
  await v.request('/audit',undefined,'GET',403);
  await workspaceChecks({admin,viewer:v,group,files:[fa,fb],fixtures:[a,b]});
  await reviewApiChecks({admin,Client,group,fa,sa,sb,ha,fixture:a,until});
  const hub=new HubConnectionBuilder().withUrl(base+'/hubs/logs',{headers:{Cookie:admin.cookie()}}).configureLogging(LogLevel.None).build();await hub.start();
  let content='';const subscriptions=[];
  for(let i=0;i<4;i++)subscriptions.push(hub.stream('Watch',group.id,fa.id).subscribe({next:value=>content+=value,error:error=>{throw error}}));
  await until(()=>content.includes('服务已启动')&&a.active===1);
  const sharedStatus=await admin.request('/streams/status');assert.equal(sharedStatus.readers,1);assert.equal(sharedStatus.subscriptions,4);
  await new Promise((resolve,reject)=>{hub.stream('Watch',group.id,fa.id).subscribe({next:()=>{},error:resolve,complete:()=>reject(new Error('fifth stream unexpectedly admitted'))})});
  const fullyIdle=async()=>{const s=await admin.request('/streams/status');return s.readers===0&&s.subscriptions===0&&a.active===0&&b.active===0};
  // Wait for both the fixture's file handles and the broker to finish releasing.
  subscriptions.forEach(s=>s.dispose());await until(fullyIdle);
  const restarted=hub.stream('Watch',group.id,fa.id).subscribe({next:()=>{},error:error=>{throw error}});await until(()=>a.active===1);restarted.dispose();await until(fullyIdle);
  let forbidden=false;const vh=new HubConnectionBuilder().withUrl(base+'/hubs/logs',{headers:{Cookie:v.cookie()}}).configureLogging(LogLevel.None).build();await vh.start();
  await new Promise((resolve,reject)=>vh.stream('Watch',group.id,fb.id).subscribe({next:()=>reject(new Error('unauthorized stream emitted data')),error:()=>{forbidden=true;resolve()},complete:resolve}));assert.ok(forbidden);
  let revoked=false,survivorCharacters=0;
  const survivor=hub.stream('Watch',group.id,fa.id).subscribe({next:value=>survivorCharacters+=value.length,error:error=>{throw error}});
  const viewerStream=vh.stream('Watch',group.id,fa.id).subscribe({next:()=>{},error:()=>{revoked=true},complete:()=>{revoked=true}});await until(()=>a.active===1);
  const survivorBefore=survivorCharacters;
  await admin.request(`/users/${viewer.id}/grants`,[],'PUT',204);await until(()=>revoked,10000);viewerStream.dispose();
  assert.ok((await v.request('/workspace')).resolved.every(r=>r.file===null&&r.issue),'restoring a saved workspace respects revoked grants');
  assert.equal(a.active,1,'revoking one subscriber must preserve the shared reader for an authorized subscriber');assert.ok(survivorCharacters>survivorBefore);
  survivor.dispose();await until(fullyIdle,10000);
  await vh.stop();
  let failed=false,healthyText='',recoveredText='';
  const broken=hub.stream('WatchV2',group.id,fa.id).subscribe({next:()=>{},error:()=>{failed=true},complete:()=>{failed=true}});
  const healthy=hub.stream('WatchV2',group.id,fb.id).subscribe({next:f=>healthyText+=f.text??'',error:e=>{throw e}});
  await until(()=>a.active===1&&b.active===1&&healthyText.length>0);
  a.disconnect();await until(()=>failed&&a.active===0);
  const healthyBefore=healthyText.length;await until(()=>healthyText.length>healthyBefore);
  const recovered=hub.stream('WatchV2',group.id,fa.id).subscribe({next:f=>recoveredText+=f.text??'',error:e=>{throw e}});
  await until(()=>recoveredText.includes('服务已启动')&&a.active===1);
  broken.dispose();healthy.dispose();recovered.dispose();await hub.stop();
  await until(async()=>{const s=await admin.request('/streams/status');return s.readers===0&&s.subscriptions===0&&a.active===0&&b.active===0});
  for(let cycle=0;cycle<5;cycle++){
    await hub.start();let ready=false;
    hub.stream('WatchV2',group.id,fa.id).subscribe({next:f=>{if(f.kind==='ready')ready=true},error:()=>{}});
    await until(()=>ready);await hub.stop();
    await until(async()=>{const s=await admin.request('/streams/status');return s.readers===0&&s.subscriptions===0&&a.active===0});
  }
  console.log('PASS SSH disconnect isolation, fresh retry, five transport reconnect cycles and zero residual readers/subscriptions');
  const audit=await admin.request('/audit');assert.ok(audit.some(e=>e.action==='download.completed'));assert.ok(audit.some(e=>e.action==='stream.started'));assert.ok(audit.some(e=>e.action==='access.denied'));
  assert.ok(!JSON.stringify(audit).includes('FixtureSecret123'));
  if(testProvider==='Sqlite'){const dbBytes=await readFile(path.join(storage,'logdesk.db'));assert.ok(!dbBytes.includes(Buffer.from('FixtureSecret123')),'plaintext password must not be persisted')}
  console.log('PASS API + SSH/SFTP: bootstrap, CSRF, host trust, multi-host scan, cursor paging, UTF-8 download, scoped RBAC, four-stream quota, cancellation and audit');

  if(process.env.SKIP_BROWSER!=='1'){
    // Fill the viewport so subsequent live appends actually auto-scroll. Without
    // overflow, the menu regression would pass even with the old scroll handler.
    for(const f of [a,b])f.files.set(f.logPath,Buffer.concat([f.files.get(f.logPath),Buffer.from(Array.from({length:80},(_,i)=>`INFO menu scroll fixture ${i}\n`).join(''))]));
    const {chromium}=require('@playwright/test');browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:940},locale:'zh-CN'});const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
    await p.goto(base);await p.getByLabel('登录名',{exact:true}).fill('admin');await p.getByLabel('密码',{exact:true}).fill('IntegrationAdmin123');await p.getByRole('button',{name:'登录',exact:true}).click();
    await p.getByRole('button',{name:'日志清单'}).click();await p.getByLabel("选择 api space's.log").first().check();await p.getByLabel("选择 api space's.log").nth(1).check();await p.getByRole('button',{name:'加入并阅读'}).click();
    await until(()=>a.active>0&&b.active>0);await p.locator('.log-pane').first().getByText('request completed',{exact:false}).first().waitFor();
    await p.screenshot({path:path.join(root,'.local/mvp-workspace.png'),fullPage:true});
    const before=await p.locator('.log-pane').first().boundingBox();await p.getByRole('button',{name:'日志清单'}).click();await p.getByRole('dialog').waitFor();await p.locator('.file-table-row').first().waitFor();const after=await p.locator('.log-pane').first().boundingBox();assert.equal(before.width,after.width,'drawer must not resize log panes');
    await p.screenshot({path:path.join(root,'.local/mvp-inventory.png'),fullPage:true});await p.getByRole('button',{name:'关闭',exact:true}).click();
    assert.ok(await p.locator('.log-pane').first().locator('.log-scroll').evaluate(e=>e.scrollHeight>e.clientHeight),'menu regression needs an overflowing log viewport');
    await p.locator('.log-pane').first().getByRole('button',{name:/更多操作/}).click();
    const liveRows=await p.locator('.log-pane').first().locator('.log-scroll').innerText();
    await until(async()=>await p.locator('.log-pane').first().locator('.log-scroll').innerText()!==liveRows);
    assert.equal(await p.getByRole('menuitem',{name:'停止接收',exact:true}).isVisible(),true,'live autoscroll must not close the action menu');
    await p.getByRole('menuitem',{name:'停止接收',exact:true}).click();await until(()=>a.active+b.active===1);assert.equal(await p.locator('.log-pane').count(),2);
    await p.locator('.log-pane').first().getByRole('button',{name:/更多操作/}).click();await p.getByRole('menuitem',{name:'继续接收',exact:true}).click();
    await until(()=>a.active+b.active===2);await p.locator('.log-pane').first().getByText('已重新读取最近快照；中断期间的记录可能未显示，统计重新开始。',{exact:true}).waitFor();
    await p.locator('.log-pane').first().getByRole('button',{name:/更多操作/}).click();await p.getByRole('menuitem',{name:'停止接收',exact:true}).click();await until(()=>a.active+b.active===1);
    const stoppedCount=await p.locator('.log-pane').first().locator('.match-count').innerText();
    await p.getByRole('button',{name:'专注模式'}).click();assert.equal(await p.locator('.app-header').isVisible(),false);await p.keyboard.press('Escape');assert.equal(await p.locator('.app-header').isVisible(),true);
    await p.getByRole('button',{name:'团队成员',exact:true}).click();await p.getByRole('heading',{name:'团队成员'}).waitFor();await p.getByRole('button',{name:'添加成员'}).click();await p.getByLabel('登录名',{exact:true}).fill('browseruser');await p.getByLabel('显示名称').fill('浏览器测试成员');await p.getByLabel('初始密码').fill('BrowserUser12345');await p.getByRole('button',{name:'保存',exact:true}).click();await p.getByRole('heading',{name:'浏览器测试成员'}).waitFor();
    assert.equal(a.active+b.active,1,'opening management pages must preserve active streams');
    await p.getByRole('button',{name:'日志工作台',exact:true}).click();assert.equal(await p.locator('.log-pane').count(),2);
    await p.locator('.log-pane').first().locator('.log-line').first().waitFor();
    assert.equal(await p.locator('.log-pane').first().locator('.match-count').innerText(),stoppedCount,'management navigation preserves the stopped pane buffer');
    await workspaceBrowserChecks({page:p,admin,fixtures:[a,b],until});
    await reviewBrowserChecks({page:p,admin,fixtures:[a,b],until});
    await p.screenshot({path:path.join(root,'.local/mvp-workspace-restored.png'),fullPage:true});
    assert.deepEqual(errors,[]);await context.close();await browser.close();browser=null;
    console.log('PASS browser: login, inventory selection, dual live panes, overlay geometry, independent stop, focus mode, member creation; no page errors');
  }
  await admin.request(`/users/${viewer.id}`,{username:'viewer',displayName:'研发查看者',role:'Viewer',password:null,enabled:false},'PUT');
  await v.request('/config',undefined,'GET',401);
  console.log('PASS disabled account immediately loses access');
  const oldCookie=admin.cookie();await admin.request('/logout',{},'POST',204);
  const invalidated=await fetch(base+'/api/config',{headers:{Cookie:oldCookie}});assert.equal(invalidated.status,401);
  console.log('PASS logout invalidates previously issued authentication cookie');
}catch(error){
  if(browser)for(const context of browser.contexts())for(const p of context.pages())
    await p.screenshot({path:path.join(root,'.local/mvp-failure.png'),fullPage:true}).catch(()=>{});
  throw error;
}finally{
  if(browser)await browser.close();app.kill();await a.close();await b.close();await writeFile(path.join(storage,'server.log'),output);
}
