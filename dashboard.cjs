#!/usr/bin/env node
// fresh-eyes dashboard: one local page showing every pull request's path through the fresh-eyes gate across repos,
// with an automerge label the operator toggles. A labelled PR is merged once the review comment approves its current
// head, by the same rule require-review.cjs applies, pinned with --match-head-commit so a later push is refused.
// Every GitHub call goes through gh, so this file never sees a token. Bound to 127.0.0.1 only.
// Usage: node dashboard.cjs --repo owner/name [--repo ...] [--port 7331] [--method squash|merge|rebase]
//        [--label automerge] [--every 60]      or      node dashboard.cjs --discover [--rediscover] [...same flags]
'use strict';
const {execFile}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const {decide,headOf,verdictOf,MARKER}=require('./require-review.cjs');

const REPO_RE=/^[\w.-]+\/[\w.-]+$/;
const METHODS=['squash','merge','rebase'];

function parseArgs(argv){
 const o={repos:[],port:7331,method:'squash',label:'automerge',every:60,discover:false,rediscover:false};
 for(let i=0;i<argv.length;i++){
  const a=argv[i],value=()=>{const v=argv[++i];if(v===undefined||v.startsWith('--'))throw Error(a+' needs a value');return v;};
  if(a==='--repo'){const r=value();if(!REPO_RE.test(r))throw Error('--repo must be owner/name');o.repos.push(r);}
  else if(a==='--port'){o.port=+value();if(!Number.isInteger(o.port)||o.port<1||o.port>65535)throw Error('--port must be a number from 1 to 65535');}
  else if(a==='--method'){o.method=value();if(!METHODS.includes(o.method))throw Error('--method must be '+METHODS.join(', '));}
  else if(a==='--label'){o.label=value();if(!/^[\w][\w .:-]{0,49}$/.test(o.label))throw Error('--label must be a plain label name');}
  else if(a==='--every'){const n=+value();if(!Number.isInteger(n))throw Error('--every must be a whole number of seconds');o.every=Math.max(15,n);}
  else if(a==='--discover')o.discover=true;
  else if(a==='--rediscover')o.rediscover=true;
  else throw Error('unknown argument '+a);
 }
 if(o.repos.length&&o.discover)throw Error('give --repo or --discover, not both');
 if(!o.repos.length&&!o.discover)throw Error('name repositories with --repo owner/name, or pass --discover to scan your repositories for workflows using fresh-eyes');
 if(o.rediscover&&!o.discover)throw Error('--rediscover needs --discover');
 return o;
}

// The bot's comment as the page reads it, or null when it is not a fresh-eyes comment. Findings are the
// `**SEVERITY** file:line — ...` lines the prompt asks for, counted whether or not the model made them a list.
const SEV=s=>new RegExp('^\\s*(?:[-*]|\\d+[.)])?\\s*\\*\\*'+s+'\\*\\*','gm');
function parseComment(body){
 if(typeof body!=='string'||!body.startsWith(MARKER))return null;
 const count=s=>(body.match(SEV(s))||[]).length;
 return {body,head:headOf(body),verdict:verdictOf(body),model:body.match(/^### Fresh-eyes review — `([^`]+)`/m)?.[1]||null,critical:count('CRITICAL'),high:count('HIGH')};
}

const labelled=(pr,label)=>(pr.labels||[]).some(l=>l?.name===label);
// One attempt per head: a merge that failed is not retried until a push, and a merged head is not merged again.
const tried=pr=>pr.automerge?.last&&pr.automerge.last.head===pr.headRefOid?pr.automerge.last:null;

// Every condition the loop needs before it runs gh pr merge. The approval itself is the hook's rule, decide().
// MERGEABLE only means no conflicts; CLEAN or HAS_HOOKS is GitHub saying branch protection (required checks) is met.
const READY=['CLEAN','HAS_HOOKS'];
function shouldMerge(pr,comment,label){
 if(!pr||pr.state!=='OPEN'||pr.isDraft||pr.mergeable!=='MERGEABLE'||!READY.includes(pr.mergeStateStatus)||!labelled(pr,label))return false;
 if(!comment||decide([comment.body],pr.headRefOid||'')!==null)return false;
 return !tried(pr);
}

// The review job in the head's check rollup: a CheckRun (status/conclusion) or a commit status (state). A job named
// fresh-eyes wins; otherwise the word review on its own, so deploy-preview and the like never count.
function checkStage(pr){
 const rollup=pr.statusCheckRollup||[],named=re=>rollup.find(r=>re.test(r.name||r.context||''));
 const run=named(/fresh-eyes/i)||named(/\breview\b/i);
 if(!run)return 'none';
 if(run.status&&run.status!=='COMPLETED')return 'pending';
 if(run.state==='PENDING'||run.state==='EXPECTED')return 'pending';
 const end=run.conclusion||run.state;
 return end==='SUCCESS'?'pass':end==='SKIPPED'||end==='NEUTRAL'?'none':'fail'; // a skipped review is no result, not a failure
}

// The five chips of a row. Pure: pr as gh lists it (plus pr.automerge from the loop), the parsed comment or null.
function stages(pr,comment,label){
 const end=pr.state==='MERGED'||pr.mergedAt?'merged':pr.state==='CLOSED'?'closed':pr.isDraft?'draft':'open';
 const verdict=!comment?'none':comment.head!==pr.headRefOid?'stale':comment.verdict||'unparsed';
 const last=tried(pr);
 const automerge=!labelled(pr,label)?'off':end==='merged'||last?.ok?'merged':last?'failed':shouldMerge(pr,comment,label)?'merging':'waiting';
 return {opened:{author:pr.author?.login||'?',at:pr.createdAt},check:checkStage(pr),verdict,critical:comment?.critical||0,high:comment?.high||0,automerge,end};
}

const BOT=process.env.FRESH_EYES_BOT||'github-actions[bot]'; // who posts the review: the action's default token
const CACHE=()=>process.env.FRESH_EYES_CACHE||path.join(os.homedir(),'.cache','fresh-eyes','repos.json');
const DAY=86_400_000;
const PR_FIELDS='number,title,url,author,createdAt,updatedAt,isDraft,state,mergedAt,headRefOid,baseRefName,labels,mergeable,mergeStateStatus,statusCheckRollup';

// All of GitHub, through gh: async so the page stays responsive while a refresh walks the repos. Tests replace it.
const io={gh:(args,input)=>new Promise((resolve,reject)=>{
 // The timeout: a hung gh would otherwise hold the tick queue, and every refresh and merge behind it, for good.
 const child=execFile('gh',args,{encoding:'utf8',maxBuffer:64<<20,timeout:120_000},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout));
 child.stdin.on('error',()=>{}); // a gh that exits before reading its input is reported by the callback, not an EPIPE crash
 child.stdin.end(input??'');
})};
const firstLine=e=>String(e?.stderr||e?.message||e).split('\n').map(s=>s.trim()).find(Boolean)||'unknown error';
const now=()=>new Date().toISOString();

// One repo: open PRs and the 20 most recently closed, plus the bot's newest review comment per PR from the repo's
// recent comments (two pages at most), so a repo costs three or four calls however many PRs it has.
async function fetchRepo(repo){
 const list=state=>io.gh(['pr','list','--repo',repo,'--state',state,'--limit',state==='open'?'100':'20','--json',PR_FIELDS]).then(JSON.parse);
 const [open,closed]=await Promise.all([list('open'),list('closed')]);
 const comments={};
 for(const page of [1,2]){
  const batch=JSON.parse(await io.gh(['api','repos/'+repo+'/issues/comments?sort=updated&direction=desc&per_page=100&page='+page]));
  for(const c of batch){
   const n=+String(c.issue_url).split('/').pop();
   if(c.user?.login!==BOT||comments[n])continue; // newest first: the first hit per PR is the live comment
   const parsed=parseComment(c.body);
   if(parsed)comments[n]=parsed;
  }
  if(batch.length<100)break;
 }
 return {prs:[...open,...closed],comments};
}

const row=(state,repo,pr,comment,label)=>{pr.automerge=state.merges[repo+'#'+pr.number]||null;return {pr,comment,stages:stages(pr,comment,label)};};

// A repo that cannot be read keeps its last rows and shows the error; it never gains an approval.
async function refresh(state,opts,only){
 for(const repo of only||opts.repos){
  const r=state.repos[repo]||(state.repos[repo]={rows:[],error:null});
  try{
   const {prs,comments}=await fetchRepo(repo);
   r.rows=prs.map(pr=>row(state,repo,pr,comments[pr.number]||null,opts.label));
   r.error=null;
  }catch(e){r.error=firstLine(e);}
 }
 state.at=now();
}

// Merges pinned to the head that was checked: gh refuses if a push landed in between. One attempt per head.
// `only` limits the pass to the repos a refresh just read, as refresh() does.
async function automerge(state,opts,only){
 for(const repo of only||Object.keys(state.repos)){
  const r=state.repos[repo];
  if(r.error)continue; // rows kept from before a failed refresh are stale: never merge from them
  for(const x of r.rows){
   if(!shouldMerge(x.pr,x.comment,opts.label))continue;
   const head=x.pr.headRefOid;
   let last;
   try{await io.gh(['pr','merge',String(x.pr.number),'--repo',repo,'--'+opts.method,'--match-head-commit',head]);last={head,ok:true,at:now(),message:'merged '+head.slice(0,7)};}
   catch(e){last={head,ok:false,at:now(),message:firstLine(e)};}
   state.merges[repo+'#'+x.pr.number]={last};
   x.pr.automerge={last};
   x.stages=stages(x.pr,x.comment,opts.label);
   console.error((last.ok?'merged ':'merge failed ')+repo+'#'+x.pr.number+': '+last.message);
  }
 }
}

// The label is created on first use in a repo that lacks it; every other gh error is the caller's to show.
async function setLabel(repo,number,on,label){
 const edit=()=>io.gh(['pr','edit',String(number),'--repo',repo,on?'--add-label':'--remove-label',label]);
 try{await edit();}
 catch(e){
  if(!on||!/not found/i.test(firstLine(e)))throw e;
  await io.gh(['label','create',label,'--repo',repo,'--color','0E8A16','--description','fresh-eyes dashboard: merge when the review approves']);
  await edit();
 }
}

// Opt-in: your non-archived repos whose workflow files mention fresh-eyes. Code search is not used because it lags
// and misses private repos; this costs a call per repo plus one per workflow file, so the result is kept for a day.
async function discover(opts){
 if(!opts.rediscover){try{const c=JSON.parse(fs.readFileSync(CACHE(),'utf8'));if(Date.now()-c.at<DAY&&c.repos.length)return c.repos;}catch{}}
 const me=(await io.gh(['api','user','--jq','.login'])).trim();
 const all=JSON.parse(await io.gh(['repo','list',me,'--no-archived','--limit','200','--json','nameWithOwner'])).map(r=>r.nameWithOwner);
 const repos=[];
 for(const repo of all){
  let files;
  try{files=JSON.parse(await io.gh(['api','repos/'+repo+'/contents/.github/workflows']));}catch{continue;} // no workflows
  for(const f of files){
   if(!/\.ya?ml$/.test(f.name))continue;
   const text=await io.gh(['api','-H','Accept: application/vnd.github.raw+json','repos/'+repo+'/contents/'+f.path]);
   if(/fresh-eyes/.test(text)){repos.push(repo);break;}
  }
 }
 fs.mkdirSync(path.dirname(CACHE()),{recursive:true});
 fs.writeFileSync(CACHE(),JSON.stringify({at:Date.now(),repos}));
 if(!repos.length)throw Error('no repository of '+me+' has a workflow mentioning fresh-eyes: name them with --repo owner/name');
 return repos;
}

// The custom header stops cross-origin pages (CSRF): they cannot send it without a preflight, which 404s. A DNS
// rebinding page is same-origin and could send it, so every request must also name this server in its Host.
const HEADER='x-fresh-eyes';
const status=(code,message)=>Object.assign(Error(message),{status:code});

// Only a repo this run covers and a PR it has listed can be acted on: anything else is a bad request, not a gh call.
function find(state,repo,pr){
 if(!Object.hasOwn(state.repos,repo))throw status(400,'unknown repo'); // own keys only: ?repo=constructor is not a repo
 const r=state.repos[repo];
 const x=r.rows.find(y=>y.pr.number===pr);
 if(!x)throw status(400,'unknown pr');
 return x;
}
const guard=req=>{if(req.headers[HEADER]!=='1')throw status(403,'missing '+HEADER+' header');};

// What the page gets: the fields it draws, labels as names, never a comment body (that is a click away).
function publicState(state,opts){
 const repos={};
 for(const [repo,r] of Object.entries(state.repos))repos[repo]={error:r.error,rows:r.rows.map(({pr,stages})=>({
  pr:{number:pr.number,title:pr.title,url:pr.url,headRefOid:pr.headRefOid,createdAt:pr.createdAt,updatedAt:pr.updatedAt,labels:(pr.labels||[]).map(l=>l.name),automerge:pr.automerge},stages}))};
 return {at:state.at,label:opts.label,method:opts.method,every:opts.every,repos};
}

const readBody=req=>new Promise((resolve,reject)=>{let s='';req.on('data',d=>{s+=d;if(s.length>10_000){reject(status(413,'body too large'));req.destroy();}});req.on('end',()=>resolve(s));});

async function handle(req,res,state,opts,tick){
 const port=req.socket.localPort;
 if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))throw status(403,'unexpected Host header');
 const url=new URL(req.url,'http://127.0.0.1');
 const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(req.method==='GET'){
  if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(PAGE);}
  if(url.pathname==='/api/state')return json(200,publicState(state,opts));
  if(url.pathname==='/api/review'){
   const wantHtml=url.searchParams.get('html')==='1';
   if(wantHtml)guard(req); // rendering spends a gh call: only the page, which sends the header, may ask for it
   const repo=url.searchParams.get('repo'),x=find(state,repo,+url.searchParams.get('pr'));
   const body=x.comment?.body||null;
   const html=body&&wantHtml?await io.gh(['api','markdown','--input','-'],JSON.stringify({text:body,mode:'gfm',context:repo})):null;
   return json(200,{body,html,url:x.pr.url});
  }
 }else if(req.method==='POST'){
  guard(req);
  let data;
  try{data=JSON.parse(await readBody(req)||'{}');}catch{throw status(400,'body must be JSON');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw status(400,'body must be a JSON object');
  if(url.pathname==='/api/refresh'){await tick();return json(200,{ok:true});}
  if(url.pathname==='/api/label'){
   const x=find(state,data.repo,data.pr);
   if(data.on)delete state.merges[data.repo+'#'+x.pr.number]; // re-labelling is the operator's retry for a head that failed
   await setLabel(data.repo,x.pr.number,!!data.on,opts.label);
   await tick([data.repo]);
   return json(200,{ok:true});
  }
 }
 throw status(404,'not found');
}

function serve(state,opts,tick){
 const server=http.createServer((req,res)=>handle(req,res,state,opts,tick).catch(e=>{
  res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:firstLine(e)}));
 }));
 server.on('error',e=>{console.error(firstLine(e));process.exit(1);}); // a busy port is one line, not a stack trace
 server.listen(opts.port,'127.0.0.1');
 return server;
}

// The page: one column of repos, a row per PR with five stage chips and the automerge toggle; a click opens the
// review beside it. PR text is set with textContent; only GitHub's sanitised markdown render goes in as HTML.
const PAGE=`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>fresh-eyes</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--mute:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--wait:#0969da;--chip:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mute:#8d96a0;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--wait:#58a6ff;--chip:#161b22}}
body{margin:0;font:14px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);height:100vh}
header{grid-column:1/3;display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid var(--line)}
header .err{color:var(--bad)}
main,aside{overflow:auto;padding:8px 16px}
aside{border-left:1px solid var(--line)}
h2{font-size:15px;margin:12px 0 4px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 8px;border:1px solid var(--line);border-radius:6px;margin:4px 0;cursor:pointer}
.row:hover,.row.sel{background:var(--chip)}
.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.title a{color:inherit;text-decoration:none}
.chips{display:flex;flex-wrap:wrap;gap:4px;font-size:12px;color:var(--mute)}
.chip{padding:1px 6px;border:1px solid var(--line);border-radius:10px;background:var(--chip)}
.pass,.APPROVE,.merged{color:var(--ok);border-color:var(--ok)}
.fail,.REQUEST_CHANGES,.failed{color:var(--bad);border-color:var(--bad)}
.pending,.waiting,.stale,.unparsed{color:var(--warn);border-color:var(--warn)}
.merging{color:var(--wait);border-color:var(--wait)}
.note{grid-column:1/3;font-size:12px;color:var(--mute)}
button{font:inherit;padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--chip);color:var(--fg);cursor:pointer}
button.on{border-color:var(--ok);color:var(--ok)}
pre{white-space:pre-wrap}
@media(max-width:900px){body{grid-template-columns:1fr;height:auto}header{grid-column:1}aside{border-left:0;border-top:1px solid var(--line)}}
</style>
<header><strong>fresh-eyes</strong><span id="at"></span><button id="refresh">Refresh</button><span id="errors" class="err"></span></header>
<main id="main"></main>
<aside id="aside"><p id="hint">Click a pull request to read its review.</p><p id="link"></p><div id="review"></div></aside>
<script>
const HEADER='${HEADER}';
let state=null,selected=null;
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const age=iso=>{const h=Math.round((Date.now()-new Date(iso))/36e5);return h<48?h+'h':Math.round(h/24)+'d';};
async function load(){state=await (await fetch('/api/state')).json();draw();}
async function post(path,data){
 const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',[HEADER]:'1'},body:JSON.stringify(data||{})});
 if(!r.ok)alert((await r.json()).error);
 await load();
}
function draw(){
 document.getElementById('at').textContent=state.at?'updated '+new Date(state.at).toLocaleTimeString()+', every '+state.every+'s':'loading…';
 document.getElementById('errors').textContent=Object.entries(state.repos).filter(([,r])=>r.error).map(([k,r])=>k+': '+r.error).join(' · ');
 const main=document.getElementById('main');main.replaceChildren();
 for(const [repo,r] of Object.entries(state.repos)){
  main.append(el('h2','',repo));
  if(!r.rows.length)main.append(el('p','note','no pull requests'));
  for(const {pr,stages:s} of r.rows){
   const row=el('div','row'+(selected===repo+'#'+pr.number?' sel':''));
   const title=el('div','title');const a=el('a','','#'+pr.number+' '+pr.title);a.href=pr.url;a.target='_blank';a.rel='noopener';title.append(a);
   const chips=el('div','chips');
   chips.append(el('span','chip',s.opened.author+' · '+age(s.opened.at)),el('span','chip '+s.check,'check: '+s.check),
    el('span','chip '+s.verdict,'verdict: '+s.verdict+(s.critical||s.high?' ('+s.critical+' critical, '+s.high+' high)':'')),
    el('span','chip '+s.automerge,'automerge: '+s.automerge),el('span','chip '+s.end,s.end));
   const btn=el('button',s.automerge!=='off'?'on':'',s.automerge==='off'?'label '+state.label:'unlabel');
   btn.onclick=e=>{e.stopPropagation();post('/api/label',{repo,pr:pr.number,on:s.automerge==='off'});};
   row.append(title,btn,chips);
   if(pr.automerge?.last)row.append(el('div','note',(pr.automerge.last.ok?'merged ':'merge failed ')+new Date(pr.automerge.last.at).toLocaleString()+': '+pr.automerge.last.message));
   row.onclick=()=>show(repo,pr);
   main.append(row);
  }
 }
}
async function show(repo,pr){
 selected=repo+'#'+pr.number;draw();
 const rv=await (await fetch('/api/review?repo='+encodeURIComponent(repo)+'&pr='+pr.number+'&html=1',{headers:{[HEADER]:'1'}})).json();
 const link=document.getElementById('link');link.replaceChildren();const a=el('a','',repo+'#'+pr.number);a.href=rv.url;a.target='_blank';a.rel='noopener';link.append(a);
 document.getElementById('hint').textContent='';
 const box=document.getElementById('review');box.replaceChildren();
 if(rv.html)box.innerHTML=rv.html;else box.append(el('p','note',rv.body?'could not render':'no fresh-eyes review on this pull request'));
}
document.getElementById('refresh').onclick=()=>post('/api/refresh');
load();setInterval(load,30_000);
</script>
`;

async function main(){
 const opts=parseArgs(process.argv.slice(2));
 try{await io.gh(['auth','status']);}catch(e){throw Error('gh is not installed or not logged in ('+firstLine(e)+')');}
 if(opts.discover)opts.repos=await discover(opts);
 const state={at:null,repos:{},merges:{}};
 for(const r of opts.repos)state.repos[r]={rows:[],error:null};
 // One queue for timer ticks, the refresh button and label clicks: no two refreshes or merge passes ever overlap.
 // The timer skips while anything is queued or running, so a slow refresh never builds a backlog.
 let chain=Promise.resolve(),pending=0;
 const tick=only=>{pending++;const run=chain.then(()=>refresh(state,opts,only)).then(()=>automerge(state,opts,only)).finally(()=>pending--);chain=run.catch(()=>{});return run;};
 const server=serve(state,opts,tick);
 server.on('listening',()=>console.error('fresh-eyes dashboard on http://127.0.0.1:'+server.address().port+' — '+opts.repos.length+' repo(s), refresh every '+opts.every+'s, label '+opts.label+', merge --'+opts.method));
 await tick();
 setInterval(()=>{if(!pending)tick().catch(e=>console.error('refresh failed: '+firstLine(e)));},opts.every*1000);
}

if(require.main===module)main().catch(error=>{console.error(error?.message||error);process.exit(1);});

module.exports={parseArgs,parseComment,stages,shouldMerge,io,firstLine,fetchRepo,refresh,automerge,setLabel,discover,PR_FIELDS,serve,handle,publicState,HEADER,PAGE};
