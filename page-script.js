// Injected into a super pin's tab with chrome.scripting.executeScript, so it has
// to be self-contained. `cfg` is { name, home, intercept }, or null to switch the
// script off again (the tab was unpinned or dragged to another window).
export function pageScript(cfg) {
  const KEY = '__superPin';
  let state = window[KEY];

  if (!state) {
    state = window[KEY] = { cfg: null, pageTitle: null, watching: null };

    // Reduce a hostname to its registrable domain, near enough: the last two
    // labels, or three when the second-to-last is a generic one (co.uk, com.au).
    const site = (hostname) => {
      const labels = hostname.toLowerCase().split('.');
      if (labels.length <= 2 || /^[\d.]+$/.test(hostname)) return hostname.toLowerCase();
      const generic = ['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'].includes(labels.at(-2)) && labels.at(-1).length === 2;
      return labels.slice(generic ? -3 : -2).join('.');
    };
    state.site = site;

    state.applyTitle = () => {
      const name = state.cfg?.name;
      if (!name) return;
      if (document.title !== name) {
        state.pageTitle = document.title;
        document.title = name;
      }
    };

    const observer = new MutationObserver(() => {
      state.watch();
      state.applyTitle();
    });
    // Watch <head> once it exists; until then watch the document for it to appear.
    state.watch = () => {
      const target = document.head || document;
      if (state.watching === target) return;
      observer.disconnect();
      observer.observe(target, { childList: true, subtree: true, characterData: true });
      state.watching = target;
    };

    addEventListener('click', (event) => {
      const { cfg } = state;
      if (!cfg?.intercept || !cfg.home) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.composedPath().find((node) => node.tagName === 'A' && node.href);
      if (!link || link.hasAttribute('download')) return;

      let target;
      let home;
      try {
        target = new URL(link.href);
        home = new URL(cfg.home);
      } catch {
        return;
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
      // Only while the tab is still on the pinned site, and only for links that leave it.
      if (site(location.hostname) !== site(home.hostname)) return;
      if (site(target.hostname) === site(home.hostname)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        chrome.runtime.sendMessage({ type: 'open-external', url: target.href });
      } catch {
        window.open(target.href, '_blank', 'noopener');
      }
    }, true);
  }

  const hadName = Boolean(state.cfg?.name);
  state.cfg = cfg;
  if (cfg?.name) {
    state.watch();
    state.applyTitle();
  } else if (hadName && state.pageTitle != null) {
    document.title = state.pageTitle;
  }
}
