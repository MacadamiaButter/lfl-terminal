/**
 * executor.js - applies one action (deterministic or LLM-proposed) to the page.
 *
 * Hard blocks in here are NOT bypassable by approval: they run regardless of
 * whether a human clicked "approve". This is the file that must never be relaxed
 * without a design review - see docs/threat-model.md.
 *
 * The actual guard predicates (isPasswordField, safeSameOriginHttpUrl, the
 * click-target resolver) live in guards.js, loaded before this file, so the
 * Node unit test (tests/executor_credential.test.js) can load and exercise
 * the exact same guard code this file calls - see that file's header.
 */
(function () {
  'use strict';

  window.LFL = window.LFL || {};

  function fillNative(el, value) {
    const tag = el.tagName.toLowerCase();
    // window.HTMLInputElement / HTMLTextAreaElement are real browser globals;
    // guarded so this function can also run against fake elements under a
    // minimal Node shim (see tests/executor_credential.test.js) without a
    // full DOM.
    const hasNativeSetters = typeof window !== 'undefined' && window.HTMLInputElement && window.HTMLTextAreaElement;
    if (hasNativeSetters) {
      const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = desc && desc.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    } else {
      el.value = value;
    }
    if (typeof el.dispatchEvent === 'function') {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /**
   * Execute a single proposed action.
   * @param {object} action - {action, element(optional index), value(optional), reason(optional)}
   * @param {Map} elementMap - current axtree index -> WeakRef map (for click/fill/select)
   * @returns {{ok: boolean, message: string}}
   */
  function execute(action, elementMap) {
    const kind = action.action;

    if (kind === 'scroll') {
      const dir = (action.value || 'down').toLowerCase().includes('up') ? -600 : 600;
      window.scrollBy({ top: dir, behavior: 'auto' });
      return { ok: true, message: `scrolled ${dir < 0 ? 'up' : 'down'}` };
    }

    if (kind === 'answer' || kind === 'extract' || kind === 'abort') {
      // Read-only / informational - nothing to execute against the page.
      return { ok: true, message: action.value || action.reason || '(no content)' };
    }

    if (kind === 'navigate') {
      const check = LFL.guards.safeSameOriginHttpUrl(action.value || '');
      if (!check.ok) {
        return { ok: false, message: check.reason };
      }
      location.href = check.url.href;
      return { ok: true, message: `navigated to ${check.url.href}` };
    }

    // click / fill / select all require resolving an element index.
    const el = LFL.axtree.resolve(elementMap, action.element);
    if (!el) {
      return { ok: false, message: `abort: element [${action.element}] is stale or no longer visible - re-run the command` };
    }

    if (kind === 'click') {
      // A click can navigate exactly like a `navigate` action does (via an
      // <a href>, an ancestor <a> due to event bubbling, or a formaction) -
      // apply the SAME scheme/origin guard here, re-resolved from the live
      // element right now (closes the TOCTOU where a page swaps href between
      // proposal and approval). See MUST-FIX #1 in the security review.
      //
      // M2.4: guardOpts is derived from the LIVE element's OWN document/
      // window (guards.js is re-run "in its own document context") - for a
      // top-document element this is identical to the old ambient-global
      // defaults; for a same-origin-iframe element it's that iframe's own
      // baseURI/origin, not the top page's.
      const guardOpts = (window.LFL.axtree && typeof LFL.axtree.frameOptsFor === 'function')
        ? LFL.axtree.frameOptsFor(el)
        : undefined;
      const nav = LFL.guards.checkClickTarget(el, guardOpts);
      if (nav.hasTarget && nav.blocked) {
        const dest = nav.url ? nav.url.href : nav.rawUrl;
        return {
          ok: false,
          message: `click blocked - target is ${nav.classification} (${nav.reason}). Destination (not followed): ${dest}`,
        };
      }

      // M2.2: arm a short-lived runtime navigation watcher around this
      // click. The static guard above only classifies STATICALLY resolvable
      // targets (href/formaction/form-action/area/svg-a); a plain element
      // whose page-supplied onclick handler navigates programmatically has
      // no such target (hasTarget:false reaches here) and is otherwise
      // invisible to the click-target guard - this is the M1 residual M2.2
      // closes. See nav-watch.js for exactly what is prevented vs only
      // detected/logged.
      const approvedDestinationHref = (nav.hasTarget && !nav.blocked && nav.url) ? nav.url.href : null;
      const originAtClick = (guardOpts && guardOpts.origin) || (typeof location !== 'undefined' ? location.origin : null);
      if (window.LFL.navWatch && typeof LFL.navWatch.armClickNavigationWatch === 'function') {
        LFL.navWatch.armClickNavigationWatch({
          originAtClick,
          approvedDestinationHref,
          onBlocked: (info) => {
            const msg = `click triggered an unapproved off-site navigation - ${info.prevented ? 'blocked' : 'DETECTED (could not be prevented by this browser)'} (destination ${info.destinationHref}: ${info.verdict.reason})`;
            if (window.LFL.terminal && typeof LFL.terminal.reportAsync === 'function') {
              LFL.terminal.reportAsync(msg, info.prevented ? 'error' : 'error');
            }
          },
          onDetectedOnly: (info) => {
            if (window.LFL.terminal && typeof LFL.terminal.reportAsync === 'function') {
              LFL.terminal.reportAsync(`navigation observed after click, could not be classified or blocked (${info.reason})`, 'info');
            }
          },
        });
      }

      el.click();
      return { ok: true, message: `clicked [${action.element}]` };
    }

    if (kind === 'fill') {
      if (LFL.guards.isPasswordField(el)) {
        return { ok: false, message: 'credentials never go through the model - use your password manager' };
      }
      const tag = el.tagName.toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) {
        return { ok: false, message: `abort: [${action.element}] is not a fillable field` };
      }
      if (el.isContentEditable) {
        el.textContent = action.value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        fillNative(el, action.value || '');
      }
      return { ok: true, message: `filled [${action.element}] with "${action.value || ''}"` };
    }

    if (kind === 'select') {
      if (LFL.guards.isPasswordField(el)) {
        return { ok: false, message: 'credentials never go through the model - use your password manager' };
      }
      if (el.tagName.toLowerCase() !== 'select') {
        return { ok: false, message: `abort: [${action.element}] is not a native <select> element (M1 limitation)` };
      }
      const want = (action.value || '').trim();
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === want || opt.textContent.trim() === want) {
          el.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        return { ok: false, message: `abort: no option matching "${want}" in [${action.element}]` };
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, message: `selected "${want}" in [${action.element}]` };
    }

    return { ok: false, message: `abort: unknown action "${kind}"` };
  }

  window.LFL.executor = {
    execute,
    fillNative,
    isPasswordField: LFL.guards.isPasswordField,
    safeSameOriginHttpUrl: LFL.guards.safeSameOriginHttpUrl,
  };
})();
