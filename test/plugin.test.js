// Checks the plugin without Steam: the BUILT file (plugin/dist/arkada/.millennium/Dist/index.js) is run in a
// made-up Steam page (test/fake-steam.js) against the reference hub of kit.txt, started here on a free port.
//   node test/plugin.test.js [path to kit hub.js]      default: ../kit.txt/hub/hub.js next to this folder
//   node test/plugin.test.js --bundle <file.js>        check another build of the same plugin, e.g. the script taken
//                                                      out of dist-star/arkada.star (see README)
// What this proves: the hub side of the plugin. What it cannot prove: that Steam really has the calls the
// fake page imitates — see README, «Что не проверено».
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const bundleAt = argv.indexOf('--bundle');
const bundle = bundleAt >= 0 ? path.resolve(argv.splice(bundleAt, 2)[1]) : path.join(root, 'plugin', 'dist', 'arkada', '.millennium', 'Dist', 'index.js');
const hubJs = path.resolve(argv[0] || path.join(root, '..', 'kit.txt', 'hub', 'hub.js'));
const { connect } = require(path.join(root, 'plugin', 'src', 'hub-client.js'));
const { createArkada, STORAGE_KEY } = require(path.join(root, 'plugin', 'src', 'core.js'));
const { makePage, browserLikeWebSocket } = require('./fake-steam.js');
const { makeDomWindow } = require('./fake-dom.js');

// Both the page and the tester below get a WebSocket that behaves as a browser's does (see fake-steam.js).
// ARKADA_NODE_WEBSOCKET=1 leaves Node's own in place, to see that the hub client copes with that one too.
if (!process.env.ARKADA_NODE_WEBSOCKET) globalThis.WebSocket = browserLikeWebSocket(globalThis.WebSocket);

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok    ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '\n        ' + JSON.stringify(detail) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) {
    let v; try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for: ' + label);
    await sleep(25);
  }
}
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// The reference hub as a separate process; only this very process is ever stopped
let hubProc = null;
function startHub(port) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [hubJs, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; if (/listening/.test(out)) { hubProc = p; res(p); } });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => { if (hubProc !== p) rej(new Error('hub did not start (' + code + '): ' + out)); });
  });
}
function stopHub() {
  return new Promise(res => {
    const p = hubProc;
    if (!p) return res();
    hubProc = null;
    p.on('exit', () => res());
    p.kill();
  });
}

const problems = [];
process.on('uncaughtException', e => problems.push('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', e => problems.push('unhandled: ' + (e && e.stack || e)));

async function main() {
  const port = await freePort();
  console.log('Hub: ' + hubJs + ' on port ' + port + '\nPlugin: ' + bundle + '\n');

  // The plugin's client always goes to 42080; for the check the same built text is pointed at the free port.
  // Nothing else in the file is touched (the one replaced place is counted below).
  const text = fs.readFileSync(bundle, 'utf8');
  const marker = /(= ?)42080(?![0-9])/g; // `const DEFAULT_PORT = 42080` — or `n=42080` once starlight has shortened the names
  ok((text.match(marker) || []).length === 1, 'built file has the hub port in exactly one place');
  // Kapsula's port too goes to a free one: the check must never reach a Kapsula running on this PC
  const kapsulaPort = await freePort();
  const kMarker = /(PORT ?= ?)42071(?![0-9])/g;
  ok((text.match(kMarker) || []).length === 1, "built file has Kapsula's port in exactly one place");
  const page = makePage({ WebSocket: globalThis.WebSocket });
  // The theme's switches (tab «Arkada»): Kapsula off for now, the size on disk on
  page.popupRoot.computed['--arkada-kapsula'] = 'off';
  page.popupRoot.computed['--arkada-disk-size'] = 'on';

  // ───────── 1. Steam loads the plugin while the hub is not running ─────────
  console.log('1. Plugin loads without a hub');
  vm.runInContext(text.replace(marker, '$1' + port).replace(kMarker, '$1' + kapsulaPort), page.context, { filename: 'index.js' });
  await until(() => page.ipc.length === 1, 'plugin reports itself loaded to Millennium');
  ok(eq(page.ipc[0], [1, { pluginName: 'arkada' }]), 'tells Millennium it has loaded, as the Kapsula plugin does', page.ipc[0]);
  ok(typeof page.window.PLUGIN_LIST.arkada.default === 'function', 'registered in PLUGIN_LIST under "arkada"');
  ok(page.window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS.arkada === undefined, 'adds no page of its own to Steam');
  ok(Object.prototype.hasOwnProperty.call(page.window.NotificationStore, 'BShowToast'), 'listens to Steam notifications');
  page.steam.game(570, true); // a game starts while the hub is away
  await sleep(1300);          // long enough for the first retry to fail too
  ok(page.log.length === 0, 'stays quiet: nothing written to the console', page.log);
  ok(problems.length === 0, 'stays quiet: nothing thrown', problems);

  // ───────── 2. The hub appears ─────────
  console.log('2. Hub starts, plugin joins by itself');
  await startHub(port);
  const seen = { states: {}, events: [], online: false };
  const tester = connect({
    app: 'tester', name: 'Tester', port, topics: ['arkada.*', 'hub.apps', 'hub.theme'],
    onState(topic, data, from) { seen.states[topic] = { data, from }; },
    onEvent(topic, data, from) { seen.events.push({ topic, data, from }); },
    onStatus(on) { seen.online = on; },
  });
  const state = t => seen.states[t] && seen.states[t].data;
  const arkadaApp = () => (state('hub.apps') || []).find(a => a.app === 'arkada');
  await until(arkadaApp, 'arkada in hub.apps');
  const app = arkadaApp();
  ok(app.app === 'arkada' && app.name === 'Arkada', 'hello arrives as app "arkada", name "Arkada"', app);
  ok(app.version === JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'plugin.json'), 'utf8')).version, 'version is the one from plugin.json', app.version);
  ok(eq(app.commands.slice().sort(), ['game.launch', 'invite.accept', 'library.open', 'settings.run', 'settings.set']), 'announces its commands', app.commands);

  await until(() => state('arkada.game'), 'arkada.game');
  const game = state('arkada.game');
  ok(game.appId === 570 && game.name === 'Dota 2' && typeof game.since === 'number', 'the game started before the hub is reported: { appId, name, since }', game);
  ok(seen.states['arkada.game'].from === 'arkada', 'state comes from "arkada"');

  await until(() => state('arkada.settings'), 'arkada.settings');
  const items = state('arkada.settings').groups[0].items;
  ok(eq(items.map(i => [i.key, i.type, i.label, i.value]), [
    ['shareGames', 'switch', 'Показывать игры другим приложениям dev.txt', true],
    ['shareDownloads', 'switch', 'Показывать загрузки', true],
    ['shareInvites', 'switch', 'Показывать приглашения', true],
    ['shareMessages', 'switch', 'Показывать сообщения', true],
  ]), 'arkada.settings: four switches, all on', items);
  await until(() => state('arkada.friends'), 'arkada.friends');
  ok(eq(state('arkada.friends'), { online: 2, inGame: 1 }), 'arkada.friends: online and in-game counts', state('arkada.friends'));
  ok(state('arkada.downloads') === undefined || state('arkada.downloads') === null, 'arkada.downloads is empty while nothing downloads');

  // ───────── 3. States ─────────
  console.log('3. States follow Steam');
  page.steam.game(570, false);
  await until(() => state('arkada.game') === null, 'game cleared');
  ok(true, 'game closed → arkada.game is null');
  page.steam.game(0, true);
  page.steam.game(730, true);
  await until(() => state('arkada.game') && state('arkada.game').appId === 730, 'second game');
  ok(state('arkada.game').name === 'Counter-Strike 2', 'another game started → arkada.game names it (a non-Steam shortcut with number 0 is skipped)', state('arkada.game'));

  page.steam.download({ update_appid: 1245620, update_state: 'Downloading', paused: false, overall_percent_complete: 42, update_network_bytes_per_second: 5242880 });
  await until(() => state('arkada.downloads'), 'download');
  ok(eq(state('arkada.downloads'), { appId: 1245620, name: 'ELDEN RING', progress: 0.42, bytesPerSecond: 5242880, paused: false }), 'download → arkada.downloads { appId, name, progress 0–1, bytesPerSecond, paused }', state('arkada.downloads'));
  page.steam.download({ update_appid: 0, update_state: 'None' });
  await until(() => state('arkada.downloads') === null, 'download cleared');
  ok(true, 'download finished → arkada.downloads is null');

  // ───────── 4. Events ─────────
  console.log('4. Events mirror Steam notifications');
  const event = topic => seen.events.find(e => e.topic === topic);
  const r1 = page.steam.toast({ strTest: 'Achievement' }, { title: 'First Blood', body: 'Win a match', icon: 'https://cdn.steamstatic.com/a.jpg', appid: 570 }, true);
  const r2 = page.steam.toast({ strTest: 'Friend Message' }, { title: 'Liza', body: 'Go?', icon: 'https://avatars.steamstatic.com/l.jpg', steamid: '76561198000000001', response_steamurl: 'steam://friends/message/76561198000000001' }, true);
  const r3 = page.steam.toast({ strTest: 'Friend Message' }, { body: 'Play with me', steamid: '76561198000000002', response_steamurl: 'steam://joinlobby/730/109775241/76561198000000002' }, true);
  const r4 = page.steam.toast({ strTest: 'Friend Message' }, { title: 'Hidden', body: 'Steam decided not to show this', steamid: '76561198000000001' }, false);
  await until(() => seen.events.length >= 3, 'three events');
  await sleep(150);
  ok(eq([r1, r2, r3, r4], [true, true, true, false]), "Steam's own answer (show or not) is passed through untouched", [r1, r2, r3, r4]);
  ok(seen.events.length === 3, 'a notification Steam itself does not show makes no event', seen.events.length);
  ok(eq(event('arkada.achievement').data, { appId: 570, game: 'Dota 2', title: 'First Blood', text: 'Win a match', icon: 'https://cdn.steamstatic.com/a.jpg' }), 'arkada.achievement', event('arkada.achievement'));
  ok(eq(event('arkada.message').data, { steamid: '76561198000000001', from: 'Liza', text: 'Go?', icon: 'https://avatars.steamstatic.com/l.jpg' }), 'arkada.message', event('arkada.message'));
  ok(eq(event('arkada.invite').data, { steamid: '76561198000000002', from: 'Timur', game: 'Counter-Strike 2', appId: 0, text: 'Play with me', icon: 'https://avatars.steamstatic.com/t.jpg', url: 'steam://joinlobby/730/109775241/76561198000000002' }), 'arkada.invite: who and which game, taken from the friends list', event('arkada.invite'));

  // ───────── 5. Commands ─────────
  console.log('5. Commands');
  let r = await tester.command('arkada', 'game.launch', { appId: 730 });
  ok(r.ok && eq(r.data, { appId: 730, name: 'Counter-Strike 2' }) && page.calls.urls.includes('steam://rungameid/730'), 'game.launch { appId } → steam://rungameid/730', [r, page.calls.urls]);
  r = await tester.command('arkada', 'game.launch', { appId: 'rm -rf' });
  ok(!r.ok && r.error === 'bad-app', 'game.launch with a bad number is refused', r);
  r = await tester.command('arkada', 'library.open');
  ok(r.ok && page.calls.urls.includes('steam://open/library'), 'library.open → steam://open/library', r);
  r = await tester.command('arkada', 'invite.accept', { steamid: '76561198000000002' });
  ok(r.ok && page.calls.accepted === 1, 'invite.accept { steamid } accepts the invite in Steam chat', [r, page.calls]);
  r = await tester.command('arkada', 'invite.accept', { url: 'steam://joinlobby/730/1/2' });
  ok(r.ok && page.calls.urls.includes('steam://joinlobby/730/1/2'), 'invite.accept { url } opens the join address', r);
  r = await tester.command('arkada', 'invite.accept', { url: 'steam://run/730//-insecure' });
  ok(!r.ok && r.error === 'bad-url', 'invite.accept refuses an address that is not a join address', r);
  r = await tester.command('arkada', 'invite.accept', { steamid: '76561198000000009' });
  ok(!r.ok && r.error === 'no-invite', 'invite.accept without a known invite fails', r);
  r = await tester.command('arkada', 'steam.quit');
  ok(!r.ok && r.error === 'unknown-command', 'an unknown command is refused', r);

  // ───────── 6. Settings ─────────
  console.log('6. Settings');
  const value = key => state('arkada.settings').groups[0].items.find(i => i.key === key).value;
  r = await tester.command('arkada', 'settings.set', { key: 'shareGames', value: false });
  ok(r.ok && eq(r.data, { key: 'shareGames', value: false }), 'settings.set { shareGames: false } is accepted', r);
  await until(() => value('shareGames') === false, 'settings republished');
  ok(true, 'arkada.settings comes again, whole, with the new value');
  await until(() => state('arkada.game') === null, 'game hidden');
  ok(true, 'with games hidden arkada.game becomes null although the game still runs');
  ok(eq(JSON.parse(page.storage.getItem(STORAGE_KEY)), { shareGames: false, shareDownloads: true, shareInvites: true, shareMessages: true }), 'the setting is saved in localStorage of the Steam page', page.storage.getItem(STORAGE_KEY));
  const before = seen.events.length;
  page.steam.toast({ strTest: 'Achievement' }, { title: 'Hidden one', appid: 730 }, true);
  await sleep(250);
  ok(seen.events.length === before, 'with games hidden an achievement makes no event');
  r = await tester.command('arkada', 'settings.set', { key: 'shareGames', value: true });
  await until(() => state('arkada.game') && state('arkada.game').appId === 730, 'game back');
  ok(r.ok && value('shareGames') === true, 'switched back on → the running game is reported again');
  r = await tester.command('arkada', 'settings.set', { key: 'shareInvites', value: false });
  page.steam.toast({ strTest: 'Friend Message' }, { body: 'again', steamid: '76561198000000002', response_steamurl: 'steam://joinlobby/730/5/6' }, true);
  await sleep(250);
  ok(r.ok && seen.events.length === before, 'with invites hidden an invite makes no event');
  r = await tester.command('arkada', 'settings.set', { key: 'shareMessages', value: false });
  page.steam.toast({ strTest: 'Friend Message' }, { title: 'Liza', body: 'hidden text', steamid: '76561198000000001' }, true);
  await sleep(250);
  ok(r.ok && seen.events.length === before, 'with messages hidden a message makes no event');
  r = await tester.command('arkada', 'settings.set', { key: 'shareMessages', value: true });
  page.steam.toast({ strTest: 'Friend Message' }, { title: 'Liza', body: 'visible text', steamid: '76561198000000001' }, true);
  await until(() => seen.events.length === before + 1, 'message event after switching back on');
  ok(r.ok && seen.events[seen.events.length - 1].topic === 'arkada.message', 'switched back on → a message makes an event again', seen.events[seen.events.length - 1]);
  r = await tester.command('arkada', 'settings.set', { key: 'volume', value: true });
  ok(!r.ok && r.error === 'unknown-key', 'an unknown key is refused with ok: false', r);
  r = await tester.command('arkada', 'settings.set', { key: 'shareInvites', value: 'yes' });
  ok(!r.ok && r.error === 'bad-value', 'a value that is not yes/no is refused', r);
  r = await tester.command('arkada', 'settings.run', { key: 'reset' });
  ok(!r.ok && r.error === 'unknown-key', 'settings.run is understood and refuses unknown keys', r);

  // ───────── 7. The shared look ─────────
  console.log('7. hub.theme');
  r = await tester.command('hub', 'theme.set', { accent: '#F08A4B', reducedMotion: true });
  await until(() => page.root.style.props['--arkada-hub-accent'] === '#F08A4B', 'accent applied');
  ok(page.root.attrs['data-arkada-motion'] === 'reduced', 'accent and reduced motion land on <html> of the main page', [page.root.style.props, page.root.attrs]);
  ok(page.popupRoot.style.props['--arkada-hub-accent'] === '#F08A4B', '…and of a window that was already open');
  const late = page.steam.openPopup();
  ok(late.style.props['--arkada-hub-accent'] === '#F08A4B' && late.attrs['data-arkada-motion'] === 'reduced', '…and of a window opened later');
  await tester.command('hub', 'theme.set', { accent: null, reducedMotion: false });
  await until(() => !('--arkada-hub-accent' in page.root.style.props), 'accent removed');
  ok(!('data-arkada-motion' in page.root.attrs) && !('--arkada-hub-accent' in late.style.props), 'accent: null gives the theme its own colour back');

  // ───────── 7b. The window backdrop: theme → plugin → backend ─────────
  console.log('7b. Window backdrop');
  const B = '--arkada-backdrop', MARK = 'data-arkada-backdrop';
  const lastCall = () => page.calls.backend[page.calls.backend.length - 1];
  ok(page.calls.backend.length > 0 && eq(page.calls.backend[0], ['arkada', 'ApplyBackdrop', { mode: 'mica' }]),
    'at start the theme says Mica (--arkada-backdrop in the main window) → the backend is asked for the windows already open', page.calls.backend[0]);
  ok(page.root.attrs[MARK] === 'mica' && page.popupRoot.attrs[MARK] === 'mica', 'the backend said ok → <html data-arkada-backdrop="mica"> in every window', [page.root.attrs, page.popupRoot.attrs]);
  ok(late.attrs[MARK] === 'mica', '…including a window opened later');
  ok(page.storage.getItem('arkada.backdrop') === 'mica', 'the mode is remembered for the next start (windows open before the theme answers)');
  let asked = page.calls.backend.length;
  page.calls.opened.length = 0;
  page.window.open('https://steamloopback.host/index.html?createflags=4114&minwidth=640', 'SP Desktop', 'width=800');
  page.window.open('https://steamloopback.host/chat.html?a=1&createflags=2#x');
  page.window.open('https://steamloopback.host/menu.html?createflags=999');
  page.window.open('https://steamloopback.host/plain.html');
  ok(eq(page.calls.opened, [
    'https://steamloopback.host/index.html?createflags=274&minwidth=640',
    'https://steamloopback.host/chat.html?a=1&createflags=274#x',
    'https://steamloopback.host/menu.html?createflags=999',
    'https://steamloopback.host/plain.html',
  ]), 'window.open: createflags 4114 and 2 become 274 (see-through), other kinds and plain addresses are left alone', page.calls.opened);
  await until(() => page.calls.backend.length > asked, 'backend asked after window.open');
  ok(lastCall()[1] === 'ApplyBackdrop' && lastCall()[2].mode === 'mica' && lastCall()[2].only === 'new' && typeof lastCall()[2].afterMs === 'number',
    'a window was opened → the backend is asked again, for the new window only', lastCall());
  asked = page.calls.backend.length;
  const fresh = page.steam.openPopup();
  ok(fresh.attrs[MARK] === 'mica', 'a new Steam window gets the mark as soon as it appears');
  await until(() => page.calls.backend.length > asked, 'backend asked for a new popup');
  ok(true, '…and the backend is asked for it');

  page.popupRoot.computed[B] = 'acrylic';
  await until(() => page.root.attrs[MARK] === 'acrylic' && fresh.attrs[MARK] === 'acrylic', 'switched to acrylic');
  ok(lastCall()[2].mode === 'acrylic', 'the setting changes to «Акрил» → backend asked for acrylic, the mark follows', lastCall());

  page.backend.ok = false;
  page.popupRoot.computed[B] = 'mica';
  await until(() => lastCall()[2].mode === 'mica', 'mica asked again');
  await sleep(100);
  ok(!(MARK in page.root.attrs) && !(MARK in page.popupRoot.attrs), 'the backend says it did not work → no mark, the theme stays opaque', page.popupRoot.attrs);
  page.backend.ok = true;

  page.popupRoot.computed[B] = 'off';
  await until(() => lastCall()[2].mode === 'off', 'off sent to the backend');
  ok(!(MARK in page.root.attrs) && !(MARK in page.popupRoot.attrs) && !(MARK in fresh.attrs), 'the setting changes to «Выкл» → the backend puts the windows back, no mark anywhere');
  page.calls.opened.length = 0;
  page.window.open('https://steamloopback.host/index.html?createflags=4114');
  ok(eq(page.calls.opened, ['https://steamloopback.host/index.html?createflags=4114']), 'with the backdrop off window.open is not rewritten', page.calls.opened);
  ok(page.storage.getItem('arkada.backdrop') === 'off', '«Выкл» is remembered too');
  page.popupRoot.computed[B] = 'mica';
  await until(() => page.popupRoot.attrs[MARK] === 'mica', 'back to mica');
  ok(page.log.length === 0 && problems.length === 0, 'nothing in the console and nothing thrown', [page.log, problems]);

  // ───────── 7c. The features that replace other plugins ─────────
  console.log('7c. Kapsula, size on disk, «Поделиться»');
  const share = page.window.PLUGIN_LIST.arkada.arkadaShare;
  ok(share && typeof share.friends === 'function' && typeof share.send === 'function', 'the plugin exports arkadaShare.friends / .send for the store pages (Millennium finds them among its exports)');
  const fl = JSON.parse(share.friends());
  ok(eq(fl.map(f => f.name), ['Liza', 'Timur', 'Offline']), 'arkadaShare.friends → the friends list as JSON, online first', fl);
  const sr = JSON.parse(await share.send(JSON.stringify({ ids: ['76561198000000001', 'nope'], text: 'Dota 2 в Steam:\nhttps://store.steampowered.com/app/570/' })));
  ok(eq(sr, [{ id: '76561198000000001', sent: true }]) && page.calls.chat.length === 1, "arkadaShare.send → the link goes to the chosen friend's chat; a bad id is dropped", [sr, page.calls.chat]);
  let refused = false;
  try { await share.send(JSON.stringify({ ids: [], text: 'x' })); } catch (e) { refused = true; }
  ok(refused, 'arkadaShare.send with nobody to send to is refused');
  // Kapsula switched on in the theme: the module starts and tries its port (nobody there: it waits quietly)
  page.popupRoot.computed['--arkada-kapsula'] = 'on';
  await sleep(2300);
  ok(JSON.parse(page.storage.getItem('arkada.features') || '{}').kapsula === 'on', 'the theme says Kapsula on → the feature is on, and remembered', page.storage.getItem('arkada.features'));
  page.popupRoot.computed['--arkada-kapsula'] = 'off';
  await until(() => JSON.parse(page.storage.getItem('arkada.features') || '{}').kapsula === 'off', 'kapsula off again', 5000);
  ok(page.log.length === 0 && problems.length === 0, 'Kapsula not running → nothing in the console, nothing thrown', [page.log, problems]);

  // The webkit script in a store page: its button asks the client part for the friends
  const webkitAt = path.join(path.dirname(bundle), 'webkit.js');
  if (!fs.existsSync(webkitAt)) { ok(false, 'no webkit.js next to the bundle: ' + webkitAt); return; }
  const webkitText = fs.readFileSync(webkitAt, 'utf8');
  const store = makeDomWindow('https://store.steampowered.com/app/570/Dota_2/');
  const sdoc = store.document;
  const srow = sdoc.createElement('div'); srow.id = 'queueActionsCtn';
  const sign = sdoc.createElement('div'); sign.id = 'ignoreBtn';
  srow.appendChild(sign); sdoc.body.appendChild(srow);
  const hub2 = sdoc.createElement('div'); hub2.id = 'appHubAppName'; hub2.textContent = 'Dota 2'; sdoc.body.appendChild(hub2);
  // Millennium's callable("arkada", "frontend:arkadaShare.friends") reaches the client's exports
  store.MILLENNIUM_API = { callable: (plugin, name) => (...a) => { const [obj, fn] = name.replace(/^frontend:/, '').split('.'); return page.window.PLUGIN_LIST[plugin][obj][fn](...a); } };
  store.Object = Object;
  vm.runInContext(webkitText, vm.createContext(store), { filename: 'webkit.js' });
  await until(() => sdoc.getElementById('arkada-share'), 'share button in the store page');
  ok(store.PLUGIN_LIST.arkada && typeof store.PLUGIN_LIST.arkada.default === 'function', "webkit.js registers in the page's PLUGIN_LIST under arkada");
  ok(sdoc.getElementById('arkada-share').parentNode === srow && sdoc.getElementById('arkada-share').textContent.endsWith('Поделиться'), 'the store page gets «Поделиться» in its row of buttons');
  sdoc.getElementById('arkada-share').querySelector('.btnv6_blue_hoverfade').click();
  sdoc.querySelector('.arkada-share-menu').querySelectorAll('.arkada-share-item')[1].click();
  await until(() => sdoc.querySelectorAll('.arkada-share-name').length === 3, 'friends in the dialog');
  ok(eq(sdoc.querySelectorAll('.arkada-share-name').map(n => n.textContent), ['Liza', 'Timur', 'Offline']), "Отправить другу → the friends come from the client through Millennium's bridge");
  sdoc.querySelectorAll('.arkada-share-friend')[1].click();
  sdoc.querySelector('.arkada-share-primary').click();
  await until(() => page.calls.chat.length === 2, 'sent from the store page');
  ok(page.calls.chat[1][2] === 'Dota 2 в Steam:\nhttps://store.steampowered.com/app/570/', "Отправить → Steam's chat gets the game's name and link", page.calls.chat[1]);
  ok(page.ipc.length === 1, 'the webkit script sends Millennium nothing of its own (only the client part reports itself loaded)', page.ipc.length);

  // ───────── 8. The hub restarts ─────────
  console.log('8. Hub restarts');
  await stopHub();
  await until(() => !seen.online, 'tester sees the hub gone');
  seen.states = {};
  page.steam.game(730, false);
  page.steam.game(570, true);
  await sleep(600);
  await startHub(port);
  await until(arkadaApp, 'arkada back in hub.apps', 20000);
  ok(true, 'the plugin reconnects by itself');
  await until(() => state('arkada.game') && state('arkada.settings') && state('arkada.friends'), 'states repeated', 5000);
  ok(state('arkada.game').appId === 570, 'and repeats its state as it is now, not as it was', state('arkada.game'));
  ok(value('shareInvites') === false, 'settings survive the reconnect', state('arkada.settings'));
  ok(page.log.length === 0 && problems.length === 0, 'still nothing in the console and nothing thrown', [page.log, problems]);

  // ───────── 9. Steam loads the plugin again, then unloads it ─────────
  console.log('9. Plugin loads twice, then unloads');
  const again = await page.window.PLUGIN_LIST.arkada.default();
  ok(page.calls.unregistered === 2, 'loaded a second time → the first copy stops itself (its Steam listeners are unregistered)', page.calls.unregistered);
  await sleep(400);
  await until(arkadaApp, 'second copy in hub.apps');
  await sleep(200);
  const count = seen.events.length;
  page.steam.toast({ strTest: 'Friend Message' }, { title: 'Liza', body: 'once', steamid: '76561198000000001' }, true);
  await until(() => seen.events.length > count, 'message event');
  await sleep(250);
  ok(seen.events.length === count + 1, 'one notification still makes exactly one event');
  ok(again && again.icon === null && typeof again.onDismount === 'function' && again.title === undefined, 'entry point returns { icon: null, onDismount }, as the Kapsula plugin does');
  again.onDismount();
  await until(() => !arkadaApp(), 'arkada left hub.apps');
  ok(true, 'onDismount closes the connection: arkada leaves hub.apps');
  await until(() => state('arkada.game') === null, 'state cleared by the hub');
  ok(true, 'the hub clears arkada.game for everyone');
  ok(!Object.prototype.hasOwnProperty.call(page.window.NotificationStore, 'BShowToast'), "Steam's notification check is put back as it was");
  ok(page.calls.unregistered === 4, 'game and download listeners are unregistered', page.calls.unregistered);
  ok(page.window.open === page.originalOpen, 'window.open is Steam\'s own again (the second load wrapped it once, not twice)');
  ok(!('data-arkada-backdrop' in page.popupRoot.attrs) && !('data-arkada-backdrop' in page.root.attrs), 'the backdrop mark is taken off: the theme is opaque again');
  tester.close();

  // ───────── 10. The logic alone, with made-up Steam calls ─────────
  console.log('10. Logic alone (plugin/src/core.js)');
  const counts = { online: 1, inGame: 0 };
  const stored = { [STORAGE_KEY]: JSON.stringify({ shareDownloads: false, junk: 1 }) };
  const said = [];
  const lone = createArkada({
    connect: () => ({ state: (t, d) => said.push([t, d]), event() {}, close() {} }),
    steam: { appName: () => '', watchGames: () => null, watchDownloads: cb => { cb({ appId: 10, progress: 2, bytesPerSecond: -5 }); return null; }, watchToasts: () => null, friendCounts: () => Object.assign({}, counts), launch: () => false, openLibrary: () => false, acceptInvite: () => false, applyTheme() {} },
    storage: { getItem: k => stored[k] || null, setItem() { throw new Error('closed'); } },
    friendsEveryMs: 30,
  });
  ok(eq(lone.settings(), { shareGames: true, shareDownloads: false, shareInvites: true, shareMessages: true }), 'saved settings are read back at start; unknown fields are dropped', lone.settings());
  ok(!said.some(([t, d]) => t === 'arkada.downloads' && d), 'with downloads hidden a download is not reported');
  counts.online = 3; counts.inGame = 2;
  await until(() => said.some(([t, d]) => t === 'arkada.friends' && d && d.online === 3 && d.inGame === 2), 'friends change');
  const n = said.filter(([t]) => t === 'arkada.friends').length;
  await sleep(150);
  ok(said.filter(([t]) => t === 'arkada.friends').length === n, 'friend counts are sent when they change, not on every look');
  lone.stop();

  // ───────── 11. The backdrop logic alone (plugin/src/backdrop.js) ─────────
  console.log('11. Backdrop logic alone (plugin/src/backdrop.js)');
  const { createBackdrop, withTransparentFlags, STORAGE_KEY: BACKDROP_KEY } = require(path.join(root, 'plugin', 'src', 'backdrop.js'));
  ok(withTransparentFlags('https://x/?createflags=4114') === 'https://x/?createflags=274' && withTransparentFlags('https://x/?createflags=41140') === 'https://x/?createflags=41140' &&
    withTransparentFlags('https://x/?nocreateflags=2') === 'https://x/?nocreateflags=2' && withTransparentFlags(undefined) === undefined,
    'only the createflags parameter, only 4114 and 2, nothing else in the address');
  function fakeSteam(theme) {
    const s = { theme, calls: [], marks: [], rewrite: null, unpatched: 0, readBackdrop: () => s.theme, markBackdrop: m => s.marks.push(m),
      watchWindows: () => () => {}, patchWindowOpen(rewrite) { s.rewrite = rewrite; return () => { s.unpatched++; }; },
      callBackend: (m, a) => { s.calls.push(a.mode); return Promise.resolve('{"ok":true}'); } };
    return s;
  }
  const mem = new Map();
  const memStore = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  let fs1 = fakeSteam('off');
  let bd = createBackdrop({ steam: fs1, storage: memStore, everyMs: 20 });
  await sleep(80);
  ok(fs1.calls.length === 0 && fs1.rewrite('https://x/?createflags=4114') === 'https://x/?createflags=4114', 'theme says «Выкл» from the start → the backend is never called, window.open passes addresses through', fs1.calls);
  bd.stop();
  ok(fs1.unpatched === 1 && fs1.marks[fs1.marks.length - 1] === null, 'stop() gives window.open back and takes the mark off');
  // Steam starts, the mode was Mica last time, but no window ever answers: the Arkada theme is not installed
  mem.set(BACKDROP_KEY, 'mica');
  fs1 = fakeSteam(null);
  bd = createBackdrop({ steam: fs1, storage: memStore, everyMs: 20, giveUpMs: 60 });
  ok(fs1.rewrite('https://x/?createflags=2') === 'https://x/?createflags=274', 'until the theme answers, the mode remembered from last time is used');
  await until(() => bd.mode() === 'off', 'gives up without a theme');
  await until(() => fs1.calls[fs1.calls.length - 1] === 'off', 'backend asked off');
  ok(eq(fs1.calls, ['mica', 'off']) && mem.get(BACKDROP_KEY) === 'off', 'no theme answers for a while → back to off, the backend puts the windows back, and it is remembered', [fs1.calls, mem.get(BACKDROP_KEY)]);
  bd.stop();
  // A new window: asked at 60 ms; again at 400 and 1500 ms only while nothing new got patched
  function openingSteam(patched) {
    const s = fakeSteam('mica');
    s.args = [];
    s.watchWindows = cb => { s.opened = cb; return () => {}; };
    s.watchShown = cb => { s.shown = cb; return () => {}; };
    s.callBackend = (m, a) => { s.args.push(a); return Promise.resolve(JSON.stringify({ ok: true, patched: a.only === 'new' ? patched : 0 })); };
    return s;
  }
  const newOnly = s => s.args.filter(a => a.only === 'new').length;
  let fs2 = openingSteam(1);
  bd = createBackdrop({ steam: fs2, storage: memStore, everyMs: 1000 });
  await sleep(20);
  fs2.opened({});
  await sleep(1700);
  ok(newOnly(fs2) === 1, 'the new window is patched at the first try → the backend is not asked again for it', fs2.args);
  fs2.shown({});
  await sleep(30);
  ok(newOnly(fs2) === 2, 'a window comes on screen (a menu shown) → one new-window pass', fs2.args);
  bd.stop();
  fs2 = openingSteam(0);
  bd = createBackdrop({ steam: fs2, storage: memStore, everyMs: 1000 });
  await sleep(20);
  fs2.opened({});
  await sleep(1700);
  ok(newOnly(fs2) === 3, 'not visible yet (nothing patched) → asked again at 400 and 1500 ms, and then no more', fs2.args);
  bd.stop();

  // Steam starting: a window whose setting file (options/backdrop-mica.css) is not in yet says "off" (tokens.css)
  const { createSteam: createSteamFor } = require(path.join(root, 'plugin', 'src', 'steam.js'));
  const winSays = v => ({ document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => v }) });
  const popupsNow = [{ m_strName: 'contextmenu_3_uid0', window: winSays('off') }, { m_strName: 'SP Desktop_uid0', window: winSays(' mica') }];
  const sj = createSteamFor({ document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }), g_PopupManager: { GetPopups: () => popupsNow } });
  ok(sj.readBackdrop() === 'mica', 'one window still loading says "off", the main window says mica → mica', sj.readBackdrop());
  popupsNow[1].window = winSays('off');
  ok(sj.readBackdrop() === 'off', '"off" only when every window that answers says off');
  popupsNow.push({ m_strName: 'Friends', window: winSays('acrylic') });
  popupsNow[1].window = winSays('mica');
  ok(sj.readBackdrop() === 'mica', 'windows disagree on mica / acrylic → the main window decides');

  // A single "off" read among mica ones is not believed; two in a row are
  const fs3 = fakeSteam('mica');
  bd = createBackdrop({ steam: fs3, storage: memStore, everyMs: 200 });
  await sleep(100);
  fs3.theme = 'off'; // read once, at 200 ms
  await sleep(200);
  fs3.theme = 'mica';
  await sleep(300);
  ok(bd.mode() === 'mica' && !fs3.calls.includes('off'), 'a moment of "off" (a window loading) does not turn the backdrop off', fs3.calls);
  fs3.theme = 'off';
  await until(() => bd.mode() === 'off', 'off confirmed');
  ok(fs3.calls[fs3.calls.length - 1] === 'off' && fs3.marks[fs3.marks.length - 1] === null, '"off" read twice in a row → off: the backend puts the windows back, the mark goes', [fs3.calls, fs3.marks]);
  bd.stop();

  // «Размытие» (blur) is a mode like the others; set() switches without a restart and holds until set(null)
  const fs5 = fakeSteam('acrylic');
  fs5.callBackend = (m, a) => { fs5.calls.push(a.mode); return Promise.resolve(JSON.stringify({ ok: true, mode: a.mode })); };
  bd = createBackdrop({ steam: fs5, storage: memStore, everyMs: 30 });
  await until(() => fs5.calls.includes('acrylic'), 'acrylic asked');
  bd.set('blur');
  await until(() => fs5.calls[fs5.calls.length - 1] === 'blur' && fs5.marks[fs5.marks.length - 1] === 'blur', 'blur set');
  await sleep(100);
  ok(bd.mode() === 'blur' && fs5.marks[fs5.marks.length - 1] === 'blur', 'set("blur") → the backend is asked for blur, the windows are marked blur, and the theme\'s acrylic does not take it back', [fs5.calls, fs5.marks]);
  bd.set(null);
  await until(() => bd.mode() === 'acrylic', 'back to the theme');
  ok(true, 'set(null) → back to the theme\'s setting');
  bd.stop();
  const popupsMenu = [{ m_strName: 'contextmenu_3_uid0', window: Object.assign(winSays('blur'), { document: { title: 'Games Root Menu', documentElement: makeAttrRoot() } }) },
    { m_strName: 'SP Desktop_uid0', window: Object.assign(winSays('blur'), { document: { title: 'Steam', documentElement: makeAttrRoot() } }) }];
  function makeAttrRoot() { const a = {}; return { attrs: a, style: { setProperty() {}, removeProperty() {} }, setAttribute(k, v) { a[k] = v; }, removeAttribute(k) { delete a[k]; } }; }
  const sm = createSteamFor({ document: { documentElement: makeAttrRoot() }, getComputedStyle: () => ({ getPropertyValue: () => '' }), g_PopupManager: { GetPopups: () => popupsMenu } });
  sm.markBackdrop('blur');
  ok(popupsMenu[1].window.document.documentElement.attrs['data-arkada-backdrop'] === 'blur' && !('data-arkada-backdrop' in popupsMenu[0].window.document.documentElement.attrs),
    'menus (title … Menu / … Supernav) are never marked: no backdrop under them, the theme draws them solid');

  // The backend did something else than asked (an old backend took the arguments for "off"): the mark follows
  // what it did, and the mode is asked for again
  const fs4 = fakeSteam('mica');
  let answers = 0;
  fs4.callBackend = (m, a) => { fs4.calls.push(a.mode); answers++; return Promise.resolve(JSON.stringify({ ok: true, mode: answers === 1 ? 'off' : a.mode })); };
  bd = createBackdrop({ steam: fs4, storage: memStore, everyMs: 1000 });
  await until(() => answers >= 2, 'asked again');
  await sleep(20);
  ok(fs4.marks[0] === null && fs4.marks[fs4.marks.length - 1] === 'mica', 'answer "off" to a mica request → no mark; asked again, mica done → the mark comes back', fs4.marks);
  bd.stop();
}

main().catch(e => { failed++; console.log('  FAIL  ' + (e && e.stack || e)); }).finally(async () => {
  await stopHub();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
