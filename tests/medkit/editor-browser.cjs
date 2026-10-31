/** Chromium DOM/layout regression checks against Foundry's stylesheet and a mock world.
 * node tests/editor-browser.cjs
 * Optional: DS_AUTO_CHROME, FOUNDRY_APP, DS_AUTO_EDITOR_ARTIFACTS.
 * Generated fixtures, screenshots and browser profiles stay in a temporary directory.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const paths = require('./paths.cjs'), hb = paths.handlebars();
const appRoot = process.env.FOUNDRY_APP || 'C:/Program Files/Foundry Virtual Tabletop/resources/app';
const chrome = process.env.DS_AUTO_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!fs.existsSync(chrome)) throw new Error('Set DS_AUTO_CHROME to a Chromium browser executable.');
const artifacts = process.env.DS_AUTO_EDITOR_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'ds-editor-qa-'));
fs.mkdirSync(artifacts, { recursive: true });
const compiled = hb.precompile(fs.readFileSync(path.join(paths.TEMPLATES, 'automation-editor.hbs'), 'utf8'));
const lang = { ...JSON.parse(fs.readFileSync(path.join(paths.CORE, 'lang/en.json'), 'utf8')), ...JSON.parse(fs.readFileSync(path.join(paths.MEDKIT, 'lang/en.json'), 'utf8')) };
const script = String.raw`
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const clone = v => JSON.parse(JSON.stringify(v));
const localize = key => key.split('.').reduce((o, k) => o?.[k], LANG) ?? key;
Handlebars.registerHelper('localize', localize); Handlebars.registerHelper('checked', v => v ? 'checked' : '');
const template = Handlebars.template(TEMPLATE), form = document.querySelector('form');
let saves = 0, confirm = true, failSave = false, serial = 0;
const preset = { version: 1, rules: [{ id: 'preset-rule', event: 'use', targets: 'self', effects: [{ id: 'surge', type: 'resource', value: '1', resource: 'surge', targets: 'self' }] }] };
let worldPresets = [{ id: 'preset-1', name: 'Surge', automation: preset }];
const library = {
 resolve: () => ({}), editableAutomation: item => clone(item.flags['stef-ds-automation'].automation), presets: () => clone(worldPresets),
 async savePreset(name, value, id) { const p = { id: id || 'new-preset', name, automation: clone(value) }; worldPresets = worldPresets.filter(p => p.id !== id); worldPresets.push(p); return p; },
 async deletePreset(id) { worldPresets = worldPresets.filter(p => p.id !== id); },
 presetDraft(value, current, { append }) { const next = clone(value); for (const r of next.rules) { r.id = 'loaded-' + ++serial; for (const e of r.effects) e.id = 'loaded-effect-' + ++serial; } if (append) next.rules.unshift(...clone(current.rules)); return next; },
 async saveAutomation(item, value) { if (failSave) throw new Error('Rule 1: invalid effect formula'); saves++; item.flags['stef-ds-automation'].automation = clone(value); },
};
globalThis.game = { user: { isGM: true }, modules: new Map([['stef-ds-automation', { api: { library } }]]), i18n: { localize } };
globalThis.CONFIG = { statusEffects: [{ id: 'prone' }, { id: 'slowed' }] };
globalThis.ds = { CONFIG: { damageTypes: { fire: {}, cold: {} }, characteristics: { might: {}, agility: {} } } };
class ApplicationV2 {
 constructor() { this.element = form; }
 render() { const ctx = this._prepareContext(); form.querySelector('.window-content').innerHTML = template(ctx); this._onRender(ctx, {}); return this; }
 async close() { this.closed = true; }
}
globalThis.foundry = { utils: { randomID: () => (++serial).toString().padStart(10, '0') }, applications: { api: { ApplicationV2, HandlebarsApplicationMixin: Base => Base, DialogV2: { confirm: async () => confirm } } } };
const { AutomationEditor } = await import('/editor.mjs');
const automation = { version: 1, area: 'auto', suppress: ['native-damage'], rules: [{ id: 'damage-push', label: 'Damage and push', event: 'use', targets: 'targets', once: 'round', keywords: ['goblin'], range: '3', limit: '2', cost: 3, optional: true, end: 'roundEnd', require: { adjacent: true, sourceWithin: '2' }, effects: [
 { id: 'fire', type: 'damage', value: '@M + 2', damageType: 'fire', targets: 'targets', tiers: [2, 3], potency: { characteristic: 'might', value: '2' }, when: { spend: false } },
 { id: 'push', type: 'forced', distance: '2', movement: 'push', targets: 'targets', ignoresStability: true }], }] };
const item = { name: 'Spitfire', flags: { 'stef-ds-automation': { automation: clone(automation) } }, system: { power: { effects: { contents: [{ id: 'native-damage', name: 'Damage' }, { id: 'native-prone', name: 'Prone' }] } } } };
const editor = new AutomationEditor({ item });
const $ = selector => form.querySelector(selector), field = name => $('[name="' + name + '"]');
const action = async (name, dataset = {}) => AutomationEditor.DEFAULT_OPTIONS.actions[name].call(editor, {}, { dataset });
const change = (el, value, event = 'input') => { el.value = value; el.dispatchEvent(new Event(event, { bubbles: true })); };
const checks = [];
try {
 editor.draft = { version: 1, rules: [] }; editor.render();
 assert($('.ds-editor-empty').textContent.includes('No custom rules'), 'Empty editor explains how to start');
 const allTypes = [
  { type: 'damage', value: '5', damageType: 'fire' }, { type: 'heal', value: '2', recoveries: 1, temporary: true },
  { type: 'condition', status: 'prone', end: 'save', stacking: true }, { type: 'cleanse', statuses: ['slowed'], count: 1 },
  { type: 'resource', value: '1', resource: 'surge' }, { type: 'forced', distance: '2', movement: 'push', vertical: true },
  { type: 'teleport', distance: '5', autoStart: true, hideWhileObserved: true },
  { type: 'modifier', key: 'system.movement.value', value: '2', mode: 'add' }, { type: 'note', text: 'A multiline note\nfor the owner.' },
 ].map((e, i) => ({ ...e, id: 'all-' + i, targets: 'targets' }));
 editor.draft = { version: 1, rules: [{ id: 'all-types', event: 'use', targets: 'targets', effects: allTypes }] }; editor.render();
 assert(form.querySelectorAll('[data-effect-id]').length === 9, 'All authorable effect types render');
 assert(field('rules.0.effects.8.text').tagName === 'TEXTAREA', 'Notes use multiline control');
 editor.readDraft();
 assert(editor.draft.rules[0].effects[1].temporary && editor.draft.rules[0].effects[6].hideWhileObserved, 'Primary and advanced checkboxes survive read');
 assert(editor.draft.rules[0].effects[3].statuses[0] === 'slowed', 'List fields survive read');
 editor.draft = clone(automation); editor.viewState = { disclosures: {}, presetId: '', presetName: '', presetAppend: false };
 editor.render();
 assert(saves === 0, 'Opening must not save');
 assert($('[data-rule-summary]').textContent.includes('Selected ability targets'), 'Readable rule summary');
 assert(field('rules.0.event').selectedOptions[0].textContent === 'When this feature is used', 'Readable activation label');
 assert([...form.querySelectorAll('details')].every(d => !d.open), 'Advanced sections start collapsed');
 assert(field('rules.0.effects.0.value').getClientRects().length, 'Damage formula visible');
 assert(field('rules.0.effects.0.tiers').closest('details').open === false, 'Tier gates collapsed');
 editor.readDraft();
 assert(editor.draft.rules[0].effects[0].when.spend === false, 'Collapsed false gate survives');
 assert(editor.draft.rules[0].effects[0].tiers.join(',') === '2,3', 'Collapsed tiers survive');
 assert(editor.draft.rules[0].require.adjacent && editor.draft.rules[0].cost === 3, 'Collapsed requirements/cost survive');
 assert(editor.draft.suppress[0] === 'native-damage', 'Collapsed replacement survives');
 change(field('rules.0.effects.0.tiers'), '2, 3, ');
 assert(editor.draft.rules[0].effects[0].tiers.join(',') === '2,3', 'Trailing list commas do not introduce tier zero');
 checks.push('Grouping and collapsed values');
 $('[data-disclosure="rule:damage-push"]').open = true;
 field('rules.0.label').focus(); change(field('rules.0.label'), 'Unsaved rule');
 assert($('[data-rule-title]').textContent === 'Unsaved rule', 'Title updates on input');
 $('.ds-editor-scroll').scrollTop = 240; editor.readDraft(); const oldScroll = $('.ds-editor-scroll').scrollTop;
 editor.render();
 assert($('[data-disclosure="rule:damage-push"]').open, 'Disclosure preserved');
 assert(Math.abs($('.ds-editor-scroll').scrollTop - oldScroll) <= 1, 'Scroll preserved');
 assert(document.activeElement === field('rules.0.label'), 'Focus preserved');
 await action('addEffect', { rule: '0' });
 assert(editor.draft.rules[0].label === 'Unsaved rule', 'Unsaved label preserved');
 assert(document.activeElement.hasAttribute('data-effect-type'), 'New effect focused');
 await action('removeEffect', { rule: '0', effect: '2' });
 assert(document.activeElement.dataset.action === 'addEffect', 'Focus after removal');
 change($('[data-effect-type]'), 'teleport', 'change');
 assert(editor.draft.rules[0].effects[0].tiers.join(',') === '2,3' && editor.draft.rules[0].effects[0].when.spend === false, 'Type change preserves gates');
 assert(editor.draft.rules[0].effects[1].distance === '2', 'Sibling effect preserved');
 checks.push('Draft, disclosure, scroll, focus and type changes');
 const read = editor.readDraft.bind(editor); let reads = 0; editor.readDraft = () => { reads++; read(); };
 editor.render(); editor.render(); change(field('rules.0.label'), 'One listener');
 assert(reads === 1, 'No listener accumulation'); editor.readDraft = read;
 await action('addRule'); const newId = editor.draft.rules[1].id;
 $('[data-disclosure="rule:' + newId + '"]').open = true; await action('removeRule', { rule: '0' });
 assert($('[data-disclosure="rule:' + newId + '"]').open, 'Disclosures follow stable IDs');
 checks.push('Stable IDs and listeners');
 $('[data-disclosure="presets"]').open = true;
 change(field('presetId'), 'preset-1'); change(field('presetName'), 'Copied surge');
 assert(!$('[data-action="applyPreset"]').disabled && !$('[data-action="renamePreset"]').disabled, 'Preset action availability');
 confirm = false; const before = JSON.stringify(editor.draft); await action('applyPreset');
 assert(JSON.stringify(editor.draft) === before, 'Cancelled replacement preserves draft');
 confirm = true; await action('applyPreset');
 assert(editor.draft.rules.length === 1 && editor.draft.rules[0].effects[0].type === 'resource', 'Replacement works');
 field('presetAppend').checked = true; await action('applyPreset');
 assert(editor.draft.rules.length === 2, 'Append works');
 editor.draft.rules[1].effects[0].value = '9'; assert(worldPresets[0].automation.rules[0].effects[0].value === '1', 'Preset independent');
 await action('renamePreset'); assert(worldPresets[0].name === 'Copied surge', 'Rename works');
 await action('savePreset'); assert(worldPresets.length === 2, 'Save preset works');
 await action('deletePreset'); assert(worldPresets.length === 1 && $('[data-action="applyPreset"]').disabled, 'Delete and disabled selection work');
 assert(saves === 0, 'Draft/preset operations do not save item'); checks.push('Presets, cancellation and copies');
 failSave = true; await AutomationEditor.submit.call(editor);
 assert($('[role="alert"]').textContent.includes('Rule 1'), 'Validation visible');
 assert($('[data-disclosure="rule:' + editor.draft.rules[0].id + '"]').open, 'Invalid rule expanded');
 failSave = false; await AutomationEditor.submit.call(editor);
 assert(saves === 1 && editor.closed, 'Explicit save works'); checks.push('Validation and save');
 editor.errors = null; editor.closed = false; editor.draft = clone(automation); editor.viewState = { disclosures: {}, presetId: '', presetName: '', presetAppend: false }; editor.render();
 if (new URLSearchParams(location.search).has('advanced')) for (const details of form.querySelectorAll('details')) details.open = true;
 if (new URLSearchParams(location.search).has('effects')) $('.ds-editor-step:last-of-type').scrollIntoView({ block: 'start' });
 for (const [query, selector] of [['rule-settings', '[data-disclosure="rule:damage-push"]'], ['effect-settings', '[data-disclosure="effect:damage-push:fire"]']]) {
  if (!new URLSearchParams(location.search).has(query)) continue;
  const details = $(selector); details.open = true; details.scrollIntoView({ block: 'start' });
 }
 await new Promise(resolve => setTimeout(resolve, 0));
 const footer = $('.ds-editor-footer').getBoundingClientRect(), content = $('.ds-editor-scroll');
 assert(footer.bottom <= innerHeight && footer.bottom <= form.getBoundingClientRect().bottom + 1, 'Footer within viewport');
 assert(content.scrollHeight > content.clientHeight, 'Content scrolls');
 assert(content.scrollWidth <= content.clientWidth + 1, 'No horizontal overflow');
 const columns = getComputedStyle($('.ds-editor-grid')).gridTemplateColumns.split(' ').length;
 assert(columns === (form.clientWidth <= 540 ? 1 : 2), 'Responsive column count');
 checks.push('Responsive columns, scrolling and footer');
 document.title = 'PASS: Automation editor'; document.querySelector('#result').textContent = JSON.stringify({ ok: true, checks, columns, viewport: [innerWidth, innerHeight] });
} catch (e) { document.title = 'FAIL: Automation editor'; document.querySelector('#result').textContent = JSON.stringify({ ok: false, error: e.stack, checks }); }
`;
const fixture = `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/foundry/fonts/fontawesome/css/all.min.css"><link rel="stylesheet" href="/foundry/css/foundry2.css"><link rel="stylesheet" href="/medkit.css"><style>
body { margin: 0; padding: 10px; display: block; background: var(--color-cool-5); }
form.application { position: relative; inset: auto; width: min(720px, calc(100vw - 20px)); height: min(680px, calc(100vh - 20px)); margin: 0; }
#result { display: none; }
</style></head><body><form class="application ds-auto-medkit automation-editor"><header class="window-header"><h1 class="window-title">Automation editor - Spitfire</h1></header><div class="window-content"></div></form><pre id="result"></pre><script>document.body.className = new URLSearchParams(location.search).get('theme') === 'light' ? 'theme-light' : 'theme-dark'; if (new URLSearchParams(location.search).has('narrow')) document.querySelector('form').style.width = '430px';</script><script src="/handlebars.js"></script><script type="module">${script.replace('LANG', JSON.stringify(lang)).replace('TEMPLATE', compiled)}</script></body></html>`;
const server = http.createServer((req, res) => {
 const url = new URL(req.url, 'http://localhost');
 if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture); }
 const direct = { '/editor.mjs': path.join(paths.SCRIPTS, 'automation-editor.mjs'), '/shared.mjs': path.join(paths.SCRIPTS, 'shared.mjs'), '/medkit.css': path.join(paths.MEDKIT, 'styles/medkit.css'), '/handlebars.js': path.join(appRoot, 'node_modules/handlebars/dist/handlebars.runtime.js') };
 const file = direct[url.pathname] || (url.pathname.startsWith('/foundry/') ? path.resolve(appRoot, 'public', '.' + url.pathname.slice('/foundry'.length)) : null);
 if (!file || !fs.existsSync(file) || (!direct[url.pathname] && !file.startsWith(path.resolve(appRoot, 'public') + path.sep))) { res.writeHead(404); return res.end(); }
 res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : /\.m?js$/.test(file) ? 'text/javascript' : 'application/octet-stream'); fs.createReadStream(file).pipe(res);
});
const run = args => new Promise((resolve, reject) => {
 const proc = spawn(chrome, args, { windowsHide: true }); let output = '', errors = '';
 const timer = setTimeout(() => { proc.kill(); reject(new Error('Chromium timed out\n' + errors.slice(-1000))); }, 45000);
 proc.stdout.on('data', c => output += c); proc.stderr.on('data', c => errors += c);
 proc.on('error', e => { clearTimeout(timer); reject(e); }); proc.on('close', code => { clearTimeout(timer); code ? reject(new Error(`Chromium exited ${code}\n${errors.slice(-1000)}`)) : resolve(output); });
});
(async () => {
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  for (const [name, w, h, query] of [['dark',740,720,''], ['light',740,720,'theme=light'], ['narrow',740,720,'narrow=1'], ['short',740,440,''], ['advanced',740,720,'advanced=1'], ['effects',740,720,'effects=1'], ['rule-settings',740,800,'rule-settings=1'], ['effect-settings',740,800,'effect-settings=1']]) {
   const html = await run(['--headless', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(artifacts, 'profile-' + name)}`, `--window-size=${w},${h}`, '--virtual-time-budget=3000', `--screenshot=${path.join(artifacts, name + '.png')}`, '--dump-dom', `http://127.0.0.1:${server.address().port}/?${query}`]);
   fs.writeFileSync(path.join(artifacts, name + '.html'), html);
   const result = /<pre id="result">([\s\S]*?)<\/pre>/.exec(html)?.[1];
   if (!result) throw new Error(name + ': no browser test result');
   const report = JSON.parse(result.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
   if (!report.ok) throw new Error(`${name}: ${report.error}\nPassed: ${report.checks.join(', ')}`);
   console.log(`${name}: ${report.checks.length} groups passed, ${report.columns} columns, viewport ${report.viewport.join('x')}`);
  }
  console.log('Screenshots: ' + artifacts);
 } finally { server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
