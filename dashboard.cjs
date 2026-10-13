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
 return {body,head:headOf(body),verdict:verdictOf(body),model:body.match(/^### Fresh-eyes review — `([^`]+)`/m)?.[1]||null,critical:count('CRITICAL'),high:count('HIGH'),medium:count('MEDIUM'),low:count('LOW')};
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
 return {opened:{author:pr.author?.login||'?',at:pr.createdAt},check:checkStage(pr),verdict,critical:comment?.critical||0,high:comment?.high||0,medium:comment?.medium||0,low:comment?.low||0,automerge,end};
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
   return json(200,{body,html,url:x.pr.url,model:x.comment?.model||null});
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

// The page: summary counts, a PR list with a five-stage pipeline track per row, and a review drawer beside it.
// PR text is set with textContent; only GitHub's sanitised markdown render goes in as HTML.
const PAGE=`<!doctype html>
<html lang="en">
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>fresh-eyes</title>
<style>
:root{--bg:#F4F4F1;--card:#fff;--fg:#17191E;--mute:#5A5E68;--line:#E2E2DC;--soft:#EEEEE9;--ring:#C9CCD3;
 --ok:#15603C;--ok-bg:#E7F3EC;--ok-edge:#A9D3BA;--bad:#B4400C;--bad-bg:#FCEDE4;--bad-edge:#EDB89A;--wait:#8A5A00;--wait-bg:#FBF3E3;--wait-edge:#E7CD93;--link:#1F4FB8;
 --sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0F1115;--card:#171A20;--fg:#E8E9EC;--mute:#9DA2AD;--line:#2A2E37;--soft:#20242C;--ring:#4A4F5A;
 --ok:#4CC38A;--ok-bg:#132A1F;--ok-edge:#245A3E;--bad:#F08A5D;--bad-bg:#2E1A12;--bad-edge:#6B3420;--wait:#E0B04F;--wait-bg:#2A2312;--wait-edge:#5E4A1C;--link:#7FA7FF}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 var(--sans)}
a{color:var(--link)}
button{font:inherit;cursor:pointer}
header{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:12px 24px;background:#17191E;color:#F4F4F1}
header .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
header label{display:flex;align-items:center;gap:8px;font-size:13px;color:#B9BCC4}
header select{font:13px var(--mono);color:#F4F4F1;background:#262931;border:1px solid #3A3E48;border-radius:6px;padding:8px 10px;min-height:40px;max-width:70vw}
header .grow{flex:1 1 auto}
header .status{font-size:13px;color:#B9BCC4}
header button{font-weight:600;font-size:13px;color:#17191E;background:#F4F4F1;border:0;border-radius:6px;padding:10px 16px;min-height:44px}
.wrap{max-width:1440px;margin:0 auto;padding:20px 24px 48px;display:flex;flex-direction:column;gap:16px}
.err{margin:0;padding:10px 14px;border-radius:8px;background:var(--bad-bg);border:1px solid var(--bad-edge);color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:2px}
.tile .k,.cols,.eyebrow{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--mute)}
.tile .n{font-size:30px;font-weight:700;line-height:1.15}
.tile .h{font-size:13px;color:var(--mute)}
.split{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.list{flex:999 1 640px;min-width:0}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:4px;background:var(--soft);border-radius:8px;padding:4px}
.tabs button{font-size:13px;border:0;border-radius:6px;padding:8px 12px;min-height:36px;background:transparent;color:var(--mute)}
.tabs button[aria-pressed=true]{background:var(--card);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.1)}
.bar label{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--mute);min-height:44px}
.bar input{width:18px;height:18px;margin:0}
.cols,.row{display:grid;grid-template-columns:minmax(0,1fr) 340px 104px;gap:16px;padding:10px 14px}
.cols{border-bottom:1px solid var(--line)}.cols span:last-child{text-align:right}
h2.repo{margin:0;padding:12px 14px 4px;font:600 13px var(--mono);color:var(--mute)}
.row{align-items:center;padding:12px 14px;border-bottom:1px solid var(--soft);cursor:pointer}
.row:hover{background:var(--soft)}
.row.ready{box-shadow:inset 3px 0 0 var(--ok);background:color-mix(in srgb,var(--ok-bg) 60%,transparent)}
.row.attn{box-shadow:inset 3px 0 0 var(--bad)}
.row.sel{background:var(--soft);outline:2px solid var(--link);outline-offset:-2px}
.who{min-width:0;display:flex;flex-direction:column;gap:2px}
.title{all:unset;cursor:pointer;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:4px}
.title:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.num{font:500 13px var(--mono);color:var(--mute);margin-right:4px}
.meta{font-size:13px;color:var(--mute)}
.track{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}
.st{position:relative;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:12px;font-weight:500;color:var(--mute);text-align:center}
.st:not(:last-child)::after{content:"";position:absolute;top:7px;left:50%;width:100%;height:2px;background:var(--line)}
.st.ok:not(:last-child)::after{background:var(--ok)}
.dot{position:relative;z-index:1;width:16px;height:16px;border-radius:50%;background:var(--card);border:2px solid var(--ring)}
.st.ok{color:var(--ok)}.st.ok .dot{background:var(--ok);border-color:var(--ok)}
.st.bad{color:var(--bad)}.st.bad .dot{background:var(--bad);border-color:var(--bad)}
.st.wait{color:var(--wait)}.st.wait .dot{border:3px solid var(--wait)}
.st.ready{color:var(--ok)}.st.ready .dot{border:3px solid var(--ok)}
.act{display:flex;justify-content:flex-end}
.btn{font-size:13px;font-weight:600;border-radius:6px;padding:8px 12px;min-height:40px;color:var(--fg);background:var(--card);border:1px solid var(--ring);text-decoration:none;display:inline-flex;align-items:center}
.btn.go{color:#fff;background:var(--ok);border-color:var(--ok)}
.btn[aria-pressed=true]{color:var(--ok);border-color:var(--ok)}
.btn:disabled{color:var(--mute);background:var(--soft);border-color:var(--line);cursor:default}
.tag{font-size:12px;color:var(--mute)}
.note{grid-column:1/-1;font-size:12px;color:var(--mute)}
.note.bad{color:var(--bad)}
.foot{margin:0;padding:12px 14px;font-size:13px;color:var(--mute)}
.foot button{all:unset;cursor:pointer;color:var(--link);text-decoration:underline}
.empty{margin:0;padding:24px 14px;color:var(--mute)}
aside{flex:1 1 400px;min-width:0}
@media(min-width:1100px){aside{position:sticky;top:16px;max-height:calc(100vh - 32px);overflow:auto}}
.dh{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.dh h2{margin:0;font-size:17px;line-height:1.3}
.mono{font:12px var(--mono);color:var(--mute)}
.banner{margin:14px 18px;padding:12px 14px;border-radius:8px;border:1px solid var(--line);background:var(--soft);display:flex;flex-direction:column;gap:8px}
.banner strong{font-size:15px}
.banner.ok{background:var(--ok-bg);border-color:var(--ok-edge)}.banner.ok strong{color:var(--ok)}
.banner.bad{background:var(--bad-bg);border-color:var(--bad-edge)}.banner.bad strong{color:var(--bad)}
.banner.wait{background:var(--wait-bg);border-color:var(--wait-edge)}.banner.wait strong{color:var(--wait)}
.banner .btns{display:flex;flex-wrap:wrap;gap:8px}.banner .btn{min-height:44px;padding:10px 16px;font-size:14px}
.counts{margin:0 18px;font-size:13px;color:var(--mute)}
.md{padding:4px 18px 18px;overflow-wrap:anywhere}
.md code{font:12px var(--mono);background:var(--soft);padding:1px 4px;border-radius:4px}
.md h3{font-size:15px}
.hint{padding:18px;color:var(--mute)}
@media(max-width:820px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.cols{display:none}.row{grid-template-columns:1fr}.act{justify-content:flex-start}header{padding:12px 16px}.wrap{padding:16px}}
</style>
<header>
 <span class="brand"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>fresh-eyes</span>
 <label>Repository <select id="repo"></select></label>
 <span class="grow"></span>
 <span class="status" id="at">loading…</span>
 <button id="refresh">Refresh</button>
</header>
<div class="wrap">
 <p class="err" id="errors" hidden></p>
 <section class="tiles" id="tiles" aria-label="Summary"></section>
 <div class="split">
  <section class="card list" aria-label="Pull requests">
   <div class="bar">
    <div class="tabs" role="group" aria-label="Filter" id="tabs"></div>
    <span class="grow" style="flex:1 1 auto"></span>
    <label><input type="checkbox" id="merged"> <span id="mergedLabel">Show merged</span></label>
   </div>
   <div class="cols" aria-hidden="true"><span>Pull request</span><span>Pipeline</span><span>Automerge</span></div>
   <div id="rows"></div>
  </section>
  <aside class="card" id="aside" aria-live="polite"><p class="hint">Select a pull request to read its review.</p></aside>
 </div>
</div>
<script>
const HEADER='${HEADER}';
let state=null,selected=null,review=null,showMerged=false,tab='open',pick='';
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const age=iso=>{const h=Math.round((Date.now()-new Date(iso))/36e5);return h<1?'just now':h<48?h+'h ago':Math.round(h/24)+'d ago';};
const open=s=>s.end==='open';
const ready=s=>open(s)&&s.verdict==='APPROVE'&&s.check!=='fail'&&s.check!=='pending';
const blocked=s=>open(s)&&(s.verdict==='REQUEST_CHANGES'||s.check==='fail');
const attention=s=>blocked(s)||open(s)&&(s.verdict==='stale'||s.verdict==='unparsed'||s.automerge==='failed');
const awaiting=s=>open(s)&&(s.verdict==='none'||s.verdict==='stale'||s.check==='pending');
const TABS=[['open','Open',s=>open(s)||s.end==='draft'],['attention','Needs attention',attention],['closed','Closed',s=>s.end==='closed']];
// Each stage as [kind, label]: ok filled, bad blocked, wait ringed amber, ready ringed green, none empty.
function track(s){
 const check={pass:['ok','Check'],fail:['bad','Failed'],pending:['wait','Running'],none:['none','Check']}[s.check];
 const verdict={APPROVE:['ok','Approved'],REQUEST_CHANGES:['bad','Changes'],stale:['wait','Stale'],unparsed:['wait','Unclear'],none:['none','Verdict']}[s.verdict];
 const am={off:ready(s)?['ready','Ready']:['none','Automerge'],waiting:['wait','Queued'],merging:['wait','Merging'],merged:['ok','Merged'],failed:['bad','Failed']}[s.automerge];
 const end=s.end==='merged'?['ok','Merged']:s.end==='closed'?['none','Closed']:['none','Merged'];
 return [s.end==='draft'?['wait','Draft']:['ok','Opened'],check,verdict,am,end];
}
const counts=s=>[s.critical+' critical',s.high+' high',(s.medium||0)+' medium',(s.low||0)+' low'].join(' · ');
function meta(s){
 const who=s.opened.author+' · opened '+age(s.opened.at);
 if(s.end==='draft')return who+' · draft';
 if(s.verdict==='none')return who+' · no review yet';
 return who+' · '+s.critical+' critical, '+s.high+' high';
}
function rowsInView(){
 const out=[];
 for(const [repo,r] of Object.entries(state.repos))if(!pick||pick===repo)for(const x of r.rows)out.push({repo,...x});
 return out;
}
async function load(){state=await (await fetch('/api/state')).json();draw();}
async function post(path,data){
 const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',[HEADER]:'1'},body:JSON.stringify(data||{})});
 if(!r.ok){const e=(await r.json()).error;$('errors').hidden=false;$('errors').textContent=e;}
 await load();
}
function labelButton(repo,pr,s,big){
 if(s.end==='draft'){const b=el('button','btn','Draft');b.disabled=true;return b;}
 if(!open(s))return el('span','tag',s.end);
 const on=s.automerge!=='off';
 const b=el('button','btn'+(!on&&ready(s)?' go':''),on?'Labelled':'Label '+(big?state.label:''));
 b.setAttribute('aria-pressed',String(on));
 b.title=on?'Remove the '+state.label+' label':'Add the '+state.label+' label';
 b.onclick=e=>{e.stopPropagation();post('/api/label',{repo,pr:pr.number,on:!on});};
 return b;
}
function draw(){
 const repos=Object.keys(state.repos);
 const sel=$('repo');sel.replaceChildren();
 const all=el('option','','All repositories ('+repos.length+')');all.value='';sel.append(all);
 for(const r of repos){const o=el('option','',r);o.value=r;sel.append(o);}
 sel.value=pick;
 $('at').textContent=state.at?'Updated '+new Date(state.at).toLocaleTimeString()+' · every '+state.every+' s · '+state.method+' · label '+state.label:'loading…';
 const errs=Object.entries(state.repos).filter(([,r])=>r.error).map(([k,r])=>k+': '+r.error);
 $('errors').hidden=!errs.length;$('errors').textContent=errs.join(' · ');
 const view=rowsInView(),ss=view.map(x=>x.stages);
 const tiles=[['Ready to merge',ss.filter(s=>ready(s)&&s.automerge!=='merged').length,'Approved for the current head','var(--ok)'],
  ['Blocked by review',ss.filter(blocked).length,'Critical or high findings, or a failed check','var(--bad)'],
  ['Awaiting review',ss.filter(awaiting).length,'No review for the current head','var(--wait)'],
  ['Drafts',ss.filter(s=>s.end==='draft').length,'Not reviewed until ready','var(--fg)']];
 $('tiles').replaceChildren(...tiles.map(([k,n,h,c])=>{const t=el('div','tile');const v=el('span','n',String(n));v.style.color=c;t.append(el('span','k',k),v,el('span','h',h));return t;}));
 $('tabs').replaceChildren(...TABS.map(([id,name,f])=>{const b=el('button','',name+' '+ss.filter(f).length);b.setAttribute('aria-pressed',String(tab===id));b.onclick=()=>{tab=id;draw();};return b;}));
 const merged=view.filter(x=>x.stages.end==='merged');
 $('mergedLabel').textContent='Show merged ('+merged.length+')';
 const f=TABS.find(t=>t[0]===tab)[2];
 const shown=view.filter(x=>f(x.stages)||showMerged&&x.stages.end==='merged');
 const box=$('rows');box.replaceChildren();
 if(!shown.length)box.append(el('p','empty',tab==='attention'?'Nothing needs attention.':'No pull requests here.'));
 let last=null;
 for(const {repo,pr,stages:s} of shown){
  if(!pick&&repos.length>1&&repo!==last){box.append(el('h2','repo',repo));last=repo;}
  const key=repo+'#'+pr.number;
  const row=el('div','row'+(ready(s)&&s.automerge==='off'?' ready':'')+(attention(s)?' attn':'')+(selected===key?' sel':''));
  const who=el('div','who'),title=el('button','title');
  title.append(el('span','num','#'+pr.number),document.createTextNode(pr.title));
  title.onclick=e=>{e.stopPropagation();show(repo,pr.number);};
  who.append(title,el('span','meta',meta(s)));
  const ol=el('ol','track');ol.setAttribute('aria-label','Pipeline stages');
  for(const [k,l] of track(s)){const li=el('li','st '+k);li.append(el('span','dot'),el('span','',l));ol.append(li);}
  const act=el('div','act');act.append(labelButton(repo,pr,s));
  row.append(who,ol,act);
  if(pr.automerge?.last)row.append(el('div','note'+(pr.automerge.last.ok?'':' bad'),(pr.automerge.last.ok?'Merged ':'Merge failed ')+new Date(pr.automerge.last.at).toLocaleString()+': '+pr.automerge.last.message));
  row.onclick=()=>show(repo,pr.number);
  box.append(row);
 }
 if(!showMerged&&merged.length){const p=el('p','foot',merged.length+' merged hidden. ');const b=el('button','','Show them');b.onclick=()=>{showMerged=true;$('merged').checked=true;draw();};p.append(b);box.append(p);}
 drawer();
}
// The drawer's verdict banner: what state the PR is in, and what happens next.
function banner(s,pr){
 const last=pr.automerge?.last;
 if(s.end==='merged')return ['ok','Merged',last?.ok?'Merged by this dashboard.':'Merged on GitHub.'];
 if(s.end==='closed')return ['none','Closed without merging',''];
 if(s.end==='draft')return ['none','Draft','Not reviewed until it is marked ready.'];
 if(s.automerge==='failed')return ['bad','Merge failed',(last?.message||'')+'. Remove and re-add the label to retry this head.'];
 if(s.automerge==='merging')return ['ok','Merging now','The review approves this head and GitHub reports it clean.'];
 if(s.automerge==='waiting')return ['wait','Queued for automerge','Labelled. Merges once the review approves this head and GitHub reports the PR clean.'];
 if(s.verdict==='APPROVE')return ['ok','Approved for this head','Label it and it merges once GitHub reports the PR clean.'];
 if(s.verdict==='REQUEST_CHANGES')return ['bad','Changes requested',s.critical+' critical and '+s.high+' high findings stand.'];
 if(s.verdict==='stale')return ['wait','Review is for an older head','A push landed after the review. Wait for the next run.'];
 if(s.verdict==='unparsed')return ['wait','No clear verdict','The review has no single agreeing verdict line, so it is not an approval.'];
 return ['none','No review yet','The review job has not commented on this pull request.'];
}
function drawer(){
 const aside=$('aside');
 if(!selected){aside.replaceChildren(el('p','hint','Select a pull request to read its review.'));return;}
 const [repo,n]=[selected.slice(0,selected.lastIndexOf('#')),+selected.slice(selected.lastIndexOf('#')+1)];
 const x=state.repos[repo]?.rows.find(y=>y.pr.number===n);
 if(!x){aside.replaceChildren(el('p','hint','That pull request is no longer listed.'));return;}
 const {pr,stages:s}=x,dh=el('div','dh');
 const h=el('h2');h.append(el('span','num','#'+pr.number),document.createTextNode(pr.title));
 dh.append(el('span','eyebrow',repo),h,el('span','mono','head '+String(pr.headRefOid||'').slice(0,7)+(review?.model?' · '+review.model:'')+' · updated '+age(pr.updatedAt)));
 const [kind,head,why]=banner(s,pr),b=el('div','banner '+kind);
 b.append(el('strong','',head));if(why)b.append(el('span','',why));
 const btns=el('div','btns');
 if(open(s))btns.append(labelButton(repo,pr,s,true));
 const gh=el('a','btn','Open on GitHub');gh.href=pr.url;gh.target='_blank';gh.rel='noopener';btns.append(gh);
 b.append(btns);
 const parts=[dh,b];
 if(s.verdict!=='none')parts.push(el('p','counts',counts(s)));
 const md=el('div','md');
 if(!review)md.append(el('p','tag','Loading the review…'));
 else if(review.error)md.append(el('p','tag','Could not load the review: '+review.error));
 else if(review.html)md.innerHTML=review.html;
 else md.append(el('p','tag','No fresh-eyes review on this pull request.'));
 parts.push(md);
 aside.replaceChildren(...parts);
}
async function show(repo,n){
 const key=repo+'#'+n;
 selected=key;review=null;draw();
 const r=await fetch('/api/review?repo='+encodeURIComponent(repo)+'&pr='+n+'&html=1',{headers:{[HEADER]:'1'}});
 const data=await r.json();
 if(selected!==key)return; // a later click won
 review=r.ok?data:{error:data.error};drawer();
}
$('repo').onchange=e=>{pick=e.target.value;draw();};
$('merged').onchange=e=>{showMerged=e.target.checked;draw();};
$('refresh').onclick=()=>post('/api/refresh');
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
