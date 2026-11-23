// The plugin's features, each on its own, without Steam and without a hub:
//   watch.js     one DOM watcher, at most one pass per frame, nothing while stopped
//   features.js  the theme's switches turn the features on and off
//   kapsula.js   the messages Kapsula gets are the ones of its own plugin (a fake WebSocket stands for Kapsula)
//   pages.js + disksize.js   the size on disk on a game's page of the library (fake DOM, fake Steam)
//   share.js     «Поделиться» on a store page (fake DOM)
//   steam.js     the calls these features add (friends list, chat, flags, classes, sizes)
//   node test/modules.test.js
'use strict';
const path = require('path');
const src = f => require(path.join(__dirname, '..', 'plugin', 'src', f));
const { createWatch } = src('watch.js');
const { createFeatures, STORAGE_KEY: FEATURES_KEY } = src('features.js');
const { createKapsula } = src('kapsula.js');
const { createPages } = src('pages.js');
const { createDiskSize, formatSize, describe } = src('disksize.js');
const { createShare, gameOf, unwrap, friendsWord, messageFor } = src('share.js');
const { createSteam } = src('steam.js');
const TOKENS = src('tokens.js');
const { createStartPage, STORAGE_KEY: START_KEY } = src('startpage.js');
const { makeDomWindow, observing } = require('./fake-dom.js');
const { makePage } = require('./fake-steam.js');

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok    ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '\n        ' + JSON.stringify(detail) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const frame = () => sleep(5);
const memStorage = () => { const d = new Map(); return { getItem: k => (d.has(k) ? d.get(k) : null), setItem: (k, v) => d.set(k, String(v)), data: d }; };

async function testWatch() {
  console.log('watch.js');
  const win = makeDomWindow('https://store.steampowered.com/');
  let runs = 0;
  const w = createWatch(win, () => { runs++; });
  ok(observing() === 0, 'no MutationObserver before start()');
  w.start();
  await frame();
  ok(runs === 1 && observing() === 1, 'start(): one observer, one pass', { runs, observing: observing() });
  for (let i = 0; i < 50; i++) win.document.body.appendChild(win.document.createElement('div'));
  await frame();
  ok(runs === 2, '50 changes in one frame → one pass', runs);
  w.stop();
  win.document.body.appendChild(win.document.createElement('div'));
  await frame();
  ok(runs === 2 && observing() === 0, 'stop(): the observer is gone, no more passes', { runs, observing: observing() });
}

async function testFeatures() {
  console.log('features.js');
  const made = [], stopped = [];
  const flags = { kapsula: null, 'disk-size': null };
  const steam = { readFlags: names => Object.fromEntries(names.map(n => [n, flags[n]])) };
  const makers = { kapsula: () => { made.push('kapsula'); return { stop: () => stopped.push('kapsula') }; }, 'disk-size': () => { made.push('disk-size'); return { stop: () => stopped.push('disk-size') }; } };
  let t = 0;
  const storage = memStorage();
  let f = createFeatures({ steam, storage, features: makers, everyMs: 10, giveUpMs: 1000, now: () => t });
  await sleep(30);
  ok(made.length === 0, 'no answer from the theme yet, nothing saved → nothing starts before the give-up time');
  t = 2000;
  await sleep(30);
  ok(eq(made, ['kapsula', 'disk-size']), 'still no answer after the give-up time → the defaults: everything on', made);
  flags.kapsula = 'off'; flags['disk-size'] = 'on';
  await sleep(30);
  ok(eq(stopped, ['kapsula']) && !f.on('kapsula') && f.on('disk-size'), 'the theme says kapsula off → the Kapsula module is stopped, the other stays', stopped);
  ok(eq(JSON.parse(storage.getItem(FEATURES_KEY)), { kapsula: 'off', 'disk-size': 'on' }), 'the answer is remembered for the next start', storage.getItem(FEATURES_KEY));
  flags.kapsula = 'on';
  await sleep(30);
  ok(made.filter(n => n === 'kapsula').length === 2 && f.on('kapsula'), 'and on again → started again');
  f.stop();
  ok(stopped.length === 3 && !f.on('kapsula') && !f.on('disk-size'), 'stop() stops every running feature', stopped);
  // Next start, Steam in the tray (no main window, no answer): what was remembered, at once
  storage.setItem(FEATURES_KEY, JSON.stringify({ kapsula: 'off', 'disk-size': 'on' }));
  made.length = 0; flags.kapsula = null; flags['disk-size'] = null; t = 0;
  f = createFeatures({ steam, storage, features: makers, everyMs: 10, giveUpMs: 1000, now: () => t });
  ok(eq(made, ['disk-size']), 'next start: a feature remembered on starts at once, one remembered off does not', made);
  t = 5000;
  await sleep(30);
  ok(eq(made, ['disk-size']), 'no answer for long → a feature switched off stays off', made);
  f.stop();
}

// A WebSocket that is Kapsula: it records what the plugin sends and can send commands back
function kapsulaSockets() {
  const all = [];
  class Sock {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; all.push(this); setTimeout(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen && this.onopen(); }, 0); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
    command(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
  }
  return { Sock, all };
}

async function testKapsula() {
  console.log('kapsula.js');
  const page = makePage({ WebSocket: null });
  const steam = createSteam(page.window);
  const { Sock, all } = kapsulaSockets();
  const k = createKapsula({ steam, WebSocket: Sock, version: '0.1.0', everyMs: 20 });
  await sleep(10);
  const sock = all[0];
  ok(all.length === 1 && sock.url === 'ws://127.0.0.1:42071/?client=millennium', 'connects to Kapsula where its own plugin does: ws://127.0.0.1:42071/?client=millennium', sock && sock.url);
  ok(eq(sock.sent[0], { type: 'hello', plugin: '0.1.0', hooked: true }), 'hello first: { type: "hello", plugin, hooked }', sock.sent[0]);

  const toast = (config, fields, show) => page.steam.toast(config, fields, show);
  toast({ strTest: 'Friend Message' }, { title: 'Liza', body: 'Go?', icon: 'https://avatars.steamstatic.com/l.jpg', steamid: '76561198000000001', response_steamurl: 'steam://friends/message/76561198000000001' }, true);
  toast({ strTest: 'Friend Message' }, { body: 'Play with me', steamid: '76561198000000002', response_steamurl: 'steam://joinlobby/730/1/76561198000000002' }, true);
  toast({ strTest: 'Achievement' }, { title: 'First Blood', appid: 570 }, true);
  toast({ strTest: 'Friend Message' }, { title: 'Hidden' }, false);
  const toasts = sock.sent.filter(m => m.type === 'toast');
  ok(toasts.length === 3, 'every pop-up Steam shows → one "toast"; one it does not show → nothing', toasts.length);
  ok(eq(toasts[0], { type: 'toast', kind: 'Friend Message', eType: 1, title: 'Liza', body: 'Go?', icon: 'https://avatars.steamstatic.com/l.jpg', steamid: '76561198000000001', url: 'steam://friends/message/76561198000000001', game: '', appid: '', invite: false, extra: '' }),
    'the toast has the fields of the Kapsula plugin', toasts[0]);
  ok(toasts[1].invite === true && toasts[1].title === 'Timur' && toasts[1].game === 'Counter-Strike 2' && toasts[1].icon === 'https://avatars.steamstatic.com/t.jpg', 'an invite: invite true, who and which game from the friends list', toasts[1]);
  ok(toasts[2].kind === 'Achievement' && toasts[2].game === 'Dota 2' && toasts[2].appid === '570', 'an achievement: the game named from its number', toasts[2]);

  page.steam.download({ update_appid: 1245620, update_state: 'Downloading', paused: false, overall_percent_complete: 42, update_network_bytes_per_second: 5242880, overall_estimated_time_remaining_sec: 300 });
  page.steam.download({ update_appid: 0, update_state: 'None' });
  const dl = sock.sent.filter(m => m.type === 'download');
  ok(eq(dl, [{ type: 'download', appid: 1245620, name: 'ELDEN RING', state: 'Downloading', paused: false, percent: 42, rate: 5242880, eta: 300 }, { type: 'download', appid: 0 }]),
    'downloads: { type: "download", appid, name, state, paused, percent, rate, eta }, and appid 0 when nothing downloads', dl);

  ok(toast({ strTest: 'Friend Message' }, { title: 'A' }, true) === true, 'hideToasts not asked for → Steam shows its own pop-up');
  sock.command({ cmd: 'config', hideToasts: true });
  ok(toast({ strTest: 'Friend Message' }, { title: 'B' }, true) === false, 'config { hideToasts: true } → the island shows it, Steam\'s own pop-up is skipped');
  page.calls.inGame = true;
  ok(toast({ strTest: 'Friend Message' }, { title: 'C' }, true) === true, '… but never while a game runs');
  page.calls.inGame = false;
  sock.command({ cmd: 'config', hideToasts: false });

  sock.command({ cmd: 'reply', steamid: '76561198000000001', text: 'Иду!' });
  await sleep(10);
  ok(page.calls.chat.length === 1 && page.calls.chat[0][2] === 'Иду!' && eq(sock.sent[sock.sent.length - 1], { type: 'replied', ok: true, message: '' }), 'reply → sent in Steam\'s chat, { type: "replied", ok: true }', [page.calls.chat, sock.sent[sock.sent.length - 1]]);
  sock.command({ cmd: 'reply', steamid: 'x', text: 'no' });
  await sleep(10);
  ok(sock.sent[sock.sent.length - 1].type === 'replied' && sock.sent[sock.sent.length - 1].ok === false, 'reply to a bad SteamID → ok: false');
  sock.command({ cmd: 'openChat', steamid: '76561198000000002' });
  ok(eq(page.calls.chatOpened, ['76561198000000002']), 'openChat → Steam opens the chat with that friend', page.calls.chatOpened);
  const inv = page.window.g_FriendsUIApp.ChatStore.GameInviteStore.m_mapGameInvites.values().next().value.get(100);
  sock.command({ cmd: 'dismissInvite', steamid: '76561198000000002' });
  ok(inv.bDismissed === true, 'dismissInvite → the invite is dismissed in Steam\'s chat');
  sock.command({ cmd: 'test', names: ['TestFriendMessage', 'rm -rf'] });
  await sleep(450);
  ok(eq(page.calls.tests, ['TestFriendMessage']), 'test → Steam\'s own sample notification, nothing else', page.calls.tests);
  toast({ strTest: 'Friend Message' }, { title: 'Hidden one' }, false);
  ok(sock.sent[sock.sent.length - 1].type === 'suppressed', 'check mode: a notification Steam does not show comes as "suppressed"', sock.sent[sock.sent.length - 1]);

  // Kapsula goes away and comes back
  sock.close();
  await sleep(60);
  ok(all.length >= 2 && all[all.length - 1].sent[0].type === 'hello', 'Kapsula closed → tried again, hello again');

  // The Kapsula plugin itself is loaded in Steam: Arkada leaves the island to it
  page.window.PLUGIN_LIST = { kapsula: { default() { } } };
  const before = all.length;
  toast({ strTest: 'Friend Message' }, { title: 'Twice?' }, true);
  ok(all.slice(0, before).every(s => s.readyState === 3), 'the Kapsula plugin runs → our connection is closed, the notification is not sent twice');
  await sleep(80);
  ok(all.length === before, '… and no new connection while it runs');
  page.window.PLUGIN_LIST = {};
  await sleep(60);
  ok(all.length > before, 'it is switched off → Arkada connects again');

  k.stop();
  ok(all.every(s => s.readyState === 3), 'stop() closes the connection');
  ok(!Object.prototype.hasOwnProperty.call(page.window.NotificationStore, 'BShowToast'), 'stop() takes the hook off Steam\'s notifications (nobody else listens)');
  steam.dispose();
}

// The main window of a fake Steam with a game page in the fake DOM
function libraryPage() {
  const page = makePage({ WebSocket: null });
  const main = makeDomWindow('https://steamloopback.host/routes/library/home');
  page.window.g_PopupManager.GetPopups().splice(0, 1, { m_strName: 'SP Desktop_uid0', window: main });
  const steam = createSteam(page.window);
  return { page, main, steam };
}
function drawGamePage(main, cls) {
  const doc = main.document;
  while (doc.body.firstChild) doc.body.removeChild(doc.body.firstChild);
  const panel = doc.createElement('div'); panel.className = 'MainPanel';
  const section = doc.createElement('div'); section.className = cls.GameStatsSection;
  const last = doc.createElement('div'); last.className = cls.GameStat; last.textContent = 'Последний запуск';
  section.appendChild(last);
  panel.appendChild(section);
  doc.body.appendChild(panel);
  return section;
}

async function testDiskSize() {
  console.log('pages.js + disksize.js');
  ok(formatSize(44040192000) === '41 ГБ' && formatSize(1288490189) === '1,2 ГБ' && formatSize(512) === '512 Б' && formatSize(0) === '0 Б' && formatSize(1024 * 1024 * 1024 * 1024 * 3.5) === '3,5 ТБ',
    'sizes in Steam\'s units: 41 ГБ, 1,2 ГБ, 512 Б, 3,5 ТБ', [formatSize(44040192000), formatSize(1288490189), formatSize(512)]);
  const { page, main, steam } = libraryPage();
  const cls = steam.classes('GameStatsSection');
  ok(cls && cls.GameStatsSection === '_1mDAVT4sTzFRwJtlKCw2Ws', 'Steam\'s classes of the stats row: from Millennium, else the snapshot of this client (steam-snapshot.js)', cls);
  const pages = createPages({ steam });
  const d = createDiskSize({ steam, pages });
  await sleep(20);
  ok(!pages.watching() && observing() === 0, 'library home: no DOM watcher at all');
  const section = drawGamePage(main, cls);
  page.steam.route('/library/app/570');
  await sleep(30);
  const stat = () => section.querySelector('[data-arkada-disk-size]');
  ok(pages.watching() && observing() === 1, 'a game\'s page: one DOM watcher on the main window');
  ok(stat() && stat().textContent === 'Размер на диске41 ГБ', 'the stat is in the row: «Размер на диске», 41 ГБ', stat() && stat().textContent);
  ok(stat() && stat().className === cls.GameStat + ' ' + cls.LastPlayed + ' Panel' && stat().getAttribute('data-arkada-disk-size') === '570:44040192000', 'drawn with Steam\'s own classes of the row', stat() && stat().className);
  ok(stat() && stat().title.split('\n')[0] === 'Занято на диске: 41 ГБ — Игры (D:)' && stat().title.includes('Мастерская: 1 ГБ') && stat().title.includes('Кэш шейдеров: 512 МБ') && stat().title.includes('Игра: 39,5 ГБ'),
    'the tooltip: where, the game, Workshop, shaders', stat() && stat().title);
  stat().click();
  ok(eq(page.calls.properties, [[570, 'localfiles']]), 'a click opens the game\'s Properties on «Установленные файлы»', page.calls.properties);
  const asked = page.calls.folders;
  for (let i = 0; i < 20; i++) main.document.body.appendChild(main.document.createElement('div')); // Steam keeps drawing
  await sleep(20);
  ok(section.querySelectorAll('[data-arkada-disk-size]').length === 1 && page.calls.folders === asked, 'the page keeps changing → still one stat, Steam is not asked again', page.calls.folders);
  const again = drawGamePage(main, cls); // Steam draws the row anew
  await sleep(20);
  ok(again.querySelector('[data-arkada-disk-size]'), 'Steam draws the row anew → the stat is put in again');
  page.steam.route('/library/app/1245620'); // not installed
  await sleep(20);
  ok(!main.document.querySelector('[data-arkada-disk-size]'), 'a game that is not installed → no stat');
  page.steam.route('/library/home');
  await sleep(20);
  ok(!pages.watching() && observing() === 0, 'leaving the game pages → the DOM watcher is gone');
  page.steam.route('/library/app/570');
  await sleep(20);
  ok(main.document.querySelector('[data-arkada-disk-size]'), 'back on the game → the stat again');
  d.stop();
  ok(!main.document.querySelector('[data-arkada-disk-size]') && observing() === 0, 'switched off → the stat is taken away, no watcher');
  pages.stop();
  steam.dispose();
}

function storePage(href) {
  const win = makeDomWindow(href || 'https://store.steampowered.com/app/570/Dota_2/?snr=1_5_9__205');
  const doc = win.document;
  doc.title = 'Dota 2 в Steam';
  const name = doc.createElement('div'); name.id = 'appHubAppName'; name.textContent = 'Dota 2';
  const row = doc.createElement('div'); row.id = 'queueActionsCtn'; row.className = 'queue_actions_ctn';
  const wish = doc.createElement('div'); wish.id = 'add_to_wishlist_area';
  const follow = doc.createElement('div'); follow.className = 'queue_control_button queue_btn_follow';
  const ignore = doc.createElement('div'); ignore.id = 'ignoreBtn'; ignore.className = 'queue_control_button queue_btn_ignore';
  const right = doc.createElement('div'); right.className = 'queue_control_button right';
  for (const n of [wish, follow, ignore, right]) row.appendChild(n);
  doc.body.appendChild(name);
  doc.body.appendChild(row);
  return { win, doc, row, ignore };
}

async function testShare() {
  console.log('share.js');
  const g = gameOf({ hostname: 'store.steampowered.com', pathname: '/app/570/Dota_2/' }, storePage().doc);
  ok(eq(g, { appId: '570', title: 'Dota 2', url: 'https://store.steampowered.com/app/570/' }), 'the game of the page, with a clean link', g);
  ok(gameOf({ hostname: 'store.steampowered.com', pathname: '/search/' }, storePage().doc) === null && gameOf({ hostname: 'steamcommunity.com', pathname: '/app/570' }, storePage().doc) === null, 'not a game\'s page of the store → nothing');
  ok(eq(unwrap('[1]'), [1]) && eq(unwrap(JSON.stringify({ type: 'string', value: '[2]' })), [2]) && eq(unwrap({ type: 'string', value: '{"a":1}' }), { a: 1 }), 'replies of Millennium are read either way: a JSON string or { type: "string", value }');
  ok(friendsWord(1) === 'другу' && friendsWord(2) === 'друзьям' && friendsWord(11) === 'друзьям' && friendsWord(21) === 'другу', 'Отправлено 1 другу, 2 друзьям, 11 друзьям, 21 другу');
  ok(messageFor(g) === 'Dota 2 в Steam:\nhttps://store.steampowered.com/app/570/', 'the message: the game\'s name and its link', messageFor(g));

  const { win, doc, row, ignore } = storePage();
  const calls = [];
  const friends = [{ id: '76561198000000001', name: 'Liza', status: 'В сети', avatar: 'https://avatars.steamstatic.com/l.jpg', online: true }, { id: '76561198000000003', name: 'Offline', status: 'Не в сети', avatar: '', online: false }];
  const call = (m, arg) => { calls.push([m, arg]); return Promise.resolve(m === 'friends' ? JSON.stringify(friends) : JSON.stringify(JSON.parse(arg).ids.map(id => ({ id, sent: true })))); };
  const s = createShare({ win, call, tokens: TOKENS });
  await sleep(20);
  const btn = () => doc.getElementById('arkada-share');
  ok(btn() && btn().parentNode === row && row.childNodes.indexOf(btn()) === row.childNodes.indexOf(ignore) + 1, 'the button is in Steam\'s row, right after «Скрыть»');
  ok(btn() && btn().classList.contains('queue_control_button') && btn().querySelector('.btnv6_blue_hoverfade') && btn().textContent.endsWith('Поделиться'), 'Steam\'s own kind of button, «Поделиться», so the theme draws it as the others', btn() && btn().textContent);
  ok(doc.querySelectorAll('#arkada-share-style').length === 1 && doc.getElementById('arkada-share-style').textContent.includes('--dt-raised: #2C2C2C') && doc.getElementById('arkada-share-style').textContent.includes('prefers-reduced-motion'), 'one style sheet, on the dev.txt tokens (and their reduced motion)');
  const inner = btn().querySelector('.btnv6_blue_hoverfade');
  inner.click();
  const menu = () => doc.querySelector('.arkada-share-menu');
  ok(menu() && eq(menu().querySelectorAll('.arkada-share-item').map(i => i.textContent.slice(1)), ['Копировать ссылку', 'Отправить другу в Steam…']) && inner.getAttribute('aria-expanded') === 'true', 'a click opens the menu: copy the link, send to a friend', menu() && menu().textContent);
  ok(menu() && menu().style.left === '100px' && menu().style.top === '244px', 'the menu opens under the button', menu() && menu().style);
  win.fire('scroll');
  ok(!menu() && inner.getAttribute('aria-expanded') === 'false', 'a scroll closes it (nothing is measured while scrolling)');
  inner.click();
  menu().querySelectorAll('.arkada-share-item')[0].click();
  await sleep(20);
  ok(eq(win.clipboard, ['https://store.steampowered.com/app/570/']) && !menu(), 'Копировать ссылку → the clean link is on the clipboard, the menu is closed', win.clipboard);
  ok(doc.querySelector('.arkada-share-toast') && doc.querySelector('.arkada-share-toast').textContent === 'Ссылка скопирована', '… and «Ссылка скопирована» by the button');
  inner.click();
  doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
  ok(!menu(), 'Escape closes the menu');

  inner.click();
  menu().querySelectorAll('.arkada-share-item')[1].click();
  await sleep(20);
  const dialog = () => doc.querySelector('.arkada-share-dialog');
  ok(dialog() && dialog().querySelector('.arkada-share-title').textContent === 'Отправить другу' && eq(dialog().querySelectorAll('.arkada-share-name').map(n => n.textContent), ['Liza', 'Offline']), 'Отправить другу → the dialog with the friends list from the client', dialog() && dialog().textContent);
  const send = dialog().querySelector('.arkada-share-primary');
  ok(send.disabled === true, 'nobody chosen → «Отправить» is off');
  dialog().querySelectorAll('.arkada-share-friend')[0].click();
  ok(send.disabled === false && dialog().querySelector('.arkada-share-count').textContent === 'Выбрано: 1' && dialog().querySelectorAll('.arkada-share-friend')[0].getAttribute('aria-pressed') === 'true', 'a friend chosen → «Выбрано: 1», «Отправить» on');
  const input = dialog().querySelector('.arkada-share-input');
  input.value = 'off'; input.dispatchEvent({ type: 'input' });
  ok(eq(dialog().querySelectorAll('.arkada-share-name').map(n => n.textContent), ['Offline']), 'the search finds friends by name');
  input.value = ''; input.dispatchEvent({ type: 'input' });
  send.click();
  await sleep(20);
  const sent = calls.find(c => c[0] === 'send');
  ok(sent && eq(JSON.parse(sent[1]), { ids: ['76561198000000001'], text: 'Dota 2 в Steam:\nhttps://store.steampowered.com/app/570/' }), '«Отправить» → the client sends the link to the chosen friend', sent);
  ok(!dialog() && doc.querySelector('.arkada-share-toast').textContent === 'Отправлено 1 другу', 'done → the dialog closes, «Отправлено 1 другу»', doc.querySelector('.arkada-share-toast').textContent);

  btn().remove(); // the page draws the row anew
  await sleep(20);
  ok(btn() && btn().parentNode === row, 'the page takes the button away → it is put in again');
  s.stop();
  ok(!btn() && !doc.getElementById('arkada-share-style') && observing() === 0, 'stop() takes the button, the style and the watcher away');

  // The theme's setting is off: the button is not put in
  const off = storePage();
  off.win.computed['--arkada-share'] = ' off';
  const s2 = createShare({ win: off.win, call, tokens: TOKENS });
  await sleep(20);
  ok(!off.doc.getElementById('arkada-share'), '«Кнопка «Поделиться»» → Выкл: no button');
  s2.stop();
  // Another store page: nothing at all
  const other = storePage('https://store.steampowered.com/search/?term=dota');
  const s3 = createShare({ win: other.win, call, tokens: TOKENS });
  await sleep(20);
  ok(!other.doc.getElementById('arkada-share'), 'a page that is not a game\'s → no button');
  s3.stop();
  // The client cannot list the friends: the dialog says so
  const bad = storePage();
  const s4 = createShare({ win: bad.win, call: () => Promise.reject(new Error('no bridge')), tokens: TOKENS });
  await sleep(20);
  bad.doc.getElementById('arkada-share').querySelector('.btnv6_blue_hoverfade').click();
  bad.doc.querySelector('.arkada-share-menu').querySelectorAll('.arkada-share-item')[1].click();
  await sleep(20);
  ok(bad.doc.querySelector('.arkada-share-empty').textContent.startsWith('Список друзей Steam сейчас недоступен'), 'no answer from the client → the dialog says the list is not available', bad.doc.querySelector('.arkada-share-empty').textContent);
  s4.stop();
}

async function testSteamCalls() {
  console.log('steam.js (the calls of these features)');
  const page = makePage({ WebSocket: null });
  const steam = createSteam(page.window);
  const list = steam.friendsList();
  ok(eq(list.map(f => [f.id, f.name, f.status, f.online]), [['76561198000000001', 'Liza', 'В сети', true], ['76561198000000002', 'Timur', 'Играет в Counter-Strike 2', true], ['76561198000000003', 'Offline', 'Не в сети', false]]),
    'friendsList: online first, by name, with a status in Russian', list);
  await steam.sendChat('76561198000000002', 'Привет');
  ok(eq(page.calls.chat[0], [Number(BigInt('76561198000000002') & 0xFFFFFFFFn), true, 'Привет']), 'sendChat: the friend\'s chat in Steam (made if needed), the text as it is', page.calls.chat);
  let threw = false;
  try { await steam.sendChat('76561198000000002', ''); } catch (e) { threw = true; }
  ok(threw, 'sendChat with no text is refused');
  page.popupRoot.computed['--arkada-kapsula'] = 'off';
  page.popupRoot.computed['--arkada-disk-size'] = ' on';
  ok(eq(steam.readFlags(['kapsula', 'disk-size', 'share']), { kapsula: 'off', 'disk-size': 'on', share: null }), 'readFlags: what the main window\'s theme says, null where it says nothing');
  const sizes = await steam.installedSizes();
  ok(sizes.get(570) && sizes.get(570).total === 44040192000 && sizes.get(570).drive === 'D:', 'installedSizes: the sizes Steam reports for its library folders, as numbers', sizes.get(570));
  steam.dispose();
}

// ───────── startpage.js ─────────
async function testStartPage() {
  console.log('startpage.js');
  const make = (route, flag, saved) => {
    const mem = new Map(saved ? [[START_KEY, saved]] : []);
    const s = { route, flag, moved: [], readFlags: () => ({ 'start-library': s.flag }), currentRoute: () => s.route, navigate: p => { s.moved.push(p); s.route = p; return true; } };
    return { s, storage: { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) }, mem };
  };
  let a = make(null, null, null), once = {};
  createStartPage({ steam: a.s, storage: a.storage, once, everyMs: 10, limitMs: 500 });
  await sleep(40);
  a.s.route = '/browser/store'; a.s.flag = 'on';
  await sleep(40);
  ok(eq(a.s.moved, ['/library/home']) && a.mem.get(START_KEY) === 'on', 'the main window comes up on the store, the theme says Библиотека → one move to the library Home, the answer is remembered', a.s.moved);
  const again = createStartPage({ steam: a.s, storage: a.storage, once, everyMs: 10 });
  a.s.route = '/browser/store';
  await sleep(40);
  ok(a.s.moved.length === 1 && again.state() === 'done before', 'once per Steam start: a second load of the plugin does not move the page');
  a = make('/browser/store', null, 'on');
  createStartPage({ steam: a.s, storage: a.storage, once: {}, everyMs: 10 });
  ok(eq(a.s.moved, ['/library/home']), 'the theme has not answered yet: the answer remembered from the last start is used at once (no store showing meanwhile)');
  a = make('/library/app/570', 'on', null);
  createStartPage({ steam: a.s, storage: a.storage, once: {}, everyMs: 10 });
  ok(a.s.moved.length === 0, 'the first page is already the library → nothing is done');
  a = make('/browser/store', 'off', 'on');
  createStartPage({ steam: a.s, storage: a.storage, once: {}, everyMs: 10 });
  ok(a.s.moved.length === 0 && a.mem.get(START_KEY) === 'off', '«Как в Steam» → nothing is done, and that is remembered');
  a = make('/browser/store', null, null);
  const g = createStartPage({ steam: a.s, storage: a.storage, once: {}, everyMs: 10, limitMs: 60 });
  await sleep(120);
  a.s.flag = 'on';
  await sleep(40);
  ok(a.s.moved.length === 0 && g.state() === 'gave up', 'no theme answer for a while → gives up, and later never moves the page under the user');
}

(async () => {
  for (const t of [testWatch, testFeatures, testKapsula, testDiskSize, testShare, testSteamCalls, testStartPage]) {
    try { await t(); } catch (e) { failed++; console.log('  FAIL  ' + t.name + ': ' + (e && e.stack || e)); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
