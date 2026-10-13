# fresh-eyes Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, dependency-free dashboard that shows each PR's path through the fresh-eyes gate across repos, lets the operator toggle an `automerge` label, and merges labelled PRs once the review of their current head approves.

**Architecture:** One new file, `dashboard.cjs`, in the same style as `review.cjs` and `require-review.cjs`: terse, commented with the *why*, zero dependencies. It shells out to `gh` for every GitHub call (never handles a token), requires `require-review.cjs` for the approval rule, serves one inline HTML page plus JSON endpoints on 127.0.0.1, and runs one async loop that refreshes the cache then merges. All GitHub calls go through one replaceable function (`io.gh`) so the tests run with a fake and no network.

**Tech Stack:** Node 20+ (`node:http`, `node:child_process`, `node:fs`), `gh` CLI, vanilla HTML/JS. Tests: `node:assert/strict` inside the existing `test/check.cjs`.

**Spec:** `docs/superpowers/specs/2026-10-13-dashboard-design.md`

## Global Constraints

- Zero dependencies; `package.json` stays `"private": true` with no `dependencies`.
- Node `>=20`; CommonJS (`.cjs`), `'use strict'`.
- Code style of the existing files: no space after `if`/`for`, single-space indent inside functions, one-line comments explaining the *why*, `execFile` with an argument array, never a shell string.
- Bound to `127.0.0.1` only; `--port` is the only network flag.
- Fails closed: any `gh` error, unparsed comment, head mismatch or disagreeing verdict is never a merge.
- The approval rule is `decide` from `require-review.cjs`, never re-implemented.
- Tests run with `node test/check.cjs`, no network, no real `gh`.
- Commit messages: `<type>: <description>`; end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work on branch `dashboard` (create from `main` before Task 1).

## Review Focus

1. A review comment with the marker but no `<!-- head: ... -->` line (as a `--dry` run produces) must show the verdict as `stale`, never as approved, and must never merge. Pinned in Task 1 (`stages`, `shouldMerge`).
2. A PR whose fresh-eyes job name is not literally `fresh-eyes` (the workflow job is often called `review`) must still show the check stage; a rollup with no matching entry shows `none`. Pinned in Task 1 (`stages`).
3. The same head must never be merged twice or retried after a failed merge, even across refreshes that rebuild the rows. Pinned in Task 1 (`shouldMerge`) and Task 2 (`automerge`).
4. A cross-origin page must not be able to label or merge: a POST without the custom header is refused before any `gh` call. Pinned in Task 3 (server test).
5. PR titles and author names are attacker-chosen text: the page must insert them as text, never as HTML. Pinned in Task 3 (the page builds DOM with `textContent`; the server test asserts the page source never uses `innerHTML` for PR fields).

---

### Task 1: Pure core: arguments, comment parsing, stages, merge decision

**Files:**
- Create: `dashboard.cjs`
- Create: `test/fixtures/dashboard/prs.json`
- Create: `test/fixtures/dashboard/comment.md`
- Modify: `test/check.cjs` (append a section before the final `console.log('fresh-eyes checks passed')`)

**Interfaces:**
- Consumes: `decide`, `headOf`, `verdictOf`, `MARKER` from `require-review.cjs`.
- Produces (exported from `dashboard.cjs`):
  - `parseArgs(argv: string[]) → {repos:string[], port:number, method:'squash'|'merge'|'rebase', label:string, every:number, discover:boolean, rediscover:boolean}`; throws `Error` with the fix in the message.
  - `parseComment(body) → {body, head:string|null, verdict:'APPROVE'|'REQUEST_CHANGES'|null, model:string|null, critical:number, high:number} | null`.
  - `stages(pr, comment, label) → {opened:{author:string, at:string}, check:'none'|'pending'|'pass'|'fail', verdict:'none'|'APPROVE'|'REQUEST_CHANGES'|'stale'|'unparsed', critical:number, high:number, automerge:'off'|'waiting'|'merging'|'merged'|'failed', end:'open'|'draft'|'merged'|'closed'}`.
  - `shouldMerge(pr, comment, label) → boolean`.
  - `pr.automerge` is `{last:{head, ok:boolean, at:string, message:string}} | null`, attached by Task 2 before `stages` runs.

- [ ] **Step 1: Create the fixtures**

`test/fixtures/dashboard/comment.md` (a real-shaped bot comment; `H1` below is its head):

```markdown
<!-- fresh-eyes -->
<!-- head: 1111111111111111111111111111111111111111 -->
<!-- base: main -->
### Fresh-eyes review — `glm-5.3:cloud`

- **CRITICAL** `server/auth.js:12` — token compared with `==`, so a numeric-looking token passes.
- **HIGH** `server/auth.js:40` — session never expires.
- **HIGH** `server/db.js:9` — query built by string concatenation.
- **MEDIUM** `lib/util.js:3` — unused import.

VERDICT: REQUEST_CHANGES

<sub>Gates merging: anything but `VERDICT: APPROVE` fails this check.</sub>
```

`test/fixtures/dashboard/prs.json` (shapes as `gh pr list --json` returns them):

```json
[
 {"number":1,"title":"Fix auth","url":"https://github.com/o/r/pull/1","author":{"login":"ann"},"createdAt":"2026-10-01T10:00:00Z","updatedAt":"2026-10-13T10:00:00Z","isDraft":false,"state":"OPEN","mergedAt":null,"headRefOid":"1111111111111111111111111111111111111111","baseRefName":"main","labels":[{"name":"automerge"}],"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[{"__typename":"CheckRun","name":"review","status":"COMPLETED","conclusion":"SUCCESS"}]},
 {"number":2,"title":"<img src=x onerror=alert(1)>","url":"https://github.com/o/r/pull/2","author":{"login":"bob"},"createdAt":"2026-10-02T10:00:00Z","updatedAt":"2026-10-12T10:00:00Z","isDraft":true,"state":"OPEN","mergedAt":null,"headRefOid":"2222222222222222222222222222222222222222","baseRefName":"main","labels":[],"mergeable":"MERGEABLE","mergeStateStatus":"DRAFT","statusCheckRollup":[{"__typename":"CheckRun","name":"fresh-eyes","status":"IN_PROGRESS","conclusion":null}]},
 {"number":3,"title":"Old","url":"https://github.com/o/r/pull/3","author":{"login":"cat"},"createdAt":"2026-09-02T10:00:00Z","updatedAt":"2026-09-12T10:00:00Z","isDraft":false,"state":"MERGED","mergedAt":"2026-09-12T10:00:00Z","headRefOid":"3333333333333333333333333333333333333333","baseRefName":"main","labels":[{"name":"automerge"}],"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN","statusCheckRollup":[{"__typename":"StatusContext","context":"review","state":"FAILURE"}]}
]
```

- [ ] **Step 2: Write the failing tests**

Append to `test/check.cjs`, just above `console.log('fresh-eyes checks passed');`:

```js
// The dashboard's pure core: arguments, the bot comment as the page reads it, the stage chips, and the merge rule.
const dash=require('../dashboard.cjs');
const {parseArgs,parseComment,stages,shouldMerge}=dash;
const DFIX=path.join(FIX,'dashboard');
const prs=JSON.parse(fs.readFileSync(path.join(DFIX,'prs.json'),'utf8'));
const body=fs.readFileSync(path.join(DFIX,'comment.md'),'utf8');
const H1='1'.repeat(40);
assert.deepEqual(parseArgs(['--repo','o/r']),{repos:['o/r'],port:7331,method:'squash',label:'automerge',every:60,discover:false,rediscover:false});
assert.deepEqual(parseArgs(['--discover','--rediscover','--port','8000','--method','rebase','--label','ship it','--every','5']).every,15,'every is clamped to 15');
assert.equal(parseArgs(['--repo','o/r','--repo','o/s']).repos.length,2);
for(const bad of [[],['--repo','o/r','--discover'],['--rediscover'],['--repo','bad'],['--port','x'],['--port','70000'],['--method','ff'],['--every','x'],['--label',''],['--what'],['--repo']])
 assert.throws(()=>parseArgs(bad),/--repo|--discover|--port|--method|--every|--label|unknown argument|needs a value/,'refused: '+bad.join(' '));
// Comment: head, verdict, model and severity counts; anything without the marker is not a fresh-eyes comment.
const c=parseComment(body);
assert.deepEqual([c.head,c.verdict,c.model,c.critical,c.high],[H1,'REQUEST_CHANGES','glm-5.3:cloud',1,2]);
assert.equal(parseComment('### Fresh-eyes review\nVERDICT: APPROVE'),null);
assert.equal(parseComment(null),null);
const approve=parseComment(body.replace('VERDICT: REQUEST_CHANGES','VERDICT: APPROVE'));
assert.equal(approve.verdict,'APPROVE');
const noHead=parseComment(body.replace(/^<!-- head: .* -->\n/m,'').replace('REQUEST_CHANGES','APPROVE'));
assert.equal(noHead.head,null);
// Stages: one chip per column, from the PR as gh lists it and the comment for it.
const s1=stages(prs[0],approve,'automerge');
assert.deepEqual(s1,{opened:{author:'ann',at:'2026-10-01T10:00:00Z'},check:'pass',verdict:'APPROVE',critical:1,high:2,automerge:'merging',end:'open'});
assert.equal(stages(prs[0],c,'automerge').automerge,'waiting','request changes waits');
assert.equal(stages(prs[0],null,'automerge').verdict,'none');
assert.equal(stages(prs[0],noHead,'automerge').verdict,'stale','no head line is never the current head');
assert.equal(stages(prs[0],{...approve,head:'9'.repeat(40)},'automerge').verdict,'stale');
assert.equal(stages(prs[0],{...approve,verdict:null},'automerge').verdict,'unparsed');
assert.equal(stages({...prs[0],labels:[]},approve,'automerge').automerge,'off');
assert.equal(stages({...prs[0],statusCheckRollup:[]},approve,'automerge').check,'none');
assert.equal(stages({...prs[0],statusCheckRollup:[{__typename:'CheckRun',name:'lint',status:'COMPLETED',conclusion:'SUCCESS'}]},approve,'automerge').check,'none','only the review job counts');
assert.equal(stages({...prs[0],statusCheckRollup:[{__typename:'StatusContext',context:'review',state:'PENDING'}]},approve,'automerge').check,'pending');
const failed={last:{head:H1,ok:false,at:'2026-10-13T11:00:00Z',message:'conflict'}};
assert.equal(stages({...prs[0],automerge:failed},approve,'automerge').automerge,'failed');
assert.equal(stages({...prs[0],automerge:{last:{...failed.last,ok:true}}},approve,'automerge').automerge,'merged');
assert.equal(stages({...prs[0],automerge:{last:{...failed.last,head:'9'.repeat(40)}}},approve,'automerge').automerge,'merging','a failure for an older head does not stick');
const s2=stages(prs[1],null,'automerge');
assert.deepEqual([s2.check,s2.verdict,s2.automerge,s2.end],['pending','none','off','draft']);
const s3=stages(prs[2],null,'automerge');
assert.deepEqual([s3.check,s3.automerge,s3.end],['fail','merged','merged']);
// The merge rule: every condition must hold, and one attempt per head.
assert.equal(shouldMerge(prs[0],approve,'automerge'),true);
for(const [why,pr,cm] of [['no label',{...prs[0],labels:[]},approve],['draft',{...prs[0],isDraft:true},approve],['closed',{...prs[0],state:'CLOSED'},approve],
 ['merged',prs[2],approve],['conflicting',{...prs[0],mergeable:'CONFLICTING'},approve],['unknown mergeability',{...prs[0],mergeable:'UNKNOWN'},approve],
 ['stale head',prs[0],{...approve,head:'9'.repeat(40)}],['no head',prs[0],noHead],['request changes',prs[0],c],['no comment',prs[0],null],
 ['disagreeing verdicts',prs[0],parseComment(body.replace('VERDICT: REQUEST_CHANGES','VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES'))],
 ['already tried this head',{...prs[0],automerge:failed},approve],['already merged this head',{...prs[0],automerge:{last:{...failed.last,ok:true}}},approve]])
 assert.equal(shouldMerge(pr,cm,'automerge'),false,'no merge: '+why);
assert.equal(shouldMerge(prs[0],approve,'ship'),false,'a different label name does not count');
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node test/check.cjs`
Expected: throws `Cannot find module '../dashboard.cjs'` after the existing checks pass.

- [ ] **Step 4: Write the minimal implementation**

Create `dashboard.cjs`:

```js
#!/usr/bin/env node
// fresh-eyes dashboard: one local page showing every pull request's path through the fresh-eyes gate across repos,
// with an automerge label the operator toggles. A labelled PR is merged once the review comment approves its current
// head, by the same rule require-review.cjs applies, pinned with --match-head-commit so a later push is refused.
// Every GitHub call goes through gh, so this file never sees a token. Bound to 127.0.0.1 only.
// Usage: node dashboard.cjs --repo owner/name [--repo ...] [--port 7331] [--method squash|merge|rebase]
//        [--label automerge] [--every 60]      or      node dashboard.cjs --discover [--rediscover] [...same flags]
'use strict';
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
function shouldMerge(pr,comment,label){
 if(!pr||pr.state!=='OPEN'||pr.isDraft||pr.mergeable!=='MERGEABLE'||!labelled(pr,label))return false;
 if(!comment||decide([comment.body],pr.headRefOid||'')!==null)return false;
 return !tried(pr);
}

// The review job in the head's check rollup: a CheckRun (status/conclusion) or a commit status (state).
const REVIEW_JOB=/fresh-eyes|review/i;
function checkStage(pr){
 const run=(pr.statusCheckRollup||[]).find(r=>REVIEW_JOB.test(r.name||r.context||''));
 if(!run)return 'none';
 if(run.status&&run.status!=='COMPLETED')return 'pending';
 if(run.state==='PENDING'||run.state==='EXPECTED')return 'pending';
 return (run.conclusion||run.state)==='SUCCESS'?'pass':'fail';
}

// The five chips of a row. Pure: pr as gh lists it (plus pr.automerge from the loop), the parsed comment or null.
function stages(pr,comment,label){
 const end=pr.state==='MERGED'||pr.mergedAt?'merged':pr.state==='CLOSED'?'closed':pr.isDraft?'draft':'open';
 const verdict=!comment?'none':comment.head!==pr.headRefOid?'stale':comment.verdict||'unparsed';
 const last=tried(pr);
 const automerge=!labelled(pr,label)?'off':end==='merged'||last?.ok?'merged':last?'failed':shouldMerge(pr,comment,label)?'merging':'waiting';
 return {opened:{author:pr.author?.login||'?',at:pr.createdAt},check:checkStage(pr),verdict,critical:comment?.critical||0,high:comment?.high||0,automerge,end};
}

module.exports={parseArgs,parseComment,stages,shouldMerge};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node test/check.cjs`
Expected: `fresh-eyes checks passed`

- [ ] **Step 6: Commit**

```bash
git add dashboard.cjs test/check.cjs test/fixtures/dashboard
git commit -m "feat(dashboard): arguments, comment parsing, stage chips and the merge rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: GitHub I/O: fetch, refresh, automerge, label, discover

**Files:**
- Modify: `dashboard.cjs` (add below `stages`, before `module.exports`; extend exports)
- Modify: `test/check.cjs` (append after Task 1's section)

**Interfaces:**
- Consumes: Task 1's `parseComment`, `stages`, `shouldMerge`.
- Produces:
  - `io.gh(args: string[], input?: string) → Promise<string>` (stdout); rejects with an `Error` carrying `.stderr`. Tests replace `io.gh`.
  - `firstLine(error) → string`.
  - `fetchRepo(repo) → Promise<{prs:object[], comments:{[number]:ParsedComment}}>`.
  - `refresh(state, opts, only?: string[]) → Promise<void>`; `state = {at:string|null, repos:{[repo]:{rows:Row[], error:string|null}}, merges:{[repo#n]:{last}}}`; `Row = {pr, comment, stages}`.
  - `automerge(state, opts) → Promise<void>`.
  - `setLabel(repo, number, on:boolean, label) → Promise<void>`.
  - `discover(opts) → Promise<string[]>`; cache file path from `process.env.FRESH_EYES_CACHE` or `~/.cache/fresh-eyes/repos.json`.

- [ ] **Step 1: Write the failing tests**

Append to `test/check.cjs` after Task 1's section:

```js
// GitHub I/O against a fake gh: which commands run, what the loop does with their answers, and that a gh error
// marks a repo unreadable instead of approving anything.
const {io,fetchRepo,refresh,automerge,setLabel,discover,firstLine}=dash;
const calls=[];
let fail=()=>null; // args → error message to throw, or null
io.gh=async(args,input)=>{
 calls.push(args.join(' '));
 const why=fail(args);if(why){throw Object.assign(Error('gh failed'),{stderr:why+'\n'});}
 const a=args.join(' ');
 if(a.startsWith('pr list'))return JSON.stringify(a.includes('--state open')?prs.filter(p=>p.state==='OPEN'):prs.filter(p=>p.state!=='OPEN'));
 if(a.startsWith('api repos/o/r/issues/comments'))return JSON.stringify([
  {issue_url:'https://api.github.com/repos/o/r/issues/1',user:{login:'github-actions[bot]'},body:body.replace('REQUEST_CHANGES','APPROVE')},
  {issue_url:'https://api.github.com/repos/o/r/issues/1',user:{login:'github-actions[bot]'},body:'<!-- fresh-eyes -->\nolder, must not replace the newer one'},
  {issue_url:'https://api.github.com/repos/o/r/issues/2',user:{login:'someone'},body:body},
  {issue_url:'https://api.github.com/repos/o/r/issues/3',user:{login:'github-actions[bot]'},body:'not a review'}]);
 if(a.startsWith('api user'))return 'me\n';
 if(a.startsWith('repo list'))return JSON.stringify([{nameWithOwner:'me/a'},{nameWithOwner:'me/b'},{nameWithOwner:'me/c'}]);
 // Workflow reads carry an Accept header before the path, so match on the path anywhere in the command.
 if(a.includes('repos/me/a/contents/.github/workflows'))return a.endsWith('workflows')?JSON.stringify([{name:'ci.yml',path:'.github/workflows/ci.yml'},{name:'README',path:'.github/workflows/README'}]):'uses: ajshawit/fresh-eyes@v1\n';
 if(a.includes('repos/me/b/contents/.github/workflows'))return a.endsWith('workflows')?JSON.stringify([{name:'x.yaml',path:'.github/workflows/x.yaml'}]):'name: nothing\n';
 if(a.includes('repos/me/c/contents'))throw Object.assign(Error('gh failed'),{stderr:'HTTP 404: Not Found\n'});
 if(a.startsWith('api markdown'))return '<p>'+JSON.parse(input).text.length+'</p>';
 return '';
};
assert.equal(firstLine(Object.assign(Error('x'),{stderr:'\nboom\nmore'})),'boom');
assert.equal(firstLine(Error('plain')),'plain');
const got=await fetchRepo('o/r');
assert.deepEqual(got.prs.map(p=>p.number),[1,2,3],'open first, then closed');
assert.deepEqual(Object.keys(got.comments),['1'],'only the bot, only the marker, newest wins');
assert.equal(got.comments[1].verdict,'APPROVE');
assert(calls.some(x=>x==='pr list --repo o/r --state open --limit 100 --json '+dash.PR_FIELDS)&&calls.some(x=>x.startsWith('pr list --repo o/r --state closed --limit 20 ')));
assert(calls.some(x=>x==='api repos/o/r/issues/comments?sort=updated&direction=desc&per_page=100&page=1'));
const opts={repos:['o/r','o/down'],label:'automerge',method:'squash'};
const state={at:null,repos:{},merges:{}};
fail=args=>args.includes('o/down')?'HTTP 404: Not Found':null;
await refresh(state,opts);
assert.equal(state.repos['o/r'].error,null);
assert.equal(state.repos['o/down'].error,'HTTP 404: Not Found');
assert.deepEqual(state.repos['o/down'].rows,[]);
assert.equal(state.repos['o/r'].rows[0].stages.automerge,'merging');
assert(state.at);
// The loop merges PR 1 once, pinned to its head, and never again for that head; a failure is kept and shown.
calls.length=0;
await automerge(state,opts);
assert.deepEqual(calls,['pr merge 1 --repo o/r --squash --match-head-commit '+H1]);
assert.equal(state.merges['o/r#1'].last.ok,true);
assert.equal(state.repos['o/r'].rows[0].stages.automerge,'merged');
calls.length=0;
await automerge(state,opts);
await refresh(state,opts);
await automerge(state,opts);
assert.deepEqual(calls.filter(x=>x.startsWith('pr merge')),[],'one merge per head, across refreshes');
state.merges={};
fail=args=>args[1]==='merge'?'Pull request is not mergeable':null;
await refresh(state,opts);await automerge(state,opts);
assert.deepEqual(state.repos['o/r'].rows[0].pr.automerge.last.message,'Pull request is not mergeable');
assert.equal(state.repos['o/r'].rows[0].stages.automerge,'failed');
calls.length=0;await automerge(state,opts);
assert.deepEqual(calls,[],'a failed head is not retried');
fail=()=>null;
// Labels: add, remove, and create the label once when the repo lacks it.
calls.length=0;
await setLabel('o/r',2,true,'automerge');await setLabel('o/r',2,false,'automerge');
assert.deepEqual(calls,['pr edit 2 --repo o/r --add-label automerge','pr edit 2 --repo o/r --remove-label automerge']);
let created=false;
fail=args=>args[1]==='edit'&&!created?"'automerge' not found":null;
calls.length=0;
const realGh=io.gh;io.gh=async(args,input)=>{if(args[0]==='label')created=true;return realGh(args,input);};
await setLabel('o/r',2,true,'automerge');
assert.deepEqual(calls.map(x=>x.split(' ').slice(0,3).join(' ')),['pr edit 2','label create automerge','pr edit 2']);
io.gh=realGh;fail=()=>null;
fail=()=>'HTTP 403';
await assert.rejects(()=>setLabel('o/r',2,false,'automerge'),e=>firstLine(e)==='HTTP 403','a non-label error is passed on');
fail=()=>null;
// Discovery: workflow text decides, non-yaml and missing directories are skipped, the result is cached for a day.
process.env.FRESH_EYES_CACHE=path.join(REPO,'cache','repos.json');
assert.deepEqual(await discover({discover:true,rediscover:false}),['me/a']);
calls.length=0;
assert.deepEqual(await discover({discover:true,rediscover:false}),['me/a']);
assert.deepEqual(calls,[],'served from the cache');
await discover({discover:true,rediscover:true});
assert(calls.some(x=>x.startsWith('repo list me --no-archived')),'rediscover scans again');
fs.writeFileSync(process.env.FRESH_EYES_CACHE,JSON.stringify({at:Date.now()-2*86_400_000,repos:['stale/x']}));
assert.deepEqual(await discover({discover:true,rediscover:false}),['me/a'],'a day-old cache is rescanned');
const noHits=io.gh;io.gh=async(args,input)=>args[0]==='repo'?'[]':noHits(args,input);
await assert.rejects(()=>discover({discover:true,rediscover:true}),/--repo/);
io.gh=noHits;
```

Also wrap the whole `try{` body so top-level `await` works: change the file's `try{` ... `}finally{...}` into an async IIFE. At the top of the file, replace `try{` with `(async()=>{try{`, and the final line `}finally{fs.rmSync(REPO,{recursive:true,force:true});fs.rmSync(secret,{force:true});}` with `}finally{fs.rmSync(REPO,{recursive:true,force:true});fs.rmSync(secret,{force:true});}})().catch(e=>{console.error(e);process.exit(1);});`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/check.cjs`
Expected: `TypeError: Cannot destructure property 'io'` or `fetchRepo is not a function`.

- [ ] **Step 3: Write the implementation**

Insert into `dashboard.cjs` after the `stages` function and before `module.exports`, and add the requires at the top under `'use strict';`:

```js
const {execFile}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
```

```js
const BOT=process.env.FRESH_EYES_BOT||'github-actions[bot]'; // who posts the review: the action's default token
const CACHE=()=>process.env.FRESH_EYES_CACHE||path.join(os.homedir(),'.cache','fresh-eyes','repos.json');
const DAY=86_400_000;
const PR_FIELDS='number,title,url,author,createdAt,updatedAt,isDraft,state,mergedAt,headRefOid,baseRefName,labels,mergeable,mergeStateStatus,statusCheckRollup';

// All of GitHub, through gh: async so the page stays responsive while a refresh walks the repos. Tests replace it.
const io={gh:(args,input)=>new Promise((resolve,reject)=>{
 const child=execFile('gh',args,{encoding:'utf8',maxBuffer:64<<20},(error,stdout,stderr)=>error?reject(Object.assign(error,{stderr})):resolve(stdout));
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
async function automerge(state,opts){
 for(const [repo,r] of Object.entries(state.repos))for(const x of r.rows){
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
```

Change the exports line to:

```js
module.exports={parseArgs,parseComment,stages,shouldMerge,io,firstLine,fetchRepo,refresh,automerge,setLabel,discover,PR_FIELDS};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/check.cjs`
Expected: `fresh-eyes checks passed`

- [ ] **Step 5: Commit**

```bash
git add dashboard.cjs test/check.cjs
git commit -m "feat(dashboard): fetch, refresh, automerge loop, label toggle and opt-in discovery

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: HTTP server, request guard, the page, and main

**Files:**
- Modify: `dashboard.cjs` (add `http` require, `status`, `find`, `guard`, `publicState`, `handle`, `PAGE`, `serve`, `main`; extend exports)
- Modify: `test/check.cjs` (append after Task 2's section)

**Interfaces:**
- Consumes: Task 2's `io`, `refresh`, `automerge`, `setLabel`, `discover`, `firstLine`.
- Produces:
  - `serve(state, opts, tick) → http.Server` listening on `127.0.0.1:opts.port` (port `0` picks a free one; tests use it).
  - Endpoints: `GET /` (HTML), `GET /api/state`, `GET /api/review?repo=&pr=&html=1`, `POST /api/label` `{repo, pr, on}`, `POST /api/refresh`. POSTs need header `x-fresh-eyes: 1`.
  - `HEADER='x-fresh-eyes'`, `PAGE` (string).

- [ ] **Step 1: Write the failing tests**

Append to `test/check.cjs` after Task 2's section:

```js
// The server: the page and state are readable, the review renders through GitHub's markdown endpoint, and nothing
// changes state without the custom header or for a repo or PR the dashboard does not know.
const {serve,HEADER,PAGE}=dash;
io.gh=realGh;fail=()=>null;
const sstate={at:null,repos:{},merges:{}};
const sopts={repos:['o/r'],label:'automerge',method:'squash',port:0,every:60};
let ticks=0;
const server=serve(sstate,sopts,async()=>{ticks++;await refresh(sstate,sopts);});
await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;
const get=(p)=>fetch(base+p);
const post=(p,data,headers={})=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
try{
 const page=await (await get('/')).text();
 assert(page.includes('<!doctype html>')&&page.includes('/api/state'));
 assert(!/innerHTML\s*=\s*[^'"]*\b(title|login|author|name|message)\b/.test(PAGE),'PR text goes in as text, never HTML');
 await post('/api/refresh',{},{[HEADER]:'1'});
 assert.equal(ticks,1);
 const st=await (await get('/api/state')).json();
 assert.deepEqual(Object.keys(st),['at','label','method','every','repos']);
 assert.equal(st.repos['o/r'].rows[0].pr.title,'Fix auth');
 assert.equal(st.repos['o/r'].rows[0].stages.verdict,'APPROVE');
 assert.deepEqual(st.repos['o/r'].rows[0].pr.labels,['automerge']);
 assert.equal(st.repos['o/r'].rows[0].comment,undefined,'bodies are fetched per PR, not shipped with the state');
 const rv=await (await get('/api/review?repo=o/r&pr=1&html=1')).json();
 assert(rv.body.startsWith('<!-- fresh-eyes -->')&&rv.html==='<p>'+rv.body.length+'</p>'&&rv.url==='https://github.com/o/r/pull/1');
 assert.deepEqual(await (await get('/api/review?repo=o/r&pr=2')).json(),{body:null,html:null,url:'https://github.com/o/r/pull/2'});
 assert.equal((await get('/api/review?repo=o/r&pr=99')).status,400);
 assert.equal((await get('/api/review?repo=x/y&pr=1')).status,400);
 assert.equal((await post('/api/label',{repo:'o/r',pr:2,on:true})).status,403,'no header, no change');
 assert.equal((await fetch(base+'/api/label',{method:'OPTIONS'})).status,404,'no preflight, so no CORS');
 assert.equal((await post('/api/label',{repo:'o/r',pr:99,on:true},{[HEADER]:'1'})).status,400);
 assert.equal((await post('/api/label',{repo:'o/zz',pr:1,on:true},{[HEADER]:'1'})).status,400);
 calls.length=0;
 assert.equal((await post('/api/label',{repo:'o/r',pr:2,on:true},{[HEADER]:'1'})).status,200);
 assert.equal(calls[0],'pr edit 2 --repo o/r --add-label automerge');
 assert(calls.some(x=>x.startsWith('pr list --repo o/r')),'the repo is refreshed after a label change');
 fail=()=>'HTTP 403: Resource not accessible';
 const err=await post('/api/label',{repo:'o/r',pr:2,on:false},{[HEADER]:'1'});
 assert.equal(err.status,500);assert.equal((await err.json()).error,'HTTP 403: Resource not accessible');
 fail=()=>null;
 assert.equal((await get('/nope')).status,404);
 assert.equal((await fetch(base+'/api/label',{method:'POST',headers:{[HEADER]:'1'},body:'{'})).status,400,'bad JSON is 400');
}finally{server.closeAllConnections();server.close();} // keep-alive sockets would otherwise hold the process open
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/check.cjs`
Expected: `TypeError: serve is not a function`.

- [ ] **Step 3: Write the implementation**

Add `const http=require('node:http');` to the requires. Insert before `module.exports`:

```js
const HEADER='x-fresh-eyes'; // a custom header: a cross-origin page cannot send it without a preflight, which 404s
const status=(code,message)=>Object.assign(Error(message),{status:code});

// Only a repo this run covers and a PR it has listed can be acted on: anything else is a bad request, not a gh call.
function find(state,repo,pr){
 const r=state.repos[repo];
 if(!r)throw status(400,'unknown repo');
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
 const url=new URL(req.url,'http://127.0.0.1');
 const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
 if(req.method==='GET'){
  if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(PAGE);}
  if(url.pathname==='/api/state')return json(200,publicState(state,opts));
  if(url.pathname==='/api/review'){
   const repo=url.searchParams.get('repo'),x=find(state,repo,+url.searchParams.get('pr'));
   const body=x.comment?.body||null;
   const html=body&&url.searchParams.get('html')==='1'?await io.gh(['api','markdown','--input','-'],JSON.stringify({text:body,mode:'gfm',context:repo})):null;
   return json(200,{body,html,url:x.pr.url});
  }
 }else if(req.method==='POST'){
  guard(req);
  let data;
  try{data=JSON.parse(await readBody(req)||'{}');}catch{throw status(400,'body must be JSON');}
  if(url.pathname==='/api/refresh'){await tick();return json(200,{ok:true});}
  if(url.pathname==='/api/label'){
   const x=find(state,data.repo,data.pr);
   await setLabel(data.repo,x.pr.number,!!data.on,opts.label);
   await refresh(state,opts,[data.repo]);
   await automerge(state,opts);
   return json(200,{ok:true});
  }
 }
 throw status(404,'not found');
}

function serve(state,opts,tick){
 const server=http.createServer((req,res)=>handle(req,res,state,opts,tick).catch(e=>{
  res.writeHead(e.status||500,{'content-type':'application/json'});res.end(JSON.stringify({error:firstLine(e)}));
 }));
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
 const rv=await (await fetch('/api/review?repo='+encodeURIComponent(repo)+'&pr='+pr.number+'&html=1')).json();
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
 let busy=false; // a slow refresh must not overlap the next one, or a label click's refresh
 const tick=async()=>{if(busy)return;busy=true;try{await refresh(state,opts);await automerge(state,opts);}finally{busy=false;}};
 const server=serve(state,opts,tick);
 server.on('listening',()=>console.error('fresh-eyes dashboard on http://127.0.0.1:'+server.address().port+' — '+opts.repos.length+' repo(s), refresh every '+opts.every+'s, label '+opts.label+', merge --'+opts.method));
 await tick();
 setInterval(tick,opts.every*1000);
}

if(require.main===module)main().catch(error=>{console.error(error?.message||error);process.exit(1);});
```

And the exports line becomes:

```js
module.exports={parseArgs,parseComment,stages,shouldMerge,io,firstLine,fetchRepo,refresh,automerge,setLabel,discover,PR_FIELDS,serve,handle,publicState,HEADER,PAGE};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/check.cjs`
Expected: `fresh-eyes checks passed`, and the process exits (the server is closed in `finally`).

- [ ] **Step 5: Smoke it against a real repo**

Run: `node dashboard.cjs --repo Ajshawit/not-on-my-farm --port 7331` and open http://127.0.0.1:7331 in a browser. Expected: a list of PRs with chips (verdict `none` since the repo has no fresh-eyes comments yet), clicking a row shows "no fresh-eyes review on this pull request". Do **not** click the label button on a real PR during the smoke test. Stop the server with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add dashboard.cjs test/check.cjs
git commit -m "feat(dashboard): local server, request guard and the pipeline page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md` (new section after "The merge hook for Claude Code")
- Modify: `docs/design.md` (components table and data flow)
- Modify: `package.json` (add a `dashboard` script)

**Interfaces:** none.

- [ ] **Step 1: Add the README section**

Insert after the merge-hook section in `README.md`:

```markdown
## The dashboard

`dashboard.cjs` is a local page showing every pull request's path through the gate across your repositories:
opened, review check, verdict with CRITICAL/HIGH counts, automerge, merged. Click a row to read the review. A
button adds or removes an `automerge` label; while the dashboard runs, a labelled PR is merged as soon as the
review comment approves its current head, with `--match-head-commit` so a push in between is refused.

```bash
node dashboard.cjs --repo owner/name --repo owner/other     # http://127.0.0.1:7331
node dashboard.cjs --discover                               # scan your repos' workflows for fresh-eyes (cached a day)
```

Flags: `--port 7331`, `--method squash|merge|rebase`, `--label automerge`, `--every 60` (refresh seconds, minimum
15), `--rediscover`. It uses `gh` for every GitHub call, so run `gh auth login` first; it holds no token itself.

The merge rule is the hook's: a comment by the bot login, for exactly the current head, with every verdict line
`APPROVE`. Like `reuse: true` it trusts the posted comment, so only automerge repositories where no other
workflow's token can post as that bot. The server binds to 127.0.0.1 and refuses state changes without a custom
header, so a web page you visit cannot label or merge through it.
```

- [ ] **Step 2: Update the design doc**

In `docs/design.md`, add a row to the components table:

```markdown
| `dashboard.cjs` | Local page of every PR's pipeline stages across repos; toggles an automerge label; merges labelled PRs once the hook's rule approves the head | operator | `gh`, `require-review.cjs` |
```

And append to the data flow list:

```markdown
9. Optionally, `dashboard.cjs` polls each repo's PRs and the bot's comments through `gh`, draws the stages, and
   merges labelled PRs by the hook's `decide` rule, pinned to the reviewed head. Design: `docs/superpowers/specs/2026-10-13-dashboard-design.md`.
```

- [ ] **Step 3: Add the script**

In `package.json`, change the scripts line to:

```json
  "scripts": {"test": "node test/check.cjs", "dashboard": "node dashboard.cjs"}
```

- [ ] **Step 4: Run the tests once more**

Run: `node test/check.cjs`
Expected: `fresh-eyes checks passed`

- [ ] **Step 5: Commit**

```bash
git add README.md docs/design.md package.json
git commit -m "docs: dashboard usage, merge rule and trust note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
