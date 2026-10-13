#!/usr/bin/env node
// fresh-eyes merge hook for Claude Code (PreToolUse, see README): blocks `gh pr merge` and the GitHub MCP merge tool
// unless the fresh-eyes review comment approves the PR's current head commit. Exit 2 blocks the call and shows
// stderr to the agent. Fails closed: if the PR or its comments cannot be read, the merge is blocked.
// Self-contained on purpose: copy this one file into a repo. The marker, head line and verdict line below must match
// what review.cjs writes (test/check.cjs asserts they do).
// ponytail: GitHub itself cannot require a check on a private Free-plan repo; a merge from the web UI still bypasses it.
'use strict';
const {execFileSync}=require('node:child_process');

const MARKER='<!-- fresh-eyes -->';
const BOT=process.env.FRESH_EYES_BOT||'github-actions[bot]'; // who posts the review: the action's default token
const headOf=body=>body.match(/^<!-- head: ([0-9a-f]{40}) -->$/m)?.[1]||null;
const verdictOf=review=>review.match(/^[`*]*VERDICT:[ \t]*(APPROVE|REQUEST_CHANGES)[`*]*[ \t]*$/m)?.[1]||null;

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
  if(!/\bgh\s+pr\s+merge\b/.test(input.tool_input?.command||''))return null;
  ({repo,pr,head}=target(input.tool_input.command));
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
module.exports={decide,target,verdictOf,headOf,MARKER};
