// Arkada, the Steam store without what you already have: games you own and games you have ignored are not
// shown in the store's lists — search results, tag, genre and sale pages, recommendations. Written for
// Arkada from what Augmented Steam does; no code taken from it.
//
// How: the store itself marks such items. Every item of its lists that Steam may collapse carries
// .ds_collapse_flag, and Steam's own script (GDynamicStore.DecorateDynamicItems, from the user's data on the
// page) adds .ds_owned or .ds_ignored to it. One style sheet hides exactly those — no watcher, no request,
// no reading of the page: a row Steam adds while scrolling is hidden by the same rule.
// Not on the page of a game, a package or a bundle (its list of DLC shows what you own on purpose), nor on
// the wishlist. Items Steam draws without these marks (parts of its newer React pages) stay as they are.
// The theme setting → Выкл takes effect on the next page that opens.
'use strict';
const web = require('./web.js');

const STYLE_ID = 'arkada-hide-owned';
const SKIP = /^\/(?:app|sub|bundle|wishlist|cart|account|checkout)\b/i;

const CSS = `
.ds_collapse_flag.ds_owned, .ds_collapse_flag.ds_ignored { display: none !important; }
`;

function createHideOwned(o) {
  const win = o.win, doc = win.document;
  const loc = win.location || {};
  let style = null;
  const store = String(loc.hostname).toLowerCase() === 'store.steampowered.com';
  if (store && !SKIP.test(String(loc.pathname || '')) && !web.switchedOff(win, 'hide-owned') && !doc.getElementById(STYLE_ID)) {
    style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }
  return {
    on: () => !!style,
    stop() { if (style) try { style.remove(); } catch (e) { } style = null; },
  };
}

module.exports = { createHideOwned, STYLE_ID };
