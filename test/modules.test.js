// The plugin's features, each on its own, without Steam and without a hub:
//   watch.js     one DOM watcher, at most one pass per frame, nothing while stopped
//   features.js  the theme's switches turn the features on and off
//   kapsula.js   the messages Kapsula gets are the ones of its own plugin (a fake WebSocket stands for Kapsula)
//   pages.js + disksize.js   the size on disk on a game's page of the library (fake DOM, fake Steam)
//   hltb.js      How Long To Beat on a game's page: the backend switched on and asked once per game (fake backend)
//   share.js     «Поделиться» on a store page (fake DOM)
//   dota.js      Dota 2 statistics on a community profile (fake OpenDota)
//   web.js       money as Steam writes it, the rate-keeping queue, the cache, the feature switch of a page
//   prices.js    «Цены» on a game's store page: SteamDB, IsThereAnyDeal through a fake backend, the key field
//   gameinfo.js  «Об игре»: the library's hours and date from a fake client, the links
//   hideowned.js owned and ignored games hidden in the store's lists (one style rule)
//   wishlist.js  the sum of a wishlist (fake Steam Web API)
//   inventory.js the market prices of an inventory (fake priceoverview, 429)
//   markethistory.js  the totals of the market history (fake myhistory/render)
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
const { createHltb, formatHours, timesOf, describe: describeHltb } = src('hltb.js');
const { createDota, accountOf, rankName, matches } = src('dota.js');
const { createShare, gameOf, unwrap, friendsWord, messageFor } = src('share.js');
const web = src('web.js');
const { createPrices, money } = src('prices.js');
const { createGameInfo, hours } = src('gameinfo.js');
const { createHideOwned } = src('hideowned.js');
const { createWishlist, summarize, ownerOf } = src('wishlist.js');
const { createInventory, itemsOf } = src('inventory.js');
const { createMarketHistory, rowsOf, totals } = src('markethistory.js');
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
  ok(steam.openInBrowser('https://howlongtobeat.com/game/1') && !steam.openInBrowser('javascript:alert(1)') && eq(page.calls.browser, ['https://howlongtobeat.com/game/1']), 'openInBrowser: https links only, in the system browser', page.calls.browser);
  ok(steam.currentUserId() === '76561198000000009', 'currentUserId: the SteamID64 of the user signed in');
  const answer = page.window.Millennium.callServerMethod;
  page.window.Millennium.callServerMethod = () => new Promise(() => { });
  const raced = await Promise.race([steam.callBackend('GetHltbData', {}, 30), sleep(200).then(() => 'late')]);
  page.window.Millennium.callServerMethod = answer;
  ok(raced === null, 'callBackend: a backend that does not answer gives null after as long as it is told (here 30 ms)', raced);
  steam.dispose();
}

// ───────── hltb.js ─────────
async function testHltb() {
  console.log('pages.js + hltb.js');
  ok(formatHours(6) === '6 ч' && formatHours(6.7) === '6,7 ч' && formatHours(123.4) === '123 ч' && formatHours(0) === '' && formatHours(null) === '',
    'hours in Russian: 6 ч, 6,7 ч, 123 ч; none → nothing', [formatHours(6), formatHours(6.7), formatHours(123.4)]);
  const reply = { success: true, data: { game_id: 2224, game_name: 'Dark Souls', comp_main: 42.5, comp_plus: 60, comp_100: 105 }, fromCache: false, isStale: false };
  const t = timesOf(JSON.stringify(JSON.stringify(reply)));
  ok(t && t.gameId === 2224 && eq(t.stages.map(s => s.hours), [42.5, 60, 105]), 'the reply of GetHltbData is read, even wrapped twice in JSON', t);
  ok(timesOf(JSON.stringify({ success: false, error: 'off' })) === null && timesOf(JSON.stringify({ success: true, data: { searched_name: 'X' } })) === null && timesOf('{bad') === null,
    'the backend is off, HLTB does not know the game, a broken reply → nothing to show');
  ok(describeHltb(t).split('\n')[0] === 'Основной сюжет: 42,5 ч' && describeHltb(t).includes('Всё на 100%: 105 ч') && describeHltb(t).includes('howlongtobeat.com'), 'the tooltip names the stages and says where the times come from', describeHltb(t));

  const { page, main, steam } = libraryPage();
  const asked = [];
  const answers = { 570: reply, 730: { success: true, data: { searched_name: 'Counter-Strike 2' }, fromCache: false } };
  const s = Object.assign({}, steam, {
    callBackend: (m, a, wait) => { asked.push([m, a, wait]); return Promise.resolve(m === 'GetHltbData' ? JSON.stringify(answers[a.app_id] || { success: false }) : JSON.stringify({ success: true, on: a.on })); },
    openInBrowser: url => { page.calls.browser.push(url); return true; },
  });
  const pages = createPages({ steam });
  const cls = steam.classes('GameStatsSection');
  const h = createHltb({ steam: s, pages });
  await sleep(10);
  ok(asked[0] && eq(asked[0].slice(0, 2), ['HltbSetup', { on: true, steam_user_id: '76561198000000009' }]) && asked[0][2] >= 60000, 'on start the backend is switched on, with the signed-in user for HLTB\'s import of the library', asked[0]);
  ok(!asked.some(c => c[0] === 'GetHltbData') && !pages.watching(), 'library home: HLTB is not asked, no DOM watcher');
  const section = drawGamePage(main, cls);
  page.steam.route('/library/app/570');
  await sleep(30);
  const stat = () => section.querySelector('[data-arkada-hltb]');
  const gets = () => asked.filter(c => c[0] === 'GetHltbData');
  ok(eq(gets().map(c => c[1]), [{ app_id: 570, fallback_name: 'Dota 2', force_refresh: false }]), 'a game\'s page: the backend is asked once for this game, with its name in the library', gets());
  ok(stat() && stat().textContent === 'Время прохождения42,5 ч · 60 ч · 105 ч' && stat().className.startsWith(cls.GameStat), 'without Steam Enhanced: one more stat in Steam\'s row, «Время прохождения» 42,5 ч · 60 ч · 105 ч', stat() && stat().textContent);
  if (stat()) stat().click();
  ok(eq(page.calls.browser, ['https://howlongtobeat.com/game/2224']), 'a click opens the game\'s page on howlongtobeat.com in the browser', page.calls.browser);
  for (let i = 0; i < 20; i++) main.document.body.appendChild(main.document.createElement('div'));
  await sleep(20);
  ok(gets().length === 1 && section.querySelectorAll('[data-arkada-hltb]').length === 1, 'the page keeps changing → still one stat, the backend is not asked again');
  page.steam.route('/library/app/730');
  await sleep(20);
  ok(!main.document.querySelector('[data-arkada-hltb]') && gets().length === 2, 'a game HLTB does not know → no stat');
  page.steam.route('/library/app/570');
  await sleep(20);
  ok(main.document.querySelector('[data-arkada-hltb]') && gets().length === 2, 'back on the first game → its stat again, from memory');
  main.__seHltb = { createCard() { } };
  main.document.body.appendChild(main.document.createElement('div'));
  await sleep(20);
  ok(!main.document.querySelector('[data-arkada-hltb]'), 'Steam Enhanced is in the window → its own card shows the times, ours goes');
  h.stop();
  await sleep(10);
  ok(eq(asked[asked.length - 1].slice(0, 2), ['HltbSetup', { on: false, steam_user_id: '' }]) && observing() === 0, 'switched off → the backend is switched off too (no more requests), no watcher', asked[asked.length - 1]);
  pages.stop();
  steam.dispose();
}

// ───────── dota.js ─────────
function profilePage(href, steamid) {
  const win = makeDomWindow(href || 'https://steamcommunity.com/id/someone/');
  if (steamid !== null) win.g_rgProfileData = { steamid: steamid || '76561198047011640', personaname: 'someone' };
  const col = win.document.createElement('div'); col.className = 'profile_rightcol';
  const other = win.document.createElement('div'); other.className = 'profile_badges';
  col.appendChild(other);
  return { win, col, other };
}
function opendota(over) {
  const asked = [];
  const data = Object.assign({
    'players/86745912': { profile: { account_id: 86745912, personaname: 'ceo mindset', plus: true }, rank_tier: 63, leaderboard_rank: null },
    'players/86745912/wl': { win: 1952, lose: 1193 },
    'players/86745912/wl?date=365': { win: 29, lose: 16 },
    'players/86745912/heroes': [{ hero_id: 109, games: 122, win: 73 }, { hero_id: 11, games: 167, win: 115 }, { hero_id: 1, games: 3, win: 0 }, { hero_id: 2, games: 50, win: 20 }],
    'players/86745912/peers': [{ account_id: 1, personaname: 'Cr1t-', with_games: 1375, with_win: 853, avatar: 'https://avatars.steamstatic.com/a.jpg' }],
    heroes: [{ id: 11, name: 'npc_dota_hero_nevermore', localized_name: 'Shadow Fiend' }, { id: 109, name: 'npc_dota_hero_terrorblade', localized_name: 'Terrorblade' }, { id: 2, name: 'npc_dota_hero_axe', localized_name: 'Axe' }],
  }, over || {});
  const fetch = url => {
    const path = url.replace('https://api.opendota.com/api/', '');
    asked.push(path);
    return Promise.resolve(path in data ? { ok: true, status: 200, json: () => Promise.resolve(data[path]) } : { ok: false, status: 404 });
  };
  return { fetch, asked };
}

async function testDota() {
  console.log('dota.js');
  ok(accountOf('76561198047011640') === 86745912 && accountOf('123') === null && accountOf(null) === null, 'SteamID64 → Dota\'s account id (its lower 32 bits)');
  ok(rankName(63) === 'Властелин 3' && rankName(80, 70) === 'Титан · №70 в таблице лидеров' && rankName(0) === '' && rankName(null) === '', 'ranks in Russian: Властелин 3, Титан with its place, none when not calibrated');
  ok(matches(1) === '1 матч' && matches(3) === '3 матча' && matches(11) === '11 матчей' && matches(1375) === '1 375 матчей', '1 матч, 3 матча, 11 матчей, 1 375 матчей', [matches(1375)]);

  const { win, col, other } = profilePage();
  const od = opendota();
  const storage = memStorage();
  const d = createDota({ win, storage, fetch: od.fetch, tokens: TOKENS });
  win.document.body.appendChild(col);
  await sleep(30);
  const card = () => win.document.getElementById('arkada-dota');
  ok(card() && card().parentNode === col && col.childNodes[0] === card() && col.childNodes[1] === other, 'the card is at the top of the profile\'s right column');
  ok(eq(od.asked.slice().sort(), ['heroes', 'players/86745912', 'players/86745912/heroes', 'players/86745912/peers', 'players/86745912/wl', 'players/86745912/wl?date=365']), 'six requests to OpenDota, all for this player (from Steam\'s own g_rgProfileData)', od.asked);
  const text = card() ? card().textContent : '';
  ok(text.includes('Властелин 3') && text.includes('3 145матчей всего') && text.includes('62,1%побед') && text.includes('45за последний год'), 'rank, matches, win rate, the last year', text);
  const who = card() ? card().querySelectorAll('.arkada-dota-part')[0].querySelectorAll('.arkada-dota-who').map(n => n.textContent) : [];
  ok(eq(who, ['Shadow Fiend167 матчей', 'Terrorblade122 матча', 'Axe50 матчей']), 'the three most played heroes, by games, with their names from OpenDota', who);
  ok(card() && card().querySelector('.arkada-dota-pic').src === 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/nevermore.png', 'hero pictures from Valve\'s CDN');
  ok(text.includes('Cr1t-1 375 матчей') && card().querySelector('.arkada-dota-link').href === 'https://www.opendota.com/players/86745912', 'teammates, and a link to the player on OpenDota', text);
  ok(win.document.querySelectorAll('#arkada-dota-style').length === 1 && observing() === 0, 'one style sheet; the watcher is gone once the card is in');
  d.stop();
  ok(!card() && !win.document.getElementById('arkada-dota-style'), 'stop() takes the card and its style away');

  // The same profile again: from the page's storage, no request
  const again = profilePage();
  const od2 = opendota();
  const d2 = createDota({ win: again.win, storage, fetch: od2.fetch, tokens: TOKENS });
  again.win.document.body.appendChild(again.col);
  await sleep(30);
  ok(again.win.document.getElementById('arkada-dota') && od2.asked.length === 0, 'the same profile within 6 hours → from the page\'s storage, OpenDota is not asked');
  d2.stop();

  // No matches (never played, or hidden): nothing on the page
  const none = profilePage(null, '76561197960265729');
  const od3 = opendota({ 'players/1': { profile: { account_id: 1, personaname: 'x' }, rank_tier: null }, 'players/1/wl': { win: 0, lose: 0 }, 'players/1/wl?date=365': { win: 0, lose: 0 }, 'players/1/heroes': [], 'players/1/peers': [] });
  const d3 = createDota({ win: none.win, storage: memStorage(), fetch: od3.fetch, tokens: TOKENS });
  none.win.document.body.appendChild(none.col);
  await sleep(30);
  ok(!none.win.document.getElementById('arkada-dota') && observing() === 0, 'a player with no open matches → no card, no watcher');
  d3.stop();

  // The setting is off, or not a profile's own page: OpenDota is not asked at all
  const off = profilePage();
  off.win.computed['--arkada-dota'] = ' off';
  const od4 = opendota();
  createDota({ win: off.win, storage: memStorage(), fetch: od4.fetch, tokens: TOKENS }).stop();
  const sub = profilePage('https://steamcommunity.com/id/someone/games/?tab=all');
  const od5 = opendota();
  createDota({ win: sub.win, storage: memStorage(), fetch: od5.fetch, tokens: TOKENS }).stop();
  await sleep(10);
  ok(od4.asked.length === 0 && od5.asked.length === 0, '«Статистика Dota 2» → Выкл, or a subpage of the profile → no request to OpenDota');
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

// ───────── web.js: what the store and community modules share ─────────
async function testWeb() {
  console.log('web.js');
  const pm = web.parseMoney;
  ok(pm('23₴') === 23 && pm('1 234,56₴') === 1234.56 && pm('$12.99') === 12.99 && pm('1,234.50 USD') === 1234.5 && pm('12,-€') === 12 && pm('1.234,56 ARS$') === 1234.56 && pm('—') === null,
    'prices as Steam writes them, in any currency: 23₴, 1 234,56₴, $12.99, 1,234.50, 12,-€, 1.234,56', [pm('23₴'), pm('1 234,56₴'), pm('$12.99'), pm('1,234.50 USD'), pm('12,-€'), pm('1.234,56 ARS$')]);
  ok(web.formatLike('23₴', 1234.5) === '1 234,50₴' && web.formatLike('$1.99', 1234.5) === '$1,234.50' && web.formatLike('0,00₴', 12) === '12,00₴' && web.formatLike('12,99€', 3) === '3,00€',
    'a sum is written the way a price of its currency is: 1 234,50₴, $1,234.50', [web.formatLike('23₴', 1234.5), web.formatLike('$1.99', 1234.5)]);
  ok(web.plural(1, 'игра', 'игры', 'игр') === 'игра' && web.plural(3, 'игра', 'игры', 'игр') === 'игры' && web.plural(12, 'игра', 'игры', 'игр') === 'игр' && web.plural(22, 'игра', 'игры', 'игр') === 'игры', '1 игра, 3 игры, 12 игр, 22 игры');
  let t = 0;
  const times = [];
  const q = web.createQueue({ everyMs: 30, now: () => Date.now() });
  t = Date.now();
  for (let i = 0; i < 3; i++) q.push(() => { times.push(Date.now() - t); });
  await sleep(120);
  ok(times.length === 3 && times[1] - times[0] >= 25 && times[2] - times[1] >= 25, 'the queue runs its jobs one at a time, no sooner than everyMs apart', times);
  const held = [];
  q.pause(80);
  t = Date.now();
  q.push(() => { held.push(Date.now() - t); });
  await sleep(140);
  ok(held.length === 1 && held[0] >= 70, 'pause(ms) holds the queue (Steam said 429)', held);
  q.stop();
  const store = memStorage();
  let now = 1000;
  const c = web.createCache(store, 'x.', () => now);
  c.set('a', { v: 1 });
  now += 50;
  ok(eq(c.get('a', 100), { v: 1 }) && c.get('a', 10) === undefined, 'the cache answers within its age, not after');
  const w = makeDomWindow('https://store.steampowered.com/');
  w.computed['--arkada-prices'] = ' "off"';
  ok(web.switchedOff(w, 'prices') && !web.switchedOff(w, 'market'), 'a feature is off when its --arkada-<name> on <html> says off');
}

// ───────── prices.js ─────────
function appPage(href, opts) {
  const win = makeDomWindow(href || 'https://store.steampowered.com/app/1086940/Baldurs_Gate_3/');
  const doc = win.document;
  const cfg = doc.createElement('div'); cfg.id = 'application_config'; cfg.setAttribute('data-userinfo', JSON.stringify({ country_code: 'UA', steamid: '76561198000000009' }));
  doc.body.appendChild(cfg);
  if (opts && opts.se) {
    doc.documentElement.className = 'se-store se-app-summary-on';
    const strip = doc.createElement('div'); strip.className = 'se-app-summary__strip';
    const left = doc.createElement('div'); left.className = 'se-app-summary__cell';
    const right = doc.createElement('div'); right.className = 'se-app-summary__cell';
    const shots = doc.createElement('div'); shots.className = 'se-app-summary__group';
    right.appendChild(shots); strip.appendChild(left); strip.appendChild(right); doc.body.appendChild(strip);
    return { win, doc, right, shots };
  }
  const area = doc.createElement('div'); area.id = 'game_area_purchase';
  const wrap = doc.createElement('div'); wrap.className = 'game_area_purchase_game_wrapper'; area.appendChild(wrap);
  const rc = doc.createElement('div'); rc.className = 'rightcol game_meta_data';
  doc.body.appendChild(area); doc.body.appendChild(rc);
  return { win, doc, area, rc };
}
function itadBackend(start) {
  const s = { key: start || '', calls: [] };
  s.server = (method, args) => {
    s.calls.push([method, args]);
    if (method === 'ItadKey') { s.key = args.key; return Promise.resolve(JSON.stringify({ success: true, hasKey: !!s.key })); }
    if (!s.key) return Promise.resolve(JSON.stringify({ success: false, hasKey: false, error: 'no key' }));
    if (s.key === 'wrong-key-0123456789') return Promise.resolve(JSON.stringify({ success: false, hasKey: true, error: 'bad key' }));
    return Promise.resolve({ type: 'string', value: JSON.stringify({ success: true, hasKey: true, data: {
      game: 'https://isthereanydeal.com/game/id:1/',
      current: { shop: 'GOG', price: { amount: 629, currency: 'UAH' }, regular: { amount: 899, currency: 'UAH' }, cut: 30, url: 'https://itad.link/1/' },
      lowest: { shop: 'Steam', price: { amount: 539.4, currency: 'UAH' }, cut: 40, timestamp: '2024-11-27T19:00:00+01:00' } } }) });
  };
  return s;
}
async function testPrices() {
  console.log('prices.js');
  ok(money({ amount: 1299, currency: 'UAH' }).replace(/\s/g, ' ') === '1 299,00 грн.' || /1\s299,00/.test(money({ amount: 1299, currency: 'UAH' })), 'ITAD\'s price → money in Russian', money({ amount: 1299, currency: 'UAH' }));
  let p = appPage();
  let be = itadBackend('');
  let m = createPrices({ win: p.win, server: be.server, tokens: TOKENS });
  await sleep(20);
  const card = () => p.doc.getElementById('arkada-prices');
  ok(card() && card().parentNode === p.area && p.area.firstChild === card(), 'without the theme: the card is at the top of Steam\'s purchase area');
  const links = () => card().querySelectorAll('.arkada-card-links .arkada-card-link').map(a => a.href);
  ok(eq(links(), ['https://steamdb.info/app/1086940/#pricehistory', 'https://isthereanydeal.com/steam/app/1086940/']), 'links: the price history on SteamDB, the game on IsThereAnyDeal', links());
  ok(eq(be.calls, [['ItadPrices', { appid: 1086940, country: 'UA' }]]), 'the backend is asked once, with the game and the country of the user\'s store', be.calls);
  ok(card().textContent.includes('добавить личный ключ IsThereAnyDeal') && card().querySelector('.arkada-card-head .arkada-card-link').textContent === 'Добавить ключ', 'no key → the links and how to add a key');
  card().querySelector('.arkada-card-head .arkada-card-link').click();
  const input = card().querySelector('.arkada-card-input');
  ok(input && input.getAttribute('type') === 'password' && card().textContent.includes('isthereanydeal.com/apps/my'), '«Добавить ключ» → a field for the key and where to get one');
  input.value = '  0123456789abcdef0123456789abcdef01234567 ';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  await sleep(20);
  ok(be.calls[1] && be.calls[1][0] === 'ItadKey' && be.calls[1][1].key === '0123456789abcdef0123456789abcdef01234567', 'Enter → the key goes to the backend (trimmed), not to the page\'s storage', be.calls[1]);
  ok(be.calls[2] && be.calls[2][0] === 'ItadPrices', '… and the prices are asked again');
  const rows = card().querySelectorAll('.arkada-card-row').map(r => r.textContent);
  ok(rows.length === 2 && rows[0].startsWith('Сейчас дешевле всего') && rows[0].includes('GOG') && rows[0].includes('−30%') && rows[1].startsWith('Исторический минимум') && rows[1].includes('2024'), 'with a key: the best price now (shop, cut) and the lowest ever (date)', rows);
  ok(card().querySelector('.arkada-card-row a').href === 'https://itad.link/1/' && links()[1] === 'https://isthereanydeal.com/game/id:1/', 'the deal\'s link is ITAD\'s own, as given', links());
  ok(card().textContent.includes('Arkada с IsThereAnyDeal не связана'), 'where the prices come from is said on the card');
  p.area.removeChild(card());
  await sleep(20);
  ok(card() && card().parentNode === p.area, 'the page draws its area anew → the card goes back');
  m.stop();
  ok(!card() && !p.doc.getElementById('arkada-web-style') && observing() === 0, 'stop() takes the card, the style and the watcher away');

  // With the theme: the right column of its summary, above its own groups; a wrong key is said so
  p = appPage(null, { se: true });
  be = itadBackend('wrong-key-0123456789');
  m = createPrices({ win: p.win, server: be.server, tokens: TOKENS });
  await sleep(20);
  ok(card() && card().parentNode === p.right && p.right.firstChild === card(), 'with the theme (Steam Enhanced): at the top of the right column of its summary');
  ok(card().textContent.includes('IsThereAnyDeal не принял ключ'), 'a key ITAD refuses → said so', card().textContent);
  m.stop();
  // No backend (Millennium or the plugin's backend not there): only the links, no key field
  p = appPage();
  m = createPrices({ win: p.win, server: () => Promise.resolve(null), tokens: TOKENS });
  await sleep(20);
  ok(card() && !card().querySelector('.arkada-card-head .arkada-card-link') && card().querySelectorAll('.arkada-card-links a').length === 2, 'no backend → just the links');
  m.stop();
  // Off, or not a game's page: nothing, the backend is not asked
  p = appPage();
  p.win.computed['--arkada-prices'] = 'off';
  be = itadBackend('k');
  m = createPrices({ win: p.win, server: be.server, tokens: TOKENS });
  await sleep(20);
  ok(!card() && be.calls.length === 0 && observing() === 0, 'setting «Цены» off → no card, the backend is not asked');
  m.stop();
  p = appPage('https://store.steampowered.com/search/?term=x');
  m = createPrices({ win: p.win, server: be.server, tokens: TOKENS });
  await sleep(20);
  ok(!card() && be.calls.length === 0, 'not a game\'s page → nothing');
  m.stop();
}

// ───────── gameinfo.js ─────────
async function testGameInfo() {
  console.log('gameinfo.js');
  ok(hours(8302) === '138,4 ч' && hours(45) === '45 мин' && hours(120000) === '2 000 ч', 'hours: 138,4 ч, 45 мин, 2 000 ч', [hours(8302), hours(120000)]);
  let p = appPage('https://store.steampowered.com/app/730/', { se: true });
  const asked = [];
  const call = (name, arg) => { asked.push([name, arg]); return Promise.resolve({ type: 'string', value: JSON.stringify({ owned: true, minutes: 8302, minutesTwoWeeks: 90, lastPlayed: 1757020268, purchased: 1515098495 }) }); };
  const prices = createPrices({ win: p.win, server: () => Promise.resolve(null), tokens: TOKENS });
  const g = createGameInfo({ win: p.win, call, tokens: TOKENS });
  await sleep(30);
  const card = () => p.doc.getElementById('arkada-game-info');
  ok(eq(asked, [['arkadaGame.info', '730']]), 'the client is asked for this game', asked);
  ok(card() && card().parentNode === p.right && p.right.childNodes.indexOf(card()) === 1 && p.right.firstChild.id === 'arkada-prices', 'under «Цены», above the theme\'s own groups', p.right.childNodes.map(n => n.id || n.className));
  const rows = card().querySelectorAll('.arkada-card-row').map(r => r.textContent);
  ok(rows.length === 4 && rows[0] === 'Вы играли138,4 ч' && rows[1] === 'За две недели1,5 ч' && rows[3].startsWith('На аккаунте с') && rows[3].includes('2018'), 'hours, two weeks, last played, on the account since', rows);
  ok(eq(card().querySelectorAll('.arkada-card-links a').map(a => a.href), ['https://steamdb.info/app/730/', 'https://www.pcgamingwiki.com/api/appid.php?appid=730', 'https://www.protondb.com/app/730']), 'links to SteamDB, PCGamingWiki, ProtonDB');
  g.stop(); prices.stop();
  ok(!card() && observing() === 0, 'stop() takes it away');
  // Not owned (the client answers null) or no bridge: only the links, in Steam's right column without the theme
  p = appPage('https://store.steampowered.com/app/1086940/');
  const g2 = createGameInfo({ win: p.win, call: () => Promise.reject(new Error('no bridge')), tokens: TOKENS });
  await sleep(20);
  ok(card() && card().parentNode === p.rc && card().querySelectorAll('.arkada-card-row').length === 0 && card().querySelectorAll('.arkada-card-links a').length === 3, 'not in the library (or no client) → only the links, at the top of Steam\'s right column');
  g2.stop();
  p = appPage('https://store.steampowered.com/app/730/');
  p.win.computed['--arkada-game-info'] = 'off';
  asked.length = 0;
  const g3 = createGameInfo({ win: p.win, call, tokens: TOKENS });
  await sleep(20);
  ok(!card() && asked.length === 0, 'setting off → nothing, the client is not asked');
  g3.stop();
}

// ───────── hideowned.js ─────────
async function testHideOwned() {
  console.log('hideowned.js');
  const at = href => { const w = makeDomWindow(href); const h = createHideOwned({ win: w }); return { w, h, style: w.document.getElementById('arkada-hide-owned') }; };
  const s = at('https://store.steampowered.com/search/?term=counter');
  ok(s.style && /\.ds_collapse_flag\.ds_owned, \.ds_collapse_flag\.ds_ignored \{ display: none !important; \}/.test(s.style.textContent), 'a list of the store: one rule hides what Steam marks owned or ignored');
  s.h.stop();
  ok(!s.w.document.getElementById('arkada-hide-owned'), 'stop() takes the rule away');
  ok(!at('https://store.steampowered.com/app/730/').style && !at('https://store.steampowered.com/wishlist/').style && !at('https://steamcommunity.com/market/').style, 'not on a game\'s page (its DLC), the wishlist, or the community');
  const off = makeDomWindow('https://store.steampowered.com/tags/ru/RPG/');
  off.computed['--arkada-hide-owned'] = 'off';
  createHideOwned({ win: off });
  ok(!off.document.getElementById('arkada-hide-owned'), 'setting off → nothing hidden');
}

// ───────── wishlist.js ─────────
function wishlistApi(n) {
  const asked = [];
  const items = Array.from({ length: n }, (_, i) => ({ appid: 10 + i }));
  const fetch = url => {
    asked.push(url);
    let body;
    if (url.startsWith('https://api.steampowered.com/IWishlistService/GetWishlist/v1/')) body = { response: { items } };
    else if (url.startsWith('https://api.steampowered.com/IStoreBrowseService/GetItems/v1/')) {
      const q = JSON.parse(decodeURIComponent(url.split('input_json=')[1]));
      body = { response: { store_items: q.ids.map(({ appid }) => appid % 5 === 0 ? { appid } : { appid, best_purchase_option: appid % 2
        ? { final_price_in_cents: '10000', original_price_in_cents: '40000', discount_pct: 75, formatted_final_price: '100,00₴' }
        : { final_price_in_cents: '50000', formatted_final_price: '500,00₴' } }) } };
    } else return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { asked, fetch };
}
async function testWishlist() {
  console.log('wishlist.js');
  const s = summarize([{ best_purchase_option: { final_price_in_cents: '10000', original_price_in_cents: '40000', discount_pct: 75, formatted_final_price: '100,00₴' } }, { best_purchase_option: { final_price_in_cents: '50000' } }, {}]);
  ok(s.total === 60000 && s.regular === 90000 && s.priced === 2 && s.sale === 1 && s.none === 1 && s.sample === '100,00₴', 'sum: with today\'s discounts, without them, on sale, without a price', s);
  const win = makeDomWindow('https://store.steampowered.com/wishlist/id/someone/');
  win.SSR = { loaderData: [JSON.stringify({ steamid: '76561198000000001', storeBrowseContext: { country: 'UA', language: 'russian' } }), JSON.stringify({ steamid: '76561198000000002', sort: 'order', filters: {} })] };
  ok(ownerOf(win) === '76561198000000002', 'whose list: the wishlist loader\'s steamid, not the signed-in user\'s');
  const head = win.document.createElement('div'); const h2 = win.document.createElement('h2'); head.appendChild(h2); win.document.body.appendChild(head);
  const api = wishlistApi(150);
  const storage = memStorage();
  const w = createWishlist({ win, storage, fetch: api.fetch, tokens: TOKENS, everyMs: 10 });
  await sleep(40);
  const card = () => win.document.getElementById('arkada-wishlist-sum');
  ok(api.asked.length === 3 && api.asked[0].endsWith('steamid=76561198000000002') && /"country_code":"UA"/.test(decodeURIComponent(api.asked[1])), 'the list, then its prices 100 games a request, in the user\'s country', api.asked.length);
  ok(card() && card().parentNode === head, 'the card is under the title');
  const big = card().querySelectorAll('.arkada-card-big').map(b => b.textContent);
  // 150 games: 30 without a price (appid % 5 === 0), 60 at 100 (from 400), 60 at 500
  ok(eq(big, ['36 000,00₴', '54 000,00₴', '18 000,00₴']) && card().textContent.includes('120 игр с ценой, 30 без цены') && card().textContent.includes('60 игр со скидкой'), 'sum now, without discounts, the saving', [big, card().textContent]);
  head.removeChild(card());
  await sleep(30);
  ok(card() && card().parentNode === head, 'React draws the header anew → the card goes back (the light timer)');
  w.stop();
  ok(!card(), 'stop() takes it away');
  const again = createWishlist({ win, storage, fetch: api.fetch, tokens: TOKENS, everyMs: 10 });
  await sleep(20);
  ok(api.asked.length === 3 && card(), 'opened again within 30 minutes → from the page\'s storage, nothing asked');
  again.stop();
  const off = makeDomWindow('https://store.steampowered.com/wishlist/profiles/76561198000000003/');
  off.computed['--arkada-wishlist-sum'] = 'off';
  const api2 = wishlistApi(3);
  createWishlist({ win: off, storage: memStorage(), fetch: api2.fetch, tokens: TOKENS }).stop();
  ok(api2.asked.length === 0, 'setting off → Steam is not asked');
}

// ───────── inventory.js ─────────
function inventoryPage() {
  const win = makeDomWindow('https://steamcommunity.com/id/someone/inventory/');
  const doc = win.document;
  const logos = doc.createElement('div'); logos.id = 'inventory_logos'; doc.body.appendChild(logos);
  win.g_rgWalletInfo = { wallet_currency: 18 };
  const tile = id => { const e = doc.createElement('div'); e.className = 'item'; e.id = id; doc.body.appendChild(e); return e; };
  const asset = (id, name, marketable, amount) => ({ amount: String(amount || 1), description: { appid: 753, market_hash_name: name, marketable: marketable ? 1 : 0 }, element: tile('753_6_' + id) });
  win.g_ActiveInventory = { appid: '753', contextid: 0, m_rgChildInventories: { 6: { m_rgAssets: { 1: asset(1, 'Card A', true), 2: asset(2, 'Card A', true), 3: asset(3, 'Booster', true, 2), 4: asset(4, '753-Gems', false, 121), 5: asset(5, 'Rare', true) } } } };
  return { win, doc };
}
async function testInventory() {
  console.log('inventory.js');
  const list = itemsOf(inventoryPage().win.g_ActiveInventory);
  ok(eq(list.map(i => i.key + 'x' + i.amount), ['753/Card Ax1', '753/Card Ax1', '753/Boosterx2', '753/Rarex1']), 'only what the market can sell, from Steam\'s own objects (the parts of the Steam inventory too)', list.map(i => i.key));
  const { win, doc } = inventoryPage();
  const asked = [];
  let limit = 1;
  const fetch = url => {
    asked.push(decodeURIComponent(url));
    if (url.includes('Rare') && limit-- > 0) return Promise.resolve({ ok: false, status: 429 });
    const name = decodeURIComponent(url.split('market_hash_name=')[1]);
    const body = name === 'Card A' ? { success: true, lowest_price: '3₴' } : name === 'Booster' ? { success: true, lowest_price: '1 023,50₴' } : name === 'Rare' ? { success: true, median_price: '100₴' } : { success: false };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  const storage = memStorage();
  const v = createInventory({ win, storage, fetch, tokens: TOKENS, everyMs: 15, lookMs: 20, backoffMs: 60 });
  await sleep(10);
  const card = () => doc.getElementById('arkada-inventory-value');
  ok(card() && card().nextSibling === doc.getElementById('inventory_logos') && card().textContent.includes('Ещё '), 'the card is above the inventory, with what is left to price', card() && card().textContent);
  await sleep(60);
  ok(asked.length === 3 && asked.every(u => u.startsWith('/market/priceoverview/?appid=753&currency=18&market_hash_name=')), 'one request per kind of item, in the wallet\'s currency', asked);
  ok(card().textContent.includes('Steam попросил подождать'), '429 → said so, and the queue waits', card().textContent);
  await sleep(150);
  ok(asked.length === 4 && asked[3].endsWith('Rare'), '… then asks that item again', asked);
  ok(card().querySelector('.arkada-card-big').textContent === '2 153₴', 'the sum: price × how many (3 + 3 + 1 023,50 × 2 + 100)', card().querySelector('.arkada-card-big').textContent);
  const badges = doc.querySelectorAll('.arkada-inv-price').map(b => b.parentNode.id + '=' + b.textContent);
  ok(eq(badges, ['753_6_1=3₴', '753_6_2=3₴', '753_6_3=1 023,50₴', '753_6_5=100₴']), 'each item shows its price on its tile', badges);
  ok(JSON.parse(storage.getItem('arkada.inventory.prices.18'))['753/Booster'][1] === 1023.5, 'prices are kept in the page\'s storage');
  v.stop();
  ok(!card() && doc.querySelectorAll('.arkada-inv-price').length === 0, 'stop() takes the card and the prices away');
  const again = inventoryPage();
  const asked2 = [];
  const v2 = createInventory({ win: again.win, storage, fetch: u => { asked2.push(u); return fetch(u); }, tokens: TOKENS, everyMs: 15, lookMs: 20 });
  await sleep(40);
  ok(asked2.length === 0 && again.doc.getElementById('arkada-inventory-value').querySelector('.arkada-card-big').textContent === '2 153₴', 'opened again within a day → from the storage, the market is not asked');
  v2.stop();
  const off = inventoryPage();
  off.win.computed['--arkada-market'] = 'off';
  const asked3 = [];
  createInventory({ win: off.win, storage: memStorage(), fetch: u => { asked3.push(u); return fetch(u); }, tokens: TOKENS }).stop();
  ok(asked3.length === 0 && !off.doc.getElementById('arkada-inventory-value'), 'setting off → nothing asked, nothing shown');
}

// ───────── markethistory.js ─────────
const historyRow = (sign, price) => `<div class="market_listing_row market_recent_listing_row" id="history_row_1"> <div class="market_listing_left_cell market_listing_gainorloss"> ${sign} </div>
  <div class="market_listing_right_cell market_listing_their_price"> <span class="market_table_value"> <span class="market_listing_price"> ${price} </span> </span> </div> </div>`;
async function testMarketHistory() {
  console.log('markethistory.js');
  const rows = rowsOf('<div class="market_listing_table_header"></div>' + historyRow('-', '25₴') + historyRow('+', '1 024,50₴') + historyRow('', '7₴'));
  ok(eq(rows, [{ sign: '-', text: '25₴' }, { sign: '+', text: '1 024,50₴' }]), 'the rows of Steam\'s history: «+» bought, «−» sold; listings put up are not counted', rows);
  const t = totals(rows);
  ok(t.bought === 1024.5 && t.sold === 25 && t.nBought === 1 && t.nSold === 1, 'totals', t);
  const win = makeDomWindow('https://steamcommunity.com/market/history');
  const doc = win.document;
  const bar = doc.createElement('div'); const tab = doc.createElement('a'); tab.setAttribute('href', 'history'); bar.appendChild(tab);
  const wrap = doc.createElement('div'); wrap.appendChild(bar); doc.body.appendChild(wrap);
  const asked = [];
  const pages = [[historyRow('-', '25₴'), historyRow('+', '10₴')], [historyRow('-', '5₴')]];
  const fetch = url => { asked.push(url); const start = Number(/start=(\d+)/.exec(url)[1]); const i = start / 100; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, total_count: 101, results_html: (pages[i] || []).join('') }) }); };
  const storage = memStorage();
  const m = createMarketHistory({ win, storage, fetch, tokens: TOKENS, everyMs: 10, placeMs: 10 });
  const card = () => doc.getElementById('arkada-market-history');
  ok(card() && bar.nextSibling === card(), 'the card is under the tabs');
  ok(asked.length === 0 && card().querySelector('button').textContent === 'Посчитать', 'nothing is read until «Посчитать» is pressed');
  card().querySelector('button').click();
  await sleep(60);
  ok(eq(asked, ['/market/myhistory/render/?query=&start=0&count=100', '/market/myhistory/render/?query=&start=100&count=100']), 'the history is read 100 rows a request, one request at a time', asked);
  const vals = card().querySelectorAll('.arkada-card-row').map(r => r.textContent);
  ok(vals[0] === 'Куплено10₴ · 1 покупка' && vals[1] === 'Продано30₴ · 2 продажи' && vals[2] === 'Продано минус куплено20₴', 'bought, sold, and the difference', vals);
  ok(card().querySelector('button').textContent === 'Пересчитать', 'then «Пересчитать»');
  m.stop();
  ok(!card(), 'stop() takes it away');
  const again = createMarketHistory({ win, storage, fetch, tokens: TOKENS, placeMs: 10 });
  ok(card() && card().textContent.includes('Куплено') && asked.length === 2, 'opened again within a day → the totals at once, nothing read');
  again.stop();
}

(async () => {
  for (const t of [testWatch, testFeatures, testKapsula, testDiskSize, testHltb, testShare, testDota, testWeb, testPrices, testGameInfo, testHideOwned, testWishlist, testInventory, testMarketHistory, testSteamCalls, testStartPage]) {
    try { await t(); } catch (e) { failed++; console.log('  FAIL  ' + t.name + ': ' + (e && e.stack || e)); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
