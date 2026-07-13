/**
 * axtree.js — indexed interactive-element extractor.
 *
 * Walks the DOM for interactive elements, filters to visible-only, and produces
 * a numbered list ("axtree") the local LLM can reference by integer index instead
 * of raw selectors/XPath. A live index -> element map lets the executor resolve
 * a model-chosen index back to a real node, re-verified as attached+visible
 * immediately before every execution (see executor.js).
 *
 * Visibility/interactivity heuristics are a deliberately simplified reimplementation
 * of the ideas in nanobrowser's content script DOM indexer
 * (reference/nanobrowser/chrome-extension/public/buildDomTree.js — Apache-2.0):
 *   - isElementVisible: offsetWidth/offsetHeight + computed display/visibility/opacity
 *   - isTopElement: elementFromPoint occlusion check at the element's center, so an
 *     element hidden behind a modal/overlay is not offered to the model
 *   - interactive-cursor-as-signal ("genius fix" per nanobrowser's comment): a
 *     computed cursor:pointer et al. is treated as strong evidence of interactivity
 *     even for elements that aren't semantically interactive tags
 *
 * M2.4 (iframe / shadow-DOM aware extraction): the extractor now also walks
 * SAME-ORIGIN iframes and OPEN shadow roots reachable from the top document,
 * recursively, so the model isn't blind to real controls living inside them
 * (and so the credential/click guards — which re-resolve against the live
 * element's OWN document/window, see frameOptsFor() below — apply there too).
 * HARD RULE, unchanged from the M1 scope note this replaces: cross-origin
 * iframes are never entered (same-origin policy makes this both correct and
 * unavoidable — `iframe.contentDocument` is null for them); a marker note is
 * emitted instead so the model/human at least knows one exists. CLOSED shadow
 * roots are never entered either — `el.shadowRoot` is null from outside a
 * closed root by design, so there is nothing to walk into; this extractor
 * only ever sees what `el.shadowRoot` actually exposes, same as any other
 * page script would. We do NOT reimplement nanobrowser's getEventListeners()
 * introspection or highlight-overlay rendering — out of scope.
 */
(function () {
  'use strict';

  window.LFL = window.LFL || {};

  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'searchbox', 'combobox', 'tab', 'menuitem',
    'checkbox', 'radio', 'switch', 'textbox', 'option', 'menuitemradio',
    'menuitemcheckbox', 'slider', 'spinbutton',
  ]);

  // Cursor styles that strongly suggest an element is meant to be interacted with,
  // even when the tag/role don't say so explicitly. Trimmed from nanobrowser's list.
  const INTERACTIVE_CURSORS = new Set([
    'pointer', 'grab', 'grabbing', 'cell', 'copy', 'context-menu', 'crosshair',
  ]);

  const CANDIDATE_SELECTOR =
    'a,button,input,select,textarea,' +
    '[role="button"],[role="link"],[role="searchbox"],[role="combobox"],' +
    '[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],' +
    '[role="switch"],[role="textbox"],[role="option"],' +
    '[onclick],[contenteditable="true"]';

  // Cross-origin same-tab iframes we recurse into a bounded number of levels
  // (pathological same-origin nesting is real but rare; this bound exists so
  // a runaway page structure can't blow the extraction budget/time before
  // the ~800-token cap even gets a chance to truncate it).
  const MAX_FRAME_DEPTH = 3;

  // ---- per-element document/window resolution (M2.4) ----
  //
  // Elements reached through a same-origin iframe belong to THAT iframe's own
  // Document/Window, not the top document's — using the ambient `document`/
  // `window`/`getComputedStyle`/`location` globals against such an element
  // would silently read/compare against the WRONG frame's viewport size,
  // baseURI, and origin. Every DOM-reading helper below that used to assume
  // the top document now derives its document/window from the element
  // itself. Shadow-DOM elements need no special-casing here: a shadow root
  // is a different NODE TREE but not a different Document, so
  // `el.ownerDocument` is already correct for them without changes.
  function ownerDoc(el) {
    return (el && el.ownerDocument) || document;
  }
  function ownerWin(el) {
    const doc = ownerDoc(el);
    return doc.defaultView || window;
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const win = ownerWin(el);
    const style = win.getComputedStyle(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.offsetWidth <= 0 && el.offsetHeight <= 0) {
      // offsetWidth/Height are 0 for inline elements too; fall back to a rect check.
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
    }
    try {
      if (typeof el.checkVisibility === 'function' &&
          !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
    } catch (_e) { /* checkVisibility unsupported — rely on the checks above */ }
    return true;
  }

  // nanobrowser's isTopElement, simplified to a single center-point occlusion
  // check. M2.4: the point/viewport/hit-test now all come from the element's
  // OWN document/window — getBoundingClientRect() on an in-iframe element is
  // relative to THAT iframe's viewport, not the top document's, so mixing
  // coordinate spaces (e.g. top-level elementFromPoint against an iframe-
  // relative rect) would silently misclassify occlusion for framed content.
  function isTopElement(el) {
    const doc = ownerDoc(el);
    const win = ownerWin(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), win.innerWidth - 1);
    const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), win.innerHeight - 1);
    let topEl;
    try {
      topEl = doc.elementFromPoint(cx, cy);
    } catch (_e) {
      return true; // fail open on the occlusion check, not on inclusion
    }
    if (!topEl) return false;
    let cur = topEl;
    while (cur) {
      if (cur === el) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isDisabled(el) {
    if ('disabled' in el && el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.hasAttribute('inert')) return true;
    return false;
  }

  function isInteractive(el) {
    if (isDisabled(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    if (el.hasAttribute('onclick')) return true;
    const style = ownerWin(el).getComputedStyle(el);
    if (style && INTERACTIVE_CURSORS.has(style.cursor)) return true;
    return false;
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'search') return 'searchbox';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'password') return 'textbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }

  function textOf(el, maxLen) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
  }

  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').trim();
    if (!ids) return '';
    const doc = ownerDoc(el);
    const parts = ids.split(/\s+/).map((id) => {
      const node = doc.getElementById(id);
      return node ? textOf(node, 60) : '';
    });
    return parts.filter(Boolean).join(' ');
  }

  function associatedLabelText(el) {
    if (el.labels && el.labels.length > 0) {
      return textOf(el.labels[0], 60);
    }
    if (el.id) {
      const doc = ownerDoc(el);
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return textOf(lbl, 60);
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return textOf(parentLabel, 60);
    return '';
  }

  // Accessible-name approximation (not a full ARIA accname computation — good
  // enough to disambiguate elements for the model without shipping page text
  // beyond the token budget).
  function accessibleName(el) {
    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return ariaLabel;
    const labelledBy = labelledByText(el);
    if (labelledBy) return labelledBy;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const assoc = associatedLabelText(el);
      if (assoc) return assoc;
      const placeholder = (el.getAttribute('placeholder') || '').trim();
      if (placeholder) return placeholder;
      // Deliberately NO el.value fallback here (see security review SHOULD-FIX
      // #5): an unlabeled field's live value would otherwise leak into the
      // prompt sent to the local model — worst case a password-manager-filled
      // password field with no aria-label/placeholder. type/placeholder/name
      // are enough to disambiguate a field for the model without ever
      // shipping its current value.
      const name = (el.getAttribute('name') || '').trim();
      if (name) return name;
      return '';
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    const title = (el.getAttribute('title') || '').trim();
    const text = textOf(el, 80);
    if (text) return text;
    if (title) return title;
    const value = (el.value || '').trim();
    return value;
  }

  function extraInfo(el) {
    const tag = el.tagName.toLowerCase();
    const bits = [];
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      bits.push(`type=${type}`);
      const ph = (el.getAttribute('placeholder') || '').trim();
      if (ph) bits.push(`placeholder="${ph}"`);
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      try {
        const abs = new URL(href, ownerDoc(el).baseURI);
        bits.push(`href-origin=${abs.origin}`);
      } catch (_e) { /* relative/invalid href, e.g. javascript: or # — skip */ }
    }
    if (el.ownerDocument !== document) bits.push('in-iframe');
    if (el.getRootNode && el.getRootNode() !== el.ownerDocument && el.getRootNode() !== document) bits.push('in-shadow-root');
    return bits.join(', ');
  }

  function makeEntry(el, index) {
    return {
      index,
      ref: new WeakRef(el),
      role: implicitRole(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      extra: extraInfo(el),
    };
  }

  function describeFrameSrc(frameEl) {
    try {
      const raw = frameEl.getAttribute('src') || '';
      const abs = new URL(raw, document.baseURI);
      return abs.origin;
    } catch (_e) {
      return '(unresolvable src)';
    }
  }

  // Recursively collects interactive elements from `root` (a Document or
  // ShadowRoot), then its open shadow roots, then its same-origin iframes —
  // appending to the shared `rawEntries`/`notes` arrays in document order so
  // the later index-assignment pass stays simple and stable.
  function collectFrom(root, rawEntries, notes, depth) {
    const nodes = root.querySelectorAll(CANDIDATE_SELECTOR);
    for (const el of nodes) {
      if (!isElementVisible(el)) continue;
      if (!isTopElement(el)) continue;
      if (!isInteractive(el)) continue;
      rawEntries.push(el);
    }

    // Open shadow roots reachable from this root. `el.shadowRoot` is null
    // for closed roots when read from outside — including from our own
    // content script, which never attached them — so this walk naturally
    // never enters a closed root; there is nothing more to do to "skip" it.
    const allEls = root.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        collectFrom(el.shadowRoot, rawEntries, notes, depth);
      }
    }

    // Same-origin iframes reachable from this root.
    if (depth < MAX_FRAME_DEPTH) {
      const frames = root.querySelectorAll('iframe, frame');
      for (const f of frames) {
        let doc = null;
        try {
          doc = f.contentDocument;
        } catch (_e) {
          doc = null; // cross-origin — SecurityError or null, either way: skip
        }
        if (doc) {
          collectFrom(doc, rawEntries, notes, depth + 1);
        } else {
          notes.push(`(cross-origin iframe present, not inspectable: ${describeFrameSrc(f)})`);
        }
      }
    } else {
      const frames = root.querySelectorAll('iframe, frame');
      if (frames.length > 0) {
        notes.push(`(${frames.length} nested iframe(s) beyond max depth ${MAX_FRAME_DEPTH}, not inspected)`);
      }
    }
  }

  /**
   * Build the current live index -> element map for interactive, visible
   * elements across the top document, same-origin iframes, and open shadow
   * roots. Rebuilt fresh on every command per spec (elements/indices can
   * change between commands as the page mutates).
   */
  function build() {
    const rawEntries = [];
    const notes = [];
    collectFrom(document, rawEntries, notes, 0);

    const entries = [];
    let index = 0;
    for (const el of rawEntries) {
      index += 1;
      entries.push(makeEntry(el, index));
    }
    const map = new Map();
    for (const e of entries) map.set(e.index, e.ref);
    return { entries, map, notes };
  }

  /**
   * Serialize entries (plus any informational notes, e.g. cross-origin
   * iframe markers) to the numbered-list text the LLM sees, hard-capped at
   * maxChars (~800 tokens ≈ 3200 chars per spec), with explicit truncation
   * notice. Notes are only appended if the indexed-element list itself
   * wasn't already truncated — actionable elements take priority over
   * informational markers within the fixed budget.
   */
  function serialize(entries, maxChars, notes) {
    const cap = maxChars || 3200;
    const lines = [];
    let used = 0;
    let cutAt = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const extra = e.extra ? ` (${e.extra})` : '';
      const line = `[${e.index}] ${e.role} "${e.name}"${extra}`;
      if (used + line.length + 1 > cap) {
        cutAt = i;
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (cutAt >= 0) {
      const remaining = entries.length - cutAt;
      lines.push(`…(${remaining} more elements truncated)`);
    } else if (notes && notes.length) {
      let noteCutAt = -1;
      for (let i = 0; i < notes.length; i++) {
        const line = notes[i];
        if (used + line.length + 1 > cap) {
          noteCutAt = i;
          break;
        }
        lines.push(line);
        used += line.length + 1;
      }
      if (noteCutAt >= 0) {
        lines.push(`…(${notes.length - noteCutAt} more notes truncated)`);
      }
    }
    return lines.join('\n');
  }

  function resolve(map, index) {
    const ref = map.get(index);
    if (!ref) return null;
    const el = ref.deref ? ref.deref() : ref;
    if (!el) return null;
    if (!el.isConnected) return null;
    if (!isElementVisible(el)) return null;
    return el;
  }

  // M2.4: per-frame guard context. An element resolved from inside a
  // same-origin iframe must have click/fill/select guards (guards.js) run
  // against THAT iframe's own baseURI/origin, not the top page's — this is
  // the "re-run the guard on the live element in its own document context"
  // requirement. Elements from the top document (the overwhelmingly common
  // case) get identical values to the old ambient-global behavior, so this
  // is a pure superset, not a behavior change for M1-era callers.
  function frameOptsFor(el) {
    if (!el) return undefined;
    const doc = ownerDoc(el);
    const win = ownerWin(el);
    return { baseURI: doc.baseURI, origin: win.location.origin };
  }

  window.LFL.axtree = {
    build, serialize, resolve, isElementVisible, isTopElement, isInteractive,
    accessibleName, implicitRole, frameOptsFor,
  };
})();
