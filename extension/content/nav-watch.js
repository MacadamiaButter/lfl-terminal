/**
 * nav-watch.js — M2.2 runtime navigation interception. Arms a short-lived
 * watcher around an extension-executed `click`, to close the residual M1
 * gap documented in docs/threat-model.md: a plain element whose page-
 * supplied onclick handler navigates programmatically (location.href=,
 * location.assign(), form.submit(), etc.) has no static href/formaction for
 * guards.js's resolveClickNavTarget() to see ahead of time — the static
 * guard correctly reports hasTarget:false, the click proceeds, and whatever
 * the handler does, it does.
 *
 * Two detection paths, in order of strength:
 *
 * 1. Navigation API (`window.navigation`, supported since Chrome 102 — well
 *    within this project's Chrome >=144 floor). Its `navigate` event fires
 *    for any navigation the CURRENT browsing context initiates — same-
 *    origin or cross-origin, same-document or cross-document — and (unlike
 *    beforeunload) exposes the actual destination URL via
 *    `event.destination.url` BEFORE the navigation commits, with a real,
 *    silent `event.preventDefault()` when `event.cancelable` is true. This
 *    is the strongest interception this platform offers a content script,
 *    and is what actually classifies+blocks the onclick-evil-nav fixture.
 *
 * 2. `beforeunload` fallback (always available, but structurally blind to
 *    the destination — the spec deliberately does not expose it, for
 *    privacy). Used ONLY as a detect-and-log signal when the Navigation API
 *    is unavailable; it does NOT call preventDefault() on its own, because
 *    doing so would pop the browser's native "leave site?" confirmation on
 *    every ordinary approved navigation too (same-origin included) — we
 *    cannot tell from this event alone whether the in-flight navigation is
 *    the approved one, so blocking indiscriminately would be a UX
 *    regression, not a security improvement.
 *
 * HONEST, DOCUMENTED LIMIT (see docs/threat-model.md): `window.open()` to a
 * new tab, an `<a target="_blank">` click, and navigation of any browsing
 * context OTHER than the one this click ran in (e.g. a same-origin iframe's
 * own onclick navigating that iframe) are NOT observable by this watcher —
 * `window.navigation` only reports navigations of the context it belongs
 * to. Seeing a new tab appear would require the `tabs` or `webNavigation`
 * permission, which this project deliberately does not request (minimal-
 * permissions requirement, plan §5 item 13) — that residual is accepted and
 * documented, not silently swallowed.
 */
(function () {
  'use strict';

  window.LFL = window.LFL || {};

  const DEFAULT_WINDOW_MS = 1500;

  function armClickNavigationWatch(opts) {
    opts = opts || {};
    const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
    const originAtClick = opts.originAtClick || (typeof location !== 'undefined' ? location.origin : null);
    const approvedDestinationHref = opts.approvedDestinationHref || null;
    const onBlocked = typeof opts.onBlocked === 'function' ? opts.onBlocked : function () {};
    const onDetectedOnly = typeof opts.onDetectedOnly === 'function' ? opts.onDetectedOnly : function () {};

    let disposed = false;
    const cleanupFns = [];
    function dispose() {
      if (disposed) return;
      disposed = true;
      cleanupFns.forEach((fn) => { try { fn(); } catch (_e) { /* best-effort teardown */ } });
    }

    let usingNavigationApi = false;
    if (typeof window !== 'undefined' && window.navigation && typeof window.navigation.addEventListener === 'function') {
      usingNavigationApi = true;
      const onNavigate = (event) => {
        let destHref = null;
        try {
          destHref = event.destination && event.destination.url;
        } catch (_e) { /* leave null — treated as nothing to classify */ }
        if (!destHref) return;
        const verdict = LFL.guards.classifyRuntimeNavigation({
          destinationHref: destHref,
          originAtClick,
          approvedDestinationHref,
        });
        if (!verdict.allow) {
          let prevented = false;
          if (event.cancelable) {
            try {
              event.preventDefault();
              prevented = true;
            } catch (_e) { /* some navigation types refuse preventDefault — report what actually happened */ }
          }
          onBlocked({ destinationHref: destHref, verdict, prevented });
        }
      };
      window.navigation.addEventListener('navigate', onNavigate);
      cleanupFns.push(() => window.navigation.removeEventListener('navigate', onNavigate));
    }

    // beforeunload: always armed as a secondary, non-blocking signal — see
    // header comment for why it never calls preventDefault() on its own.
    const onBeforeUnload = () => {
      if (!usingNavigationApi) {
        onDetectedOnly({
          reason: 'navigation detected via beforeunload; destination is not observable from this event and the Navigation API is unavailable in this browser — cannot classify or block',
        });
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    cleanupFns.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

    const timer = setTimeout(dispose, windowMs);
    cleanupFns.push(() => clearTimeout(timer));

    return { dispose };
  }

  window.LFL.navWatch = { armClickNavigationWatch };
})();
