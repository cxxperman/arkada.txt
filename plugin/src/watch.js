// Arkada, one watcher of a document's DOM: every module that needs to see the page change shares it.
// Used by pages.js (the main window of the client) and by webkit.js (a store page).
//
//   const w = createWatch(win, onChange);   win: the window of the document; onChange(): the DOM changed
//   w.start(); w.stop(); w.kick();          kick(): call onChange on the next frame, as if the DOM changed
//
// What it costs. A MutationObserver on <body> (child lists only, no attributes), connected only between
// start() and stop(). However many records come, onChange runs at most once per frame, in the next
// requestAnimationFrame. It gets no records: modules look for their place with querySelector and return
// at once when their element is still there. Nothing here reads layout, so a scroll that makes Steam add
// rows costs one cheap pass per frame and no reflow.
'use strict';

function createWatch(win, onChange) {
  let observer = null, queued = 0, running = false;
  const raf = typeof win.requestAnimationFrame === 'function' ? f => win.requestAnimationFrame(f) : f => setTimeout(f, 16);
  const unraf = typeof win.cancelAnimationFrame === 'function' ? id => win.cancelAnimationFrame(id) : id => clearTimeout(id);
  function run() {
    queued = 0;
    if (!running) return;
    try { onChange(); } catch (e) { /* a module's bug must not stop the watcher */ }
  }
  function kick() { if (running && !queued) queued = raf(run) || 1; }
  return {
    start() {
      if (running) return;
      running = true;
      try {
        const doc = win.document, Obs = win.MutationObserver;
        const target = doc && (doc.body || doc.documentElement);
        if (typeof Obs === 'function' && target) {
          observer = new Obs(kick);
          observer.observe(target, { childList: true, subtree: true });
        }
      } catch (e) { observer = null; }
      kick();
    },
    stop() {
      running = false;
      if (observer) try { observer.disconnect(); } catch (e) { }
      observer = null;
      if (queued) try { unraf(queued); } catch (e) { }
      queued = 0;
    },
    kick,
    running: () => running,
  };
}

module.exports = { createWatch };
