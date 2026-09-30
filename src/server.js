import express from 'express';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, normalize } from './store.js';
import { validateGroupNames, resolveGroupNames } from './group-names.js';

const { ADMIN_USER, ADMIN_PASSWORD, WEBHOOK_TOKEN }=process.env;
if(!ADMIN_USER || !ADMIN_PASSWORD || ADMIN_PASSWORD.length<12 || !WEBHOOK_TOKEN || WEBHOOK_TOKEN.length<24) throw new Error('Configura ADMIN_USER, ADMIN_PASSWORD (12+ caracteres) y WEBHOOK_TOKEN (24+ caracteres)');
const dataDir=resolve(process.env.DATA_DIR || './data'); mkdirSync(dataDir,{recursive:true});
const store=new Store(`${dataDir}/alertas.sqlite`);
const mock=process.env.MOCK_WHATSAPP==='true';
const wa=mock?{status:'ready',state:async()=>({status:'mock',qr:null}),groups:async()=>[{id:'123456@g.us',name:'Grupo de prueba'}],send:async()=>{},start:async()=>{}}:new (await import('./whatsapp.js')).WhatsApp(dataDir);
const app=express(); app.disable('x-powered-by');
app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});next();});
app.use(express.json({limit:'128kb'}));
const same=(a,b)=>{const aa=Buffer.from(String(a)),bb=Buffer.from(String(b));return aa.length===bb.length && timingSafeEqual(aa,bb);};
const sessions=new Map(), attempts=new Map();
const salt=randomBytes(16), passwordHash=scryptSync(ADMIN_PASSWORD,salt,64);
setInterval(()=>{const now=Date.now();for(const [k,v] of sessions)if(v.expires<now)sessions.delete(k);for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);},60000).unref();
const cookie='alertas_session';
function session(req) { const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${cookie}=`))?.slice(cookie.length+1);const s=sessions.get(token);return s && s.expires>Date.now()?{...s,token}:null; }
app.get('/healthz',(req,res)=>res.json({ok:true}));
app.post('/zabbix-webhook',(req,res)=>{
  if(!same(req.headers.authorization||'',`Bearer ${WEBHOOK_TOKEN}`))return res.status(401).json({error:'Token inválido'});
  try {normalize(req.body);} catch(e){return res.status(400).json({error:e.message});}
  try {res.json(store.accept(req.body));} catch(e){console.error('Persistencia:',e.message);res.status(500).json({error:'No se pudo guardar la alerta; reintentar'});}
});
app.post('/api/login',(req,res)=>{
  if(req.get('X-Requested-With')!=='alertas')return res.sendStatus(403);
  const ip=req.ip, now=Date.now(), limit=attempts.get(ip);
  if(limit && limit.until>now && limit.count>=10)return res.status(429).json({error:'Demasiados intentos. Espera 15 minutos.'});
  const {username,password}=req.body||{};
  if(typeof username!=='string'||typeof password!=='string'||password.length>512)return res.status(400).json({error:'Credenciales inválidas'});
  const valid=timingSafeEqual(scryptSync(password,salt,64),passwordHash) && same(username,ADMIN_USER);
  if(!valid){attempts.set(ip,{count:limit?.until>now?limit.count+1:1,until:limit?.until>now?limit.until:now+900000});return res.status(401).json({error:'Credenciales inválidas'});}
  attempts.delete(ip); const previous=session(req);if(previous)sessions.delete(previous.token);
  const token=randomBytes(32).toString('hex'), csrf=randomBytes(24).toString('hex');sessions.set(token,{csrf,expires:now+8*3600000});
  res.cookie(cookie,token,{httpOnly:true,sameSite:'strict',secure:false,maxAge:8*3600000,path:'/'}).json({csrf});
});
app.use('/api',(req,res,next)=>{
  const s=session(req);if(!s)return res.status(401).json({error:'Inicia sesión'});
  req.session=s;
  if(!['GET','HEAD'].includes(req.method)&&!same(req.get('X-CSRF-Token')||'',s.csrf))return res.status(403).json({error:'Sesión inválida'});
  next();
});
app.get('/api/session',(req,res)=>res.json({csrf:req.session.csrf}));
app.post('/api/logout',(req,res)=>{sessions.delete(req.session.token);res.clearCookie(cookie,{path:'/'}).json({ok:true});});
app.get('/api/status',async(req,res)=>res.json(await wa.state()));
app.post('/api/reconnect',(req,res)=>{void wa.start();res.json({ok:true});});

app.get('/api/config',(req,res)=>res.json(store.config()));
app.put('/api/config',async(req,res)=>{
  try {
    let config=req.body;
    if(Object.hasOwn(config || {},'groupNames')) {
      const names=validateGroupNames(config.groupNames);
      const previous=store.config();
      const previousNames=previous.groupNames || previous.groups;
      if(JSON.stringify(names)===JSON.stringify(previousNames)) {
        config={...config,groups:previous.groups,groupNames:previousNames};
      } else {
        const resolved=names.length?resolveGroupNames(names,await wa.groups()):[];
        config={...config,groups:[...new Set(resolved.map(g=>g.id))],groupNames:[...new Map(resolved.map(g=>[g.id,g.name])).values()]};
      }
    } else {
      // Compatibilidad con clientes anteriores que envían IDs directamente.
      config={...config,groupNames:config?.groups};
    }
    store.saveConfig(config);
    res.json({ok:true,groupNames:config.groupNames});
  }catch(e){res.status(400).json({error:e.message || 'No se pudieron guardar los grupos.'});}
});
app.get('/api/history',(req,res)=>res.json(store.snapshot()));
app.post('/api/jobs/:id/retry',(req,res)=>{try{store.retry(Number(req.params.id));res.json({ok:true});}catch(e){res.status(409).json({error:e.message});}});
app.use(express.static(resolve('public')));
app.use((err,req,res,next)=>{console.error(err.message);res.status(err.status||500).json({error:err.status===413?'Petición demasiado grande':err.status===400?'JSON inválido':'Error interno'});});
let busy=false;
const worker=setInterval(async()=>{if(busy||wa.status!=='ready')return;const job=store.nextJob();if(!job)return;busy=true;try{await wa.send(job.destination,job.message);store.sent(job.id);}catch(e){store.failed(job,e.message);}finally{busy=false;}},2000);
const reconnect=setInterval(()=>{if(['error','disconnected'].includes(wa.status))void wa.start();},60000);
const server=app.listen(Number(process.env.PORT||9012),'0.0.0.0',()=>console.log('Panel HTTP y webhook listos'));
void wa.start();
async function shutdown(){clearInterval(worker);clearInterval(reconnect);server.close();if(wa.client)await wa.client.destroy().catch(()=>{});process.exit(0);}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
