/**
 * guards.js - pure, DOM-light security guard functions shared by the content
 * scripts (executor.js, terminal.js) and the Node unit test
 * (tests/executor_credential.test.js).
 *
 * These functions only read attributes off whatever element-shaped object
 * they're given and never touch the network, storage, or global page state.
 * Keeping them in one file (instead of duplicated inline in executor.js) is
 * what makes tests/executor_credential.test.js able to load and exercise the
 * REAL guard code the extension ships, not a reimplementation of it.
 *
 * Dual-mode: attaches to window.LFL.guards in the browser; exports via
 * module.exports under Node (CommonJS). No build step, no bundler - this
 * file is loaded directly both ways.
 *
 * Hard blocks built on these functions are NOT bypassable by human approval
 * - see docs/threat-model.md and the header comment in executor.js.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.LFL = root.LFL || {};
    root.LFL.guards = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- credential-field hard block (used by executor.js fill/select) ----
  //
  // Covers `type=password` and the `autocomplete` tokens that identify a
  // credential-bearing field:
  //   - current-password / new-password (login / signup password fields)
  //   - one-time-code (SMS/TOTP one-time-passcode fields)
  //
  // SCOPE LIMIT (documented, not a bug): a generic `type=text` PIN/OTP field
  // with no `autocomplete` hint is NOT detectable by this check - there is no
  // reliable DOM signal to key off in that case. See docs/threat-model.md.
  function isPasswordField(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toString().toLowerCase();
    const getAttr = typeof el.getAttribute === 'function' ? el.getAttribute.bind(el) : () => null;
    // type=password only means anything on an <input>.
    if (tag === 'input') {
      const type = (getAttr('type') || '').toLowerCase();
      if (type === 'password') return true;
    }
    // The autocomplete-token check, however, must NOT be input-only: this
    // guard also gates executor.js's `select` action (native <select>), and
    // restricting the check to tag==='input' made that branch's guard dead
    // code - a <select> can never be type=password, so a select-based OTP or
    // password-manager widget with autocomplete="one-time-code" (or, in
    // principle, current-password/new-password) would have sailed through
    // unblocked. Found while writing tests/executor_credential.test.js.
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const ac = (getAttr('autocomplete') || '').toLowerCase();
      if (ac.includes('current-password') || ac.includes('new-password') || ac.includes('one-time-code')) {
        return true;
      }
    }
    return false;
  }

  // ---- same-origin http(s) URL guard (navigate action + click-target guard) ----
  //
  // opts.baseURI / opts.origin let the Node test (and, in principle, an
  // iframe-aware M2 caller) supply values explicitly instead of relying on
  // the ambient `document`/`location` globals, which don't exist under Node.
  function safeSameOriginHttpUrl(rawUrl, opts) {
    opts = opts || {};
    const baseURI = 'baseURI' in opts ? opts.baseURI : (typeof document !== 'undefined' ? document.baseURI : undefined);
    const origin = 'origin' in opts ? opts.origin : (typeof location !== 'undefined' ? location.origin : undefined);
    let url;
    try {
      url = new URL(rawUrl, baseURI);
    } catch (_e) {
      return { ok: false, code: 'unparseable', reason: 'unparseable URL' };
    }
    if (!/^https?:$/.test(url.protocol)) {
      return { ok: false, code: 'non-http', reason: `blocked non-http(s) scheme: ${url.protocol}`, url };
    }
    if (url.origin !== origin) {
      return { ok: false, code: 'cross-origin', reason: `blocked cross-origin (M1 same-origin only): ${url.href}`, url };
    }
    return { ok: true, code: 'same-origin', url };
  }

  // ---- click navigation-target resolution ----
  //
  // Resolves what a `click` would actually navigate to (or submit to), so
  // executor.js can apply the same scheme/origin guard to click that it
  // already applies to navigate (see MUST-FIX #1 in the 2026-07 security
  // review, and the 2026-07-12 verifier follow-up that found this list was
  // incomplete - see below).
  //
  //   - <a href> on the element itself, OR an ancestor <a href> (covers event
  //     bubbling - the model may target a child of the actual anchor).
  //   - an SVG <a> (self or ancestor) whose link target lives in the
  //     XLink-namespaced `xlink:href` attribute / `.href.baseVal` rather than
  //     a plain `href` attribute - SVGAElement doesn't expose `href` the way
  //     HTMLAnchorElement does, so it isn't caught by the case above unless
  //     the page also mirrors a plain `href` (SVG2).
  //   - <button>/<input> with a `formaction` attribute (overrides the
  //     enclosing form's `action` per the HTML spec - checked first).
  //   - a submit control (`<button>` with type=submit or no `type` attribute
  //     at all - that's the default - or `<input type=submit|image>`) with
  //     no `formaction`: resolves the enclosing form's `action` via the
  //     `.form` property (correctly follows `form=` attribute association,
  //     not just DOM nesting), falling back to `closest('form')`. Found by
  //     the 2026-07-12 verifier: a submit click inside
  //     `<form action="https://evil.com">` reached `el.click()` with no
  //     guard at all before this fix. An absent/empty `action` resolves to
  //     the current document URL per spec (same-origin) - that's the correct
  //     ALLOW case, not a hole; only a resolved cross-origin or non-http(s)
  //     (e.g. `javascript:`) form action blocks.
  //   - <area href> (image-map hotspot) - never nested inside an anchor, so
  //     not caught by the anchor case above.
  //   - anything else (plain buttons, checkboxes, non-navigating elements)
  //     has no navigation target -> { hasTarget: false }.
  //
  // Always reads LIVE attributes/properties off the passed-in element (and,
  // for forms, the live associated <form>) - never cached extraction-time
  // data - so a page cannot swap a target between when the proposal was made
  // and when the human approves it (TOCTOU).
  function resolveClickNavTarget(el) {
    if (!el) return null;

    let anchor = null;
    if (typeof el.closest === 'function') {
      anchor = el.closest('a[href]');
    } else {
      const tag = (el.tagName || '').toString().toLowerCase();
      if (tag === 'a' && typeof el.hasAttribute === 'function' && el.hasAttribute('href')) {
        anchor = el;
      }
    }
    if (anchor) {
      return { rawUrl: anchor.getAttribute('href'), source: 'a' };
    }

    // SVG <a xlink:href> (self or ancestor) - only reached when the case
    // above found no plain `href` attribute.
    let svgAnchor = null;
    if (typeof el.closest === 'function') {
      svgAnchor = el.closest('a');
    } else {
      const tag = (el.tagName || '').toString().toLowerCase();
      if (tag === 'a') svgAnchor = el;
    }
    if (svgAnchor) {
      const svgHref = _svgAnchorHref(svgAnchor);
      if (svgHref !== null) {
        return { rawUrl: svgHref, source: 'svg-a' };
      }
    }

    const tag = (el.tagName || '').toString().toLowerCase();

    if ((tag === 'button' || tag === 'input') &&
        typeof el.hasAttribute === 'function' && el.hasAttribute('formaction')) {
      return { rawUrl: el.getAttribute('formaction'), source: 'formaction' };
    }

    if (_isSubmitControl(el)) {
      const form = el.form || (typeof el.closest === 'function' ? el.closest('form') : null);
      if (form) {
        const rawUrl = _formAction(form);
        if (rawUrl !== null) {
          return { rawUrl, source: 'form-action' };
        }
      }
    }

    if (tag === 'area' && typeof el.hasAttribute === 'function' && el.hasAttribute('href')) {
      return { rawUrl: el.getAttribute('href'), source: 'area' };
    }

    return null;
  }

  // SVGAElement's `.href` is an SVGAnimatedString (`.baseVal` holds the
  // string), not a plain string property like HTMLAnchorElement.href, and
  // the underlying attribute in non-SVG2 markup is XLink-namespaced rather
  // than a bare `href`. Try the IDL property first, then the namespaced
  // attribute lookup, then the literal `xlink:href` attribute name (some
  // element shapes - including this repo's own Node-test fakes - don't
  // implement getAttributeNS). Returns null (no target) if none apply.
  function _svgAnchorHref(el) {
    if (el.href && typeof el.href === 'object' && typeof el.href.baseVal === 'string') {
      return el.href.baseVal;
    }
    if (typeof el.getAttributeNS === 'function') {
      const nsHref = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (nsHref !== null && nsHref !== undefined) return nsHref;
    }
    if (typeof el.getAttribute === 'function') {
      const attrHref = el.getAttribute('xlink:href');
      if (attrHref !== null && attrHref !== undefined) return attrHref;
    }
    return null;
  }

  // A click on one of these, absent a `formaction` override, submits its
  // associated form (if any) to that form's `action`. Per the HTML spec a
  // <button> with no `type` attribute defaults to type=submit - that
  // default-submit case is exactly the gap the 2026-07-12 verifier found, so
  // it's checked via getAttribute (attribute presence), not the `.type`
  // property (which always normalizes to a value and would obscure whether
  // the attribute was actually present).
  function _isSubmitControl(el) {
    const tag = (el.tagName || '').toString().toLowerCase();
    const getAttr = typeof el.getAttribute === 'function' ? el.getAttribute.bind(el) : () => null;
    if (tag === 'button') {
      const type = (getAttr('type') || '').toLowerCase();
      return type === '' || type === 'submit';
    }
    if (tag === 'input') {
      const type = (getAttr('type') || '').toLowerCase();
      return type === 'submit' || type === 'image';
    }
    return false;
  }

  // Resolves a <form>'s effective submission target. Prefers the `.action`
  // IDL property when it's a string (per spec, the getter resolves an
  // absent/empty `action` attribute to the current document URL, which is
  // exactly the correct same-origin ALLOW result - no special-casing needed
  // here), falling back to the raw `action` attribute for element shapes
  // (e.g. this repo's own Node-test fakes) that don't implement the IDL
  // resolution. A totally absent attribute in that fallback path yields ''
  // which `safeSameOriginHttpUrl` resolves against `document.baseURI` -
  // same-origin, same correct result.
  function _formAction(form) {
    if (typeof form.action === 'string') return form.action;
    if (typeof form.getAttribute === 'function') {
      const attr = form.getAttribute('action');
      return attr === null || attr === undefined ? '' : attr;
    }
    return '';
  }

  function checkClickTarget(el, opts) {
    const nav = resolveClickNavTarget(el);
    if (!nav) return { hasTarget: false, blocked: false };
    const check = safeSameOriginHttpUrl(nav.rawUrl, opts);
    return {
      hasTarget: true,
      blocked: !check.ok,
      classification: check.code,
      reason: check.reason || null,
      url: check.url || null,
      rawUrl: nav.rawUrl,
      source: nav.source,
    };
  }

  // ---- M2.2 runtime navigation-interception classifier ----
  //
  // Pure decision function: given the destination a navigation is actually
  // headed to (only obtainable at runtime - e.g. from the Navigation API's
  // `navigate` event, see nav-watch.js's header comment for why
  // `beforeunload` cannot supply this), the page origin at the moment the
  // extension executed the click, and the destination (if any) that was
  // shown on the approval card for that click, decide allow/block.
  //
  // Same-origin navigations always proceed (plan §13 M2.2 - friction only
  // applies to a navigation that ends up crossing origin, or off-http(s),
  // that was NOT what the human approved).
  function classifyRuntimeNavigation(opts) {
    opts = opts || {};
    let url;
    try {
      url = new URL(opts.destinationHref);
    } catch (_e) {
      return { allow: false, code: 'unparseable', reason: 'unparseable navigation destination' };
    }
    if (!/^https?:$/.test(url.protocol)) {
      return { allow: false, code: 'non-http', reason: `blocked non-http(s) navigation: ${url.protocol}` };
    }
    if (opts.originAtClick && url.origin === opts.originAtClick) {
      return { allow: true, code: 'same-origin', reason: null };
    }
    if (opts.approvedDestinationHref) {
      let approvedUrl;
      try { approvedUrl = new URL(opts.approvedDestinationHref); } catch (_e) { approvedUrl = null; }
      if (approvedUrl && approvedUrl.href === url.href) {
        return { allow: true, code: 'approved-cross-origin', reason: null };
      }
    }
    return {
      allow: false,
      code: 'unapproved-cross-origin',
      reason: `navigation to ${url.origin} was not the destination shown/approved on the approval card`,
    };
  }

  // ---- M2.1 execution-time occlusion decision ----
  //
  // Pure comparison logic only - the actual DOM sampling (elementsFromPoint,
  // getBoundingClientRect, the pointer-events probe) is impure/browser-only
  // and lives in terminal.js's _probeApprovalOcclusion(), which calls this
  // function with the samples it collected. Keeping the decision itself pure
  // is what makes it unit-testable with plain fake objects under Node.
  function classifyOcclusionProbe(sample) {
    sample = sample || {};
    if (!sample.host || !sample.approveEl) {
      return { occluded: true, reason: 'occlusion probe missing required elements' };
    }
    if (sample.outsideTopmost !== sample.host) {
      return {
        occluded: true,
        reason: 'topmost element at the approval control is not the extension overlay - page content (or another surface) is covering it',
      };
    }
    const innerOk = sample.innerTopmost === sample.approveEl ||
      (sample.innerTopmost && typeof sample.approveEl.contains === 'function' && sample.approveEl.contains(sample.innerTopmost));
    if (!innerOk) {
      return { occluded: true, reason: 'approve control is not the topmost element within the overlay itself' };
    }
    return { occluded: false, reason: null };
  }

  // ---- M3 H1 - event.isTrusted gate ----
  //
  // "Terminal input = trusted because a human typed it" only holds if every
  // handler that reacts to a keydown/click on our own overlay actually
  // checks the event came from a real input device. A page can dispatch
  // synthetic KeyboardEvent/MouseEvent objects at our host element (it
  // lives in the light DOM, retargeted from inside the closed shadow root -
  // see terminal.js's _onGlobalKeydown) with e.isTrusted === false; without
  // this check a page could, at minimum, synthesize an Escape keydown to
  // reject a pending proposal (harmless-direction DoS, not a mutation
  // hole - the M1/M2 threat model already covers this), but M3 leans much
  // harder on "an approve control was really clicked/Entered by a human",
  // so this is made an explicit, unit-tested invariant rather than an
  // implicit one. Pure predicate - the event-listener wiring itself lives
  // in terminal.js (_onGlobalKeydown, _onInputKeydown, the approve/reject
  // button click handlers all call this first and return early on false),
  // which is what a real DOM/event object is needed to exercise; this
  // function only needs `.isTrusted` to exist and be exactly `true`.
  function isTrustedInputEvent(e) {
    return !!(e && e.isTrusted === true);
  }

  return {
    isPasswordField,
    safeSameOriginHttpUrl,
    resolveClickNavTarget,
    checkClickTarget,
    classifyRuntimeNavigation,
    classifyOcclusionProbe,
    isTrustedInputEvent,
  };
});
