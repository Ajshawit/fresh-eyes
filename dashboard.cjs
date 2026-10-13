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
