// Checks the plugin without Steam: the BUILT file (plugin/dist/arkada/.millennium/Dist/index.js) is run in a
// made-up Steam page (test/fake-steam.js) against the reference hub of kit.txt, started here on a free port.
//   node test/plugin.test.js [path to kit hub.js]      default: ../kit/hub/hub.js next to this folder
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
const hubJs = path.resolve(argv[0] || path.join(root, '..', 'kit', 'hub', 'hub.js'));
const { connect } = require(path.join(root, 'plugin', 'src', 'hub-client.js'));
const { createArkada, STORAGE_KEY } = require(path.join(root, 'plugin', 'src', 'core.js'));
const { makePage, browserLikeWebSocket } = require('./fake-steam.js');

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
  const page = makePage({ WebSocket: globalThis.WebSocket });

  // ───────── 1. Steam loads the plugin while the hub is not running ─────────
  console.log('1. Plugin loads without a hub');
  vm.runInContext(text.replace(marker, '$1' + port), page.context, { filename: 'index.js' });
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
}

main().catch(e => { failed++; console.log('  FAIL  ' + (e && e.stack || e)); }).finally(async () => {
  await stopHub();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
