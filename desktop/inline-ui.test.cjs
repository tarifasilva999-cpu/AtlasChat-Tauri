const test=require('node:test');
const assert=require('node:assert/strict');
const {hasPlan,parsePlan,safeCSS,plainText}=require('../atlas-inline-ui.js');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('the reported Markdown game-night answer becomes a plan with real sections and a separate closing action',()=>{
  const reply=`Great idea for a neighborhood game night! Here's how you can get it off the ground:

### Plan Card
**CORE IDEA:** Organize a fun neighborhood game night series.
**FIRST VERSION:**
- Invite 6–10 friends.
- Every other Friday for two months.
- Keep the budget under $15 per person.
**NEXT STEP:** Reach out to potential attendees.

### Detailed Steps
#### Step 1: Invite Attendees
- **Social Media Invitations:** Use a local community group.
- **Example Message:** "Would you like to join our game night?"
#### Step 2: Confirm Attendance
Collect responses before choosing a venue.
#### Step 3: Venue Selection
Choose a place based on the confirmed group.

By following these steps, you can get the game night started.
Next action: Start sending invitations.`;
  assert.equal(hasPlan(reply),true);
  const plan=parsePlan(reply);
  assert.equal(plan.title,'Neighborhood game night');
  assert.equal(plan.overview.length,3);
  assert.equal(plan.sections.length,3);
  assert.match(plan.sections[0].body,/Example Message/);
  assert.doesNotMatch(plan.sections.at(-1).body,/Next action|By following/);
  assert.match(plan.closing,/Start sending invitations/);
});

test('different plans keep their own titles, sections, and code examples',()=>{
  const reply='# Paper garden\n## Roadmap\n#### Sketch the site\nChoose a sunny corner.\n#### First prototype\n```python\n# Keep this comment inside the snippet\nprint("seed")\n```\n#### Review what grew\nCompare the beds.';
  const plan=parsePlan(reply);
  assert.equal(plan.title,'Paper garden');
  assert.deepEqual(plan.sections.map(item=>item.title),['Sketch the site','First prototype','Review what grew']);
  assert.match(plan.sections[1].body,/# Keep this comment/);
});

test('casual answers and quoted Markdown examples do not become visual plans',()=>{
  assert.equal(hasPlan('A plan is a way to organize work.'),false);
  assert.equal(hasPlan('Here is Markdown syntax:\n```markdown\n### Plan Card\nCORE IDEA: Demo\nFIRST VERSION: Demo\nNEXT STEP: Demo\n```'),false);
  assert.equal(hasPlan('```atlas-ui\n<article><h1>A plan</h1></article>\n```'),false);
});

test('existing simple plan blocks remain readable',()=>{
  const plan=parsePlan('CORE IDEA: A small garden\nFIRST VERSION: One raised bed\nNEXT STEP: Measure the corner\nVISUAL: Measure -> Plant -> Review');
  assert.equal(plan.overview.length,4);
  assert.equal(plan.overview.at(-1).body,'Measure -> Plant -> Review');
});

test('visual CSS keeps local SVG references but removes remote resources and legacy script expressions',()=>{
  const css=safeCSS('@import "https://example.com/font.css"; .art{fill:url(#gradient);background:url(https://example.com/photo.png);width:expression(alert(1));}');
  assert.match(css,/url\(#gradient\)/);
  assert.doesNotMatch(css,/@import|https:|expression\s*\(/);
});

test('formatted message copying yields headings and lists without Markdown syntax and preserves code comments',()=>{
  const text=value=>({nodeType:3,textContent:value});
  const element=(tag,...children)=>({nodeType:1,localName:tag,childNodes:children});
  const copied=plainText(element('div',element('h4',text('Step 1: Invite attendees')),element('ul',element('li',element('strong',text('Invite six friends.')))),element('pre',element('code',text('# Keep this code comment\nprint("invite")')))));
  assert.match(copied,/Step 1: Invite attendees/);
  assert.match(copied,/- Invite six friends/);
  assert.doesNotMatch(copied,/####|\*\*/);
  assert.match(copied,/# Keep this code comment/);
});

test('both chat entry points and the shared renderer have valid JavaScript syntax',()=>{
  for(const name of ['Atlas-CHAT.html','index.html']){
    const source=fs.readFileSync(path.join(__dirname,'..',name),'utf8');
    for(const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
      if(/\bsrc\s*=|application\/ld\+json|application\/json/.test(match[1]))continue;
      new vm.Script(match[2],{filename:name});
    }
  }
  new vm.Script(fs.readFileSync(path.join(__dirname,'..','atlas-inline-ui.js'),'utf8'));
});
