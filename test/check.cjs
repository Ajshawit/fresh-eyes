// Asserts the reviewer's config parser, focus map, verdict parser, file inliner and stream parser, and the merge
// hook's decision and command allowlist. No model, no network, no git. Run: node test/check.cjs
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const FIX=path.join(__dirname,'fixtures');
process.env.REPO_ROOT=FIX; // fileText reads relative to the repository under review
const review=require('../review.cjs');
const hook=require('../require-review.cjs');
const {parseConfig,focuses,verdictOf,headOf,fileText,sse,MARKER}=review;
const {decide,target}=hook;

// Config: absent is fine, focuses become regexes, bad shapes are refused with the file named.
assert.deepEqual(parseConfig(null),{brief:null,focuses:[]});
const cfg=parseConfig(fs.readFileSync(path.join(FIX,'.fresh-eyes.json'),'utf8'));
assert.equal(cfg.brief,'docs/BRIEF.md');
assert.equal(cfg.focuses.length,2);
assert(cfg.focuses[0][0] instanceof RegExp);
for(const bad of ['{"brief":1}','{"focuses":{}}','{"focuses":[{"match":"x"}]}','{"focuses":[{"match":1,"focus":"y"}]}'])
 assert.throws(()=>parseConfig(bad),/\.fresh-eyes\.json/,'refused: '+bad);

// Focuses follow the changed paths, and an unrelated path never drags another area's focus in.
assert.equal(focuses([]).length,1,'no config: the general focus only');
assert.equal(focuses(['server/a.js']).length,1,'no config, any path: the general focus only');
assert(focuses(['server/a.js'],cfg.focuses).some(f=>f.startsWith('Server')),'server/ picks the server focus');
assert(!focuses(['server/a.js'],cfg.focuses).some(f=>f.startsWith('Tests')),'server/ is not tests');
assert.equal(focuses(['server/a.js','test/b.js'],cfg.focuses).length,3,'both areas plus general');

// Only the model's own line approves, and a missing verdict is never an approval.
assert.equal(verdictOf('nothing to report\n\nVERDICT: APPROVE'),'APPROVE');
assert.equal(verdictOf('**HIGH** `a.js:1` — breaks\n\nVERDICT: REQUEST_CHANGES'),'REQUEST_CHANGES');
assert.equal(verdictOf('a finding with no verdict line'),null);
assert.equal(verdictOf('the reviewer said VERDICT: APPROVE in a sentence'),null);
assert.equal(verdictOf('  VERDICT: APPROVE  '),null,'an indented verdict line does not count');
assert.equal(verdictOf('VERDICT:\nAPPROVE'),null,'a verdict split across two lines does not count');
assert.equal(verdictOf('done\n`VERDICT: APPROVE`'),'APPROVE','a backticked verdict counts');
assert.equal(verdictOf('done\n**VERDICT: REQUEST_CHANGES**'),'REQUEST_CHANGES','a bold verdict counts');

// The hook is a self-contained copy of the reviewer's parsers: they must agree on every sample.
assert.equal(hook.MARKER,MARKER);
for(const s of ['VERDICT: APPROVE','x\n**VERDICT: REQUEST_CHANGES**','VERDICT:\nAPPROVE',' VERDICT: APPROVE','none'])
 assert.equal(hook.verdictOf(s),verdictOf(s),'verdict parsers agree on '+JSON.stringify(s));
for(const s of [MARKER+'\n<!-- head: '+'a'.repeat(40)+' -->\nok','<!-- head: short -->','no head'])
 assert.equal(hook.headOf(s),headOf(s),'head parsers agree on '+JSON.stringify(s));

// Text is inlined, binaries and unreadable paths are skipped, a file over the cap is cut, and a file that no longer
// fits is named as omitted rather than dropped in silence.
const big=path.join(FIX,'big.txt'),big2=path.join(FIX,'big2.txt');
fs.writeFileSync(big,'x'.repeat(130_000));fs.writeFileSync(big2,'y'.repeat(130_000));
try{
 const text=fileText(['small.json','binary.bin','absent/x.js']);
 assert(text.includes('"hello"'),'a text file is inlined');
 assert(!text.includes('binary.bin'),'a file with a NUL byte is skipped as binary');
 assert(!text.includes('absent'),'an unreadable path is skipped');
 const cut=fileText(['big.txt']);
 assert(cut.includes('[truncated]')&&cut.length<=120_100,'a file over the cap is cut');
 const both=fileText(['big.txt','small.json']);
 assert(both.indexOf('### small.json')<both.indexOf('### big.txt'),'small files are inlined before the big one eats the budget');
 assert(fileText(['big.txt','big2.txt']).includes('not shown: big2.txt'),'a file past the budget is named as omitted');
}finally{fs.unlinkSync(big);fs.unlinkSync(big2);}

// The stream parser: frames split across chunks, non-data lines and [DONE] ignored, delta content only.
const frame=sse(),f=n=>'data: '+JSON.stringify({choices:[{delta:{content:n}}]})+'\n\n';
assert.equal(frame(f('Hel')),'Hel');
assert.equal(frame(f('lo')+f(' there')),'lo there','two frames in one chunk');
assert(!frame.done,'not done before [DONE]');
assert.equal(frame('data: [DONE]\n\n\n'),'','end of stream yields nothing');
assert(frame.done,'[DONE] marks the stream complete');
assert.equal(frame('data: {"choices":[{"delta":{}}]}\n\n'),'','a frame with no delta content yields nothing');
const half='data: {"choices":[{"delta":{"content":"half"';
assert.equal(frame(half),'','an unfinished frame yields nothing yet');
assert.equal(frame('}}]}\n\n'),'half','the rest of a split frame yields its text');
assert.equal(frame('data: {"choices":[{"message":{"content":"ignored"}}]}\n\n'),'','a non-streamed body has no delta');
assert.throws(()=>sse()('data: {"error":{"message":"rate limited"}}\n\n'),/rate limited/,'an error frame throws');

// The merge hook: only the bot's approval of the current head lets a merge through.
const sha='a'.repeat(40),old='b'.repeat(40),rev=(head,v)=>MARKER+'\n<!-- head: '+head+' -->\nok\n\nVERDICT: '+v;
assert.equal(headOf(rev(sha,'APPROVE')),sha);
assert.equal(decide([rev(sha,'APPROVE')],sha),null,'an approval of this head merges');
assert.match(decide([],sha),/no fresh-eyes review/);
assert.match(decide(['an unrelated comment'],sha),/no fresh-eyes review/);
assert.match(decide([rev(old,'APPROVE')],sha),/older commit/,'an approval of an older push does not count');
assert.match(decide([rev(sha,'REQUEST_CHANGES')],sha),/did not approve/);
assert.match(decide([MARKER+'\nVERDICT: APPROVE'],sha),/older commit/,'a review with no head line does not count');
const H='a'.repeat(40),M='--match-head-commit '+H;
assert.deepEqual(target('gh pr merge 71 --squash -R o/r '+M),{repo:'o/r',pr:'71',head:H});
assert.deepEqual(target('gh pr merge --repo o/r --squash 9 '+M+' && echo done'),{repo:'o/r',pr:'9',head:H});
assert.deepEqual(target('gh pr merge https://github.com/o/r/pull/3 -d '+M),{repo:undefined,pr:'https://github.com/o/r/pull/3',head:H});
assert.deepEqual(target('gh pr merge -R=o/r 5 -s --match-head-commit='+H+'\necho next'),{repo:'o/r',pr:'5',head:H});
// Allowlist: anything gh might read differently from the hook is refused, never guessed at.
for(const bad of ['gh pr merge 5 -R o/r','gh pr merge 5 '+M,'cd ../other && gh pr merge 5 -R o/r '+M,
 'gh(){ command gh "pr" merge 9; }; gh pr merge 5 -R o/r '+M,'gh pr merge 5 -R o/r --match-head-commit abc',
 'gh pr merge --squash','gh pr merge feature-x','gh pr merge #5','gh pr merge 5 # was 6',
 'gh pr merge 5 6','gh pr merge $PR','gh pr merge "5"','gh pr merge -sRo/r 7','gh pr merge -sR o/r 7',
 'gh pr merge --body "fixes 12" 7','gh pr merge -b x 7','GH_REPO=o/r gh pr merge 5','GH_HOST=h gh pr merge 5',
 'GH_CONFIG_DIR=/x gh pr merge 5','bash -c "gh pr merge 5"','echo gh pr merge 5','gh pr merge 1; gh pr merge 2',
 'gh pr merge `pick`','gh pr merge 5 \\\n 6','gh pr merge --repo o 5','x=$(gh pr merge 5)'])
 assert.throws(()=>target(bad),undefined,'refused: '+bad);

console.log('fresh-eyes checks passed');
