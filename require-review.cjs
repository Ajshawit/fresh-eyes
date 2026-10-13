#!/usr/bin/env node
// fresh-eyes merge hook for Claude Code (PreToolUse, see README): blocks `gh pr merge` and the GitHub MCP merge tool
// unless the fresh-eyes review comment approves the PR's current head commit. Exit 2 blocks the call and shows
// stderr to the agent. Fails closed: if the PR or its comments cannot be read, the merge is blocked.
// Self-contained on purpose: copy this one file into a repo. The marker, head line and verdict line below must match
// what fresh-eyes' review.cjs writes; its test/check.cjs asserts the two copies agree.
// Known limit: this guards the two merge paths a Claude Code agent normally takes. A merge from the GitHub web UI, a
// direct push to the base branch, or a merge through curl or another tool is not seen; branch protection covers those.
'use strict';
const {execFileSync}=require('node:child_process');

const MARKER='<!-- fresh-eyes -->';
const BOT=process.env.FRESH_EYES_BOT||'github-actions[bot]'; // who posts the review: the action's default token
const headOf=body=>body.match(/^<!-- head: ([0-9a-f]{40}) -->$/m)?.[1]||null;
const VERDICT=/^[`*]*VERDICT:[ \t]*(APPROVE|REQUEST_CHANGES)[`*]*[ \t]*$/gm;
// Every verdict line must agree: a quoted injected APPROVE next to a real REQUEST_CHANGES is no approval.
const verdictOf=review=>{const all=[...review.matchAll(VERDICT)].map(m=>m[1]);return all.length&&all.every(v=>v===all[0])?all[0]:null;};
// What the hook inspects: any command that mentions gh, pr or api, and merge, once shell quotes are stripped
// (`gh "pr" merge`) and backslash-newlines joined, as bash does before it reads a word. Of those, a single read-only
// `gh pr view|list|checks|diff|status` call with no shell operators passes (`--json mergeable`, `--search merge`);
// everything else must be the exact plain `gh pr merge` form target() reads, or it is refused. Fail closed: a mention
// in text gates the call too, since text can be written somewhere that runs.
const MENTION=/gh\b[\s\S]*\bpr\b[\s\S]*merge|gh\b[\s\S]*\bapi\b[\s\S]*\/merge\b/; // api: the merge endpoint, not --jq .mergeable
const READ_ONLY=/^\s*gh\s+pr\s+(view|list|checks|diff|status)\b[^;&|`$()<>\n]*$/;
const joined=command=>command.replace(/\\\r?\n/g,''); // deleted outright, as bash does: me\<newline>rge is merge
// A gh pr/api command whose words the shell builds at run time ($var, $(…), `…`, eval, $'\x6d' escapes) could spell
// merge without writing it, so it is refused outright: the hook only passes what it can read.
const BUILT=/\$|`|\beval\b|\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|[0-7]{3})/i;
// null: not a merge, let it through. Otherwise the merge target, or a throw when the command cannot be read exactly.
function inspect(command){
 const c=joined(command),norm=c.replace(/["'\\]/g,'');
 if(/gh\b[\s\S]*\b(pr|api)\b/.test(norm)&&BUILT.test(c))throw Error('a gh pr/api command with $, backticks, eval or escape sequences cannot be read: use literal arguments');
 if(!MENTION.test(norm)||READ_ONLY.test(norm))return null;
 return target(c);
}

// Why the merge must wait, or null when the bot's review approves this head.
function decide(bodies,head){
 const body=bodies.find(b=>b?.startsWith(MARKER));
 if(!body)return 'no fresh-eyes review comment yet';
 if(headOf(body)!==head)return 'the review is for an older commit; wait for the review of '+head.slice(0,7);
 if(verdictOf(body)!=='APPROVE')return 'the review did not approve (VERDICT: '+(verdictOf(body)||'none')+')';
 return null;
}

// The only flags the hook lets through. An allowlist, not a parser: every shell or gh form it cannot read exactly
// (quotes, $, comments, clustered short flags, branch names, env overrides) is refused, so it can never check a
// different PR than the one gh merges.
const BOOL_FLAGS=new Set(['--squash','-s','--merge','-m','--rebase','-r','--delete-branch','-d','--auto','--admin','--disable-auto']);
const VALUE_FLAGS=new Set(['--repo','-R','--match-head-commit']);
const PR=/^(\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/;

// PR, repo and head commit from a `gh pr merge` command, or a throw. All three are required: nothing is taken from
// the shell's cwd (a `cd` would point gh at another repo) or from time (--match-head-commit pins what was reviewed).
function target(command){
 if(!/\bgh\s+pr\s+merge\b/.test(command))throw Error('this mentions gh and merge: merge with `gh pr merge <pr> --repo owner/name --match-head-commit <sha>` on its own (not gh api, no flags before merge); keep other text out of commands that run gh');
 if(/\bGH_\w*=|\bgh\s+pr\s+merge\b[\s\S]*\bgh\s+pr\s+merge\b/.test(command))throw Error('use one plain `gh pr merge`, with no GH_* overrides');
 const [before,rest]=command.split(/\bgh\s+pr\s+merge\b/);
 // Nothing may run before it: a `cd`, an alias or a function defined earlier could change what gh merges.
 if(before.trim())throw Error('run `gh pr merge` on its own, as the first command');
 const segment=rest.split(/[;&|\n]/)[0];
 if(!/^[\w\s./:=-]*$/.test(segment))throw Error('`gh pr merge` arguments must be plain words: no quotes, $, # or \\');
 const args=segment.trim().split(/\s+/).filter(Boolean).flatMap(a=>/^--?[\w-]+=/.test(a)?[a.slice(0,a.indexOf('=')),a.slice(a.indexOf('=')+1)]:[a]);
 let repo,pr,head;
 for(let i=0;i<args.length;i++){
  const a=args[i];
  if(BOOL_FLAGS.has(a))continue;
  if(VALUE_FLAGS.has(a)){
   const v=args[++i];
   if(!v||v.startsWith('-'))throw Error(a+' needs a value');
   if(a==='--repo'||a==='-R'){if(!/^[\w.-]+\/[\w.-]+$/.test(v))throw Error('--repo must be owner/name');repo=v;}
   else{if(!/^[0-9a-f]{40}$/.test(v))throw Error('--match-head-commit takes the full 40-character sha');head=v;}
   continue;
  }
  if(a.startsWith('-'))throw Error('flag '+a+' is not allowed here; merge with --squash/--merge/--rebase, -d, --repo');
  if(pr||!PR.test(a))throw Error('name exactly one PR, by number or URL');
  pr=a;
 }
 if(!pr)throw Error('name the PR by number or URL');
 if(!repo&&!pr.startsWith('https://'))throw Error('add --repo owner/name (or give the PR URL)');
 if(!head)throw Error('add --match-head-commit <the reviewed head sha>');
 return {repo,pr,head};
}

const gh=args=>execFileSync('gh',args,{encoding:'utf8',maxBuffer:64<<20});

function check(input){
 let repo,pr,head;
 if(input.tool_name==='Bash'){
  const t=inspect(input.tool_input?.command||'');
  if(!t)return null;
  ({repo,pr,head}=t);
 }else{
  repo=input.tool_input.owner+'/'+input.tool_input.repo;pr=String(input.tool_input.pullNumber);
 }
 const view=JSON.parse(gh(['pr','view',...(pr?[pr]:[]),...(repo?['--repo',repo]:[]),'--json','number,headRefOid,url']));
 const [,nameWithOwner]=view.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
 const bodies=gh(['api','--paginate','repos/'+nameWithOwner+'/issues/'+view.number+'/comments',
  '--jq','.[]|select(.user.login=="'+BOT+'")|.body|@json']).split('\n').filter(Boolean).map(l=>JSON.parse(l));
 // gh refuses the merge if the head has moved past `head`, so an approval of `head` covers exactly what merges.
 const why=head!==view.headRefOid?'pin the reviewed head: gh pr merge '+view.number+' --repo '+nameWithOwner+' --match-head-commit '+view.headRefOid+' (the MCP merge tool cannot pin a head)':decide(bodies,head);
 return why&&'Merge of '+nameWithOwner+'#'+view.number+' blocked: '+why+'.';
}

if(require.main===module){
 let why;
 try{why=check(JSON.parse(require('node:fs').readFileSync(0,'utf8')));}
 catch(error){why='Merge blocked: could not confirm a fresh-eyes review approval ('+(error?.message||error).split('\n')[0]+').';}
 if(why){console.error(why);process.exit(2);}
}
module.exports={decide,target,inspect,check,verdictOf,headOf,MARKER};
