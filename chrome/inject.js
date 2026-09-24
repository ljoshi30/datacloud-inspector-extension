/* ============================================================================
 * Data 360 Mapping Inspector — INLINE DECORATOR
 * ----------------------------------------------------------------------------
 * Renders each field's API (developer) name in grey directly UNDER its label,
 * inside the real mapping canvas — no separate panel.
 *
 * What we confirmed via recon:
 *  - Canvas is deep LWC shadow DOM.
 *  - SOURCE (DLO) API names live on <runtime_cdp-data-stream-attribute-list>
 *    as ATTRIBUTE NAMES, in the same order the rows render. -> decorate by
 *    order-zip, zero network.
 *  - TARGET (DMO) API names are NOT in the DOM as attributes. We attempt to
 *    read them from the list-item LWC properties; if that's blocked, source is
 *    still decorated and we dump the first target item's property shape to the
 *    console + on-page box so the target side can be finished.
 *
 * Injection is LWC-safe: we set a data-dc-api attribute on the row container
 * and add ONE <style> per shadow root that renders it via ::after. We do NOT
 * insert element nodes into LWC-managed trees (which would trip reconciliation).
 * A debounced MutationObserver re-applies after re-renders / scrolling.
 *
 * Paste whole file into DevTools Console, Enter. Re-paste to toggle off/on.
 * Read-only w.r.t. data; only adds attributes + <style> nodes. Safe.
 * ==========================================================================*/
(function () {
  "use strict";
  // Re-running the bookmarklet acts as a TOGGLE for the whole tool: if it's
  // already loaded, remove it entirely (bar, tooltip, tags, modal, timers).
  //
  // BUT: this is a Lightning SPA. If the user injected on page A (e.g. Query Editor),
  // then navigated in-tab to page B (e.g. a Data Stream), watchNavigation() tears down
  // the FAB yet the global guard may still be set. A second bookmark click on page B
  // must RE-DETECT page B — not just toggle off. So: if the URL changed since we loaded,
  // tear down the stale UI and FALL THROUGH to re-run detection for the new page. Only a
  // re-click on the SAME url is a true toggle-off.
  if (window.__DC_DECOR__) {
    var _prevUrl = "";
    try { _prevUrl = window.__DC_DECOR__.loadUrl || ""; } catch (e) {}
    var _curUrl = ""; try { _curUrl = location.href; } catch (e) {}
    try { window.__DC_DECOR__.teardown(); } catch (e) {}
    if (_prevUrl === _curUrl) return;   // same page → toggle off
    // else: navigated → teardown done, continue to re-initialize for the new page
  }

  const API_ATTR = /^[A-Za-z0-9_]+__(c|dll|dlm)$/;      // attribute-name is an API name
  const API_VAL = /^[A-Za-z0-9_]+__(c|dll|dlm)$/;       // a value that is a bare API name
  const HEADER = /\(\d+\)\s*$/;                          // "Is Mapped (15)" / "Unmapped (25)"
  const SRC_LIST = "runtime_cdp-data-stream-attribute-list";
  const SRC_CONTAINER = "runtime_cdp-data-stream-source-entity-list";
  const TGT_CONTAINER = "runtime_cdp-data-stream-target-entity-list";
  const ITEM = "runtime_cdp-data-stream-attribute-list-item";
  const TABLE_CMP = "runtime_cdp-data-mapper-table";
  const TAGGING_CMP = "runtime_cdp-data-stream-tagging-container";

  // ---------- shadow-aware traversal ----------
  function eachElement(root, fn) {
    let els;
    try { els = root.querySelectorAll("*"); } catch (e) { return; }
    for (const el of els) {
      fn(el);
      let sr = null; try { sr = el.shadowRoot; } catch (e) {}
      if (sr) eachElement(sr, fn);
    }
  }
  function tagOf(el) { try { return el.tagName.toLowerCase(); } catch (e) { return ""; } }
  // Guards against Lightning's OLD-page components after in-app navigation:
  // they can stay in the DOM (isConnected true) but HIDDEN. So we check actual
  // visibility (has a layout box) — a hidden cached view has zero size. This is
  // what makes Refresh reflect the CURRENT mapping, not the previous one.
  function isLive(el) { try { return el.isConnected !== false; } catch (e) { return true; } }
  function isVisible(el) {
    try {
      if (el.isConnected === false) return false;
      const r = el.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    } catch (e) { return true; }
  }
  function findByTag(tag) {
    const out = [];
    eachElement(document, (el) => { if (tagOf(el) === tag && isLive(el)) out.push(el); });
    return out;
  }
  // Same as findByTag but keeps only currently-VISIBLE matches (used for the
  // export/list build so stale hidden pages are excluded).
  function findVisibleByTag(tag) { return findByTag(tag).filter(isVisible); }
  // items scoped under a given ancestor element (crossing shadow).
  // NOTE: we must collect items GLOBALLY (findByTag descends into every
  // element's shadowRoot from document), then keep only those whose
  // shadow-ancestry passes through `ancestor`. Walking from `ancestor` alone
  // misses rows that live inside ancestor's OWN shadowRoot.
  function itemsUnder(ancestor) {
    if (!ancestor) return [];
    return findByTag(ITEM).filter((it) => isDescendant(it, ancestor));
  }
  // True if `node` sits anywhere under `ancestor`, crossing shadow boundaries.
  // At a shadow-root boundary parentNode is null, so we hop to the root's host.
  function isDescendant(node, ancestor) {
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 400) {
      if (cur === ancestor) return true;
      if (cur.parentNode) { cur = cur.parentNode; continue; }
      let host = null;
      try { const r = cur.getRootNode && cur.getRootNode(); host = r && r.host; } catch (e) {}
      cur = host || null;
    }
    return false;
  }

  // API (developer) names in DOM order from an attribute-list element's
  // attribute NAMES (source side stores them there).
  function attrApiNames(listEl) {
    let names = [];
    try { names = Array.from(listEl.attributes).map((a) => a.name); } catch (e) {}
    return names.filter((n) => API_ATTR.test(n));
  }

  // Walk up (crossing shadow boundaries) to the nearest ancestor of a tag.
  function ancestorOfTag(node, tag) {
    let cur = node, guard = 0;
    while (cur && guard++ < 400) {
      if (tagOf(cur) === tag) return cur;
      if (cur.parentNode) { cur = cur.parentNode; continue; }
      let host = null; try { const r = cur.getRootNode && cur.getRootNode(); host = r && r.host; } catch (e) {}
      cur = host || null;
    }
    return null;
  }

  function labelOf(item) {
    try { return item.getAttribute("data-tid") || ""; } catch (e) { return ""; }
  }

  // ---------- LWC property introspection (for target API names) ----------
  function scanVal(k, v, found) {
    if (typeof v === "string") { if (API_VAL.test(v)) found[k] = v; return; }
    if (v && typeof v === "object") {
      try { const j = JSON.stringify(v); if (j && /__(c|dll|dlm)\b/.test(j)) found[k] = j.slice(0, 240); } catch (e) {}
    }
  }
  function introspect(el) {
    const found = {};
    try { for (const k of Object.keys(el)) scanVal(k, safeGet(el, k), found); } catch (e) {}
    let proto = Object.getPrototypeOf(el), depth = 0;
    while (proto && depth++ < 8) {
      let ks = [];
      try { ks = Object.getOwnPropertyNames(proto); } catch (e) {}
      for (const k of ks) {
        if (k === "constructor" || found[k]) continue;
        let d; try { d = Object.getOwnPropertyDescriptor(proto, k); } catch (e) { continue; }
        if (d && typeof d.get === "function") scanVal(k, safeGet(el, k), found);
      }
      proto = Object.getPrototypeOf(proto);
    }
    return found;
  }
  function safeGet(el, k) { try { return el[k]; } catch (e) { return undefined; } }

  // Build a label->apiName map from an element's LWC `.entity.fields[]` (each
  // field has `.label` + `.name`). Works for any list element that exposes it.
  // Matching BY LABEL is inherently section-order-proof — a row is looked up by
  // its label, so how the UI groups rows (Is Mapped / Unmapped) never matters.
  function entityFieldMap(el) {
    const map = new Map();      // label -> api name (FIRST field per label; unchanged)
    const typeMap = new Map();  // label -> data type (e.g. Text, DateTime, Number)
    const labelNames = new Map(); // label -> [ALL api names with that label, in field order]
    let entityName = null;
    try {
      const entity = safeGet(el, "entity");
      if (entity) {
        entityName = safeGet(entity, "name") || null;
        const fields = safeGet(entity, "fields");
        if (fields && typeof fields.length === "number") {
          for (let i = 0; i < fields.length; i++) {
            const f = safeGet(fields, i);
            if (!f) continue;
            const label = safeGet(f, "label");
            const name = safeGet(f, "name");
            if (label != null && typeof name === "string" && name) {
              // labelNames keeps EVERY field (used to disambiguate colliding labels)
              const arr = labelNames.get(label); if (arr) arr.push(name); else labelNames.set(label, [name]);
              if (!map.has(label)) {
                map.set(label, name);
                const ty = safeGet(f, "type");
                if (ty != null) typeMap.set(label, String(ty));
              }
            }
          }
        }
      }
    } catch (e) {}
    return { map, typeMap, labelNames, entityName };
  }

  // TARGET side: each <runtime_cdp-data-stream-target-entity-list> carries the
  // field map. Scoped PER LIST — labels collide across DMOs, so scoping to each
  // DMO's own list is what disambiguates them.
  function targetLists() {
    return findByTag(TGT_CONTAINER).map((listEl) => {
      const { map, labelNames, entityName } = entityFieldMap(listEl);
      return { listEl, map, labelNames, entityName };
    });
  }

  // Resolve a row's api name from a label->name map, tolerating whitespace
  // differences (DOM labels can be truncated/renormalized vs entity.fields).
  function lookupByLabel(map, label) {
    let name = map.get(label);
    if (name) return name;
    const norm = String(label).replace(/\s+/g, " ").trim();
    for (const [k, v] of map) { if (String(k).replace(/\s+/g, " ").trim() === norm) return v; }
    return null;
  }

  // Set of "entityName::fieldApi" pairs that are ACTUALLY mapped, read from the
  // authoritative container.mapping[] (same data the export + table view use).
  // `side` = "target" (target.entityName::target.fieldName, DMO) or "source"
  // (source.entityName::source.fieldName, DLO). Used to disambiguate colliding
  // labels on either side — see makeCollisionResolver.
  function mappedFieldSet(side) {
    const key = side === "source" ? "source" : "target";
    const set = new Set();
    try {
      const cont = findByTag(TAGGING_CMP).find(isVisible) || findByTag(TAGGING_CMP)[0];
      const raw = cont && safeGet(cont, "mapping");
      if (Array.isArray(raw)) {
        for (const it of raw) {
          const node = it && safeGet(it, key);
          const en = node && safeGet(node, "entityName");
          const fn = node && safeGet(node, "fieldName");
          if (en && fn) set.add(en + "::" + fn);
        }
      }
    } catch (e) {}
    return set;
  }
  function mappedTargetSet() { return mappedFieldSet("target"); }
  function mappedSourceSet() { return mappedFieldSet("source"); }

  // Collision resolver — fixes the label-collision bug on BOTH sides of the canvas.
  // An entity (DLO or DMO) can carry TWO+ fields with the SAME label (DMO: "Birth
  // Date" = ssot__BirthDate__c AND BirthDt__c; DLO: three "Account Number" fields).
  // Matching purely by label returned the FIRST field, which is often the standard
  // (unmapped) one, not the field the stream actually maps to. The lists also
  // render "Is Mapped" BEFORE "Unmapped", so a plain render-order cursor still
  // mispicks — so for a colliding label we order candidates MAPPED-FIRST (via the
  // authoritative mapping set), then hand successive rendered rows the next
  // candidate. Returns {api, sure}; sure=false when it genuinely can't
  // disambiguate (e.g. two DIFFERENT mapped fields share the label, or a collision
  // where none is mapped) so the caller can flag it "(?)" instead of lying.
  //   labelNames : Map<label, [apiName,...]> from entityFieldMap()
  //   mset       : mappedTargetSet() / mappedSourceSet()
  //   entityApi  : entity.name of the list this resolver serves
  function makeCollisionResolver(labelNames, mset, entityApi) {
    const cursor = new Map();
    return function next(label) {
      let arr = labelNames.get(label);
      if (!arr) {
        const norm = String(label).replace(/\s+/g, " ").trim();
        for (const [k, v] of labelNames) { if (String(k).replace(/\s+/g, " ").trim() === norm) { arr = v; label = k; break; } }
      }
      if (!arr || !arr.length) return null;
      const distinct = Array.from(new Set(arr));
      if (distinct.length === 1) return { api: distinct[0], sure: true }; // unique / all identical
      const mapped = arr.filter((a) => mset.has(entityApi + "::" + a));
      const unmapped = arr.filter((a) => !mset.has(entityApi + "::" + a));
      const ordered = mapped.concat(unmapped);
      const used = cursor.get(label) || 0;
      const idx = used < ordered.length ? used : ordered.length - 1; // clamp; never overrun
      cursor.set(label, used + 1);
      const bucket = idx < mapped.length ? mapped : unmapped;
      return { api: ordered[idx], sure: Array.from(new Set(bucket)).length === 1 };
    };
  }
  // Back-compat alias (target loop calls this name).
  function makeTargetResolver(labelNames, mset, dmoApi) { return makeCollisionResolver(labelNames, mset, dmoApi); }

  // ---------- decoration ----------
  // We render the api name as a REAL <span> child (not a CSS ::after) so the
  // text is selectable & copyable. One <style> per shadow root makes the row
  // wrap so the span sits on its own line BELOW the label. Inserting a node
  // into the LWC-managed row can be undone by a re-render, but the debounced
  // MutationObserver re-runs redraw() and self-heals; decorate() is idempotent.
  // ---------- HOVER TOOLTIP (zero canvas impact) ----------
  // We insert NOTHING into the mapping rows — that is the only way to guarantee
  // the connector SVG lines never move. Instead we tag each field/header host
  // with the api name via a JS property (dcApiName) + a data attribute, and a
  // single body-level tooltip shows it on hover. No row reflow, ever.
  let tipEl = null, tipHideT = null;
  function ensureTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement("div");
    tipEl.id = "dc-tip";
    tipEl.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;display:none;" +
      "background:#16325c;color:#fff;font:12px/1.3 'SF Mono',Menlo,Consolas,monospace;" +
      "padding:5px 9px;border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.3);max-width:60vw;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function showTip(text, x, y, hint) {
    const t = ensureTip();
    if (tipHideT) { clearTimeout(tipHideT); tipHideT = null; }
    // main name + a dim "click to copy" hint line
    t.innerHTML = "";
    const nameLine = document.createElement("div");
    nameLine.textContent = text;
    nameLine.style.cssText = "white-space:nowrap";
    t.appendChild(nameLine);
    const hintLine = document.createElement("div");
    hintLine.textContent = hint || "click field to copy";
    hintLine.style.cssText = "margin-top:2px;font-size:10px;opacity:.7";
    t.appendChild(hintLine);
    t.style.display = "block";
    let nx = x + 12, ny = y + 14;
    const w = t.offsetWidth || 200, h = t.offsetHeight || 34;
    if (nx + w > window.innerWidth - 6) nx = Math.max(6, window.innerWidth - w - 6);
    if (ny + h > window.innerHeight - 6) ny = y - h - 10;
    t.style.left = nx + "px"; t.style.top = ny + "px";
  }
  function hideTip() { if (tipEl) { tipEl.style.display = "none"; } }
  // Fully remove the tooltip element from the DOM (used when turning OFF).
  function removeTip() {
    if (tipHideT) { clearTimeout(tipHideT); tipHideT = null; }
    if (tipEl) { try { tipEl.remove(); } catch (e) {} tipEl = null; }
  }

  // One delegated hover handler on the document catches mouseover for any
  // tagged host (crossing shadow via composedPath). Registered once.
  let hoverBound = false;
  function bindHover() {
    if (hoverBound) return; hoverBound = true;
    const onOver = (e) => {
      if (!state.on) return;
      let name = null;
      const path = (e.composedPath && e.composedPath()) || [];
      let uncertain = false;
      for (const n of path) {
        if (n && n.nodeType === 1) {
          const v = n.dcApiName || (n.getAttribute && n.getAttribute("data-dc-api-name"));
          if (v) { name = v; uncertain = !!(n.dcUncertain || (n.getAttribute && n.getAttribute("data-dc-uncertain"))); break; }
        }
      }
      if (name) showTip(name + (uncertain ? " (?)" : ""), e.clientX, e.clientY, uncertain ? "duplicate label — verify; click to copy" : null);
      else hideTip();
    };
    const onMove = (e) => {
      if (!state.on || !tipEl || tipEl.style.display === "none") return;
      // keep following the cursor while over a tagged element
      const path = (e.composedPath && e.composedPath()) || [];
      let name = null, uncertain = false;
      for (const n of path) { if (n && n.nodeType === 1) { const v = n.dcApiName || (n.getAttribute && n.getAttribute("data-dc-api-name")); if (v) { name = v; uncertain = !!(n.dcUncertain || (n.getAttribute && n.getAttribute("data-dc-uncertain"))); break; } } }
      if (name) showTip(name + (uncertain ? " (?)" : ""), e.clientX, e.clientY, uncertain ? "duplicate label — verify; click to copy" : null); else hideTip();
    };
    // Click the field label/name to COPY its api name. We only act when the
    // click path contains a tagged host AND does NOT contain the mapping dot /
    // a button — so we never hijack Salesforce's own row controls.
    const onClick = (e) => {
      if (!state.on) return;
      const path = (e.composedPath && e.composedPath()) || [];
      let name = null, onControl = false;
      for (const n of path) {
        if (!n || n.nodeType !== 1) continue;
        const tag = (n.tagName || "").toLowerCase();
        if (tag === "button" || tag === "a" || tag === "input" || tag === "lightning-icon" || tag === "lightning-primitive-icon") onControl = true;
        let cls = ""; try { cls = (n.getAttribute && n.getAttribute("class")) || ""; } catch (e) {}
        if (/socket|toggle|checkbox|slds-icon|dot|handle/i.test(cls)) onControl = true;
        let v = null; try { v = n.dcApiName || (n.getAttribute && n.getAttribute("data-dc-api-name")); } catch (e) {}
        if (v && !name) name = v;
      }
      if (name && !onControl) {
        try {
          navigator.clipboard.writeText(name).then(() => {
            showTip(name, e.clientX, e.clientY, "✓ Copied!");
            if (tipHideT) clearTimeout(tipHideT);
            tipHideT = setTimeout(hideTip, 900);
          }).catch(() => {});
        } catch (err) {}
        // don't preventDefault/stop — let Salesforce still do its thing on the
        // label if it wants; copying is a side benefit, not a hijack.
      }
    };
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseout", (e) => { if (tipHideT) clearTimeout(tipHideT); tipHideT = setTimeout(hideTip, 60); }, true);
    document.addEventListener("click", onClick, true);
  }

  // Tag a field row's host with its api name (no visible node inserted).
  // `uncertain` (target side only): the api name is a best-effort pick for a
  // colliding label we couldn't fully disambiguate. We still store the CLEAN name
  // (so click-to-copy copies a real, usable api name), but the hover tooltip shows
  // a " (?)" suffix via the data-dc-uncertain flag so the user knows to verify.
  function decorate(item, apiName, uncertain) {
    if (!apiName) return false;
    let sr = null; try { sr = item.shadowRoot; } catch (e) {}
    if (!sr) return false;
    let host = null;
    try { host = sr.querySelector("h4.name, h4, .root, [data-tid='main-container']"); } catch (e) {}
    if (!host) host = item; // fall back to the row host itself
    try {
      host.dcApiName = apiName;
      if (host.setAttribute) host.setAttribute("data-dc-api-name", apiName);
      // also tag the item host so hovering anywhere on the row works
      item.dcApiName = apiName;
      if (item.setAttribute) item.setAttribute("data-dc-api-name", apiName);
      if (uncertain) { host.dcUncertain = true; item.dcUncertain = true; if (host.setAttribute) host.setAttribute("data-dc-uncertain", "1"); if (item.setAttribute) item.setAttribute("data-dc-uncertain", "1"); }
      else { host.dcUncertain = false; item.dcUncertain = false; if (host.removeAttribute) host.removeAttribute("data-dc-uncertain"); if (item.removeAttribute) item.removeAttribute("data-dc-uncertain"); }
      if (host.style && host.style.setProperty) host.style.setProperty("cursor", "help", "important");
    } catch (e) { return false; }
    return true;
  }
  // Tag an entity header (<h3>) with its api name.
  function decorateHeader(listEl, apiName) {
    if (!apiName) return false;
    let sr = null; try { sr = listEl.shadowRoot; } catch (e) {}
    if (!sr) return false;
    let h = null;
    try { h = sr.querySelector("h3.entity-label, h3.slds-text-title_bold"); } catch (e) {}
    if (!h) return false;
    try {
      h.dcApiName = apiName;
      if (h.setAttribute) h.setAttribute("data-dc-api-name", apiName);
      if (h.style && h.style.setProperty) h.style.setProperty("cursor", "help", "important");
    } catch (e) { return false; }
    return true;
  }
  // Remove all tags (used when toggled off).
  function clearTags() {
    eachElement(document, (el) => {
      try {
        if (el.dcApiName != null) { try { delete el.dcApiName; } catch (e) { el.dcApiName = null; } }
        if (el.hasAttribute && el.hasAttribute("data-dc-api-name")) el.removeAttribute("data-dc-api-name");
        if (el.dcUncertain != null) { try { delete el.dcUncertain; } catch (e) { el.dcUncertain = null; } }
        if (el.hasAttribute && el.hasAttribute("data-dc-uncertain")) el.removeAttribute("data-dc-uncertain");
      } catch (e) {}
    });
    removeTip(); // fully remove the tooltip element (Hide API names)
  }

  // Remove ALL decoration (hover tags + inline spans). Used by teardown.
  function undecorateAll() { clearTags(); clearInline(); }

  // ---------- INLINE MODE (visible + Ctrl+F searchable) ----------
  // Separate from hover: injects a small selectable <span> AFTER the field
  // label so the api name is visible in the DOM (findable via browser search).
  // FIELDS ONLY — never headers (header decoration reflowed a different wrapper
  // and distorted the canvas). Pure inline + small explicit line-height keeps
  // the row's line-box height unchanged, so ◉ anchors / connector lines don't
  // move. Idempotent; a MutationObserver-driven redraw re-applies after renders.
  function inlineDecorate(item, apiName, uncertain) {
    if (!apiName) return false;
    const shownName = apiName + (uncertain ? " (?)" : ""); // display marker; copy/title stays clean
    let sr = null; try { sr = item.shadowRoot; } catch (e) {}
    if (!sr) return false;
    let labelEl = null;
    try { labelEl = sr.querySelector("h4.name, h4"); } catch (e) {}
    if (!labelEl) return false; // fields-only anchor
    // Anchor to .root (the row wrapper), NOT the h4 label. probeRow() proved the
    // ◉ dot (span.mappingTargetIconContainer) is position:absolute anchored to
    // .root (already position:relative). Setting position:relative on the h4
    // STOLE that anchor → the dot shifted (worst on Primary Key). By appending an
    // OUT-OF-FLOW span to .root and NEVER touching the h4 or .root's own styles,
    // the dot's anchor and the row height are both untouched → nothing moves on
    // any row. We do NOT resize the label (shrinking it collapsed rows: 2000px+
    // drift). Placed by MEASUREMENT at 9px into the ~9px gap below the label.
    let root = null;
    try { root = sr.querySelector(".root, .normal-border"); } catch (e) {}
    if (!root) { try { root = labelEl.parentElement; } catch (e) {} }
    if (!root) return false;
    try {
      let span = root.querySelector(":scope > .dc-api-inline");
      if (span && span.textContent === shownName) return true;
      if (!span) {
        span = document.createElement("span");
        span.className = "dc-api-inline";
        span.addEventListener("mousedown", (e) => e.stopPropagation());
        span.addEventListener("click", (e) => e.stopPropagation());
        root.appendChild(span);
      }
      span.textContent = shownName;
      const set = (p, v) => { try { span.style.setProperty(p, v, "important"); } catch (e) {} };
      set("position", "absolute"); set("display", "block"); set("line-height", "1");
      set("font-family", "'SF Mono',Menlo,Consolas,monospace"); set("font-size", "9px");
      set("color", "#4a6fa5"); set("padding", "0"); set("margin", "0");
      set("white-space", "nowrap"); set("pointer-events", "auto"); set("z-index", "2");
      set("user-select", "text"); set("-webkit-user-select", "text");
      // Place by MEASUREMENT: sit the name just under the label text, aligned to
      // the label's left, 2px lifted so it clears the row divider.
      try {
        const rr = root.getBoundingClientRect();
        const lr = labelEl.getBoundingClientRect();
        const top = Math.max(0, Math.round(lr.bottom - rr.top) - 2);
        const left = Math.max(0, Math.round(lr.left - rr.left));
        set("top", top + "px"); set("left", left + "px");
      } catch (e) { set("top", "22px"); set("left", "14px"); } // measured fallbacks
      try { span.setAttribute("title", apiName); } catch (e) {}
    } catch (e) { return false; }
    return true;
  }
  function clearInline() {
    eachElement(document, (el) => {
      try {
        if (el.classList && (el.classList.contains("dc-api-inline") ||
            el.classList.contains("dc-tapi-inline") || el.classList.contains("dc-sapi-inline")))
          el.remove();
      } catch (e) {}
    });
    // also clear table hover tags
    const tableCmp = findByTag(TABLE_CMP)[0];
    if (tableCmp) {
      let tsr = null; try { tsr = tableCmp.shadowRoot; } catch (e) {}
      if (tsr) {
        try {
          for (const el of Array.from(tsr.querySelectorAll("[data-dc-api-name]"))) {
            try { el.removeAttribute("data-dc-api-name"); el.dcApiName = null; el.style.removeProperty("cursor"); } catch (e) {}
          }
        } catch (e) {}
      }
    }
  }

  // ===== TABLE VIEW (runtime_cdp-data-mapper-table) =====
  // Source API names are shown natively in <span class="source-field"> inside <th>.
  // Target side shows only a label via lightning-grouped-combobox — no API name.
  // Data source: container.mapping[] → source.fieldName, target.entityName, target.fieldName.
  //
  // DMO detection order:
  //   1. entity selector combobox inputText (set when user picks from dropdown)
  //   2. entity selector .value prop (sometimes holds selected value)
  //   3. "Data Model: X" header span inside table shadow root (pre-selected / default)
  //   4. only one unique target entity in mapping[] (unambiguous)
  //
  // DLO change (Search Data Lake Objects bar): container.mapping[] reloads automatically;
  // the 1.2s poll re-reads it and re-decorates.

  function tableEntitySelectorInfo() {
    let inputText = "", value = "", items = [];
    eachElement(document, (el) => {
      if (tagOf(el) !== "lightning-grouped-combobox") return;
      let id = ""; try { id = el.getAttribute("id") || ""; } catch (e) {}
      if (!/target-entity-selector/i.test(id)) return;
      const it = safeGet(el, "inputText"); if (it && String(it).trim()) inputText = String(it).trim();
      const v  = safeGet(el, "value");     if (v  && typeof v === "string" && v.trim()) value = String(v).trim();
      const it2 = safeGet(el, "items"); if (Array.isArray(it2)) items = it2;
    });
    // Build label→apiName and apiName set from items
    const labelToApi = new Map();
    const apiSet = new Set();
    for (const item of items) {
      if (!item) continue;
      const t = safeGet(item, "text"); const v = safeGet(item, "value");
      if (t && v) { labelToApi.set(String(t).trim(), String(v)); apiSet.add(String(v)); }
    }
    return { inputText, value, labelToApi, apiSet };
  }

  // Returns the current DMO entityName (API name) to filter on, or null.
  function tableSelectedDmo() {
    const { inputText, value, labelToApi, apiSet } = tableEntitySelectorInfo();

    // 1. inputText set by user interaction
    if (inputText) {
      if (apiSet.has(inputText)) return inputText;
      const a = labelToApi.get(inputText); if (a) return a;
    }
    // 2. .value prop directly
    if (value) {
      if (apiSet.has(value)) return value;
      const a = labelToApi.get(value); if (a) return a;
    }

    // 3. "Data Model: X" header span inside table shadow root
    const tableCmp = findByTag(TABLE_CMP).find(isVisible);
    if (tableCmp) {
      let tsr = null; try { tsr = tableCmp.shadowRoot; } catch (e) {}
      if (tsr) {
        let spans; try { spans = Array.from(tsr.querySelectorAll("span")); } catch (e) { spans = []; }
        for (const sp of spans) {
          const t = (sp.textContent || "").trim();
          if (!t.startsWith("Data Model:")) continue;
          const label = t.replace(/^Data Model:\s*/, "").trim();
          if (!label) continue;
          const a = labelToApi.get(label); if (a) return a;
          // items not loaded yet — match by label text directly as partial key
          // try fuzzy: find apiSet member whose last segment matches label
          for (const api of apiSet) {
            const seg = api.replace(/__dlm$/, "").replace(/^ssot__/, "").replace(/__/g, " ");
            if (seg.toLowerCase() === label.toLowerCase()) return api;
          }
          // store label as-is so export can use it even without API name
          return "__LABEL__:" + label;
        }
      }
    }

    // 4. If only one unique target entity in mapping, use that
    const container = findByTag(TAGGING_CMP).find(isVisible) || findByTag(TAGGING_CMP)[0];
    if (container) {
      const raw = safeGet(container, "mapping");
      if (Array.isArray(raw)) {
        const entities = new Set();
        for (const item of raw) { const t = safeGet(item, "target"); const e = t && safeGet(t, "entityName"); if (e) entities.add(e); }
        if (entities.size === 1) return Array.from(entities)[0];
      }
    }
    return null;
  }

  // Build srcNorm → [{dmo, tgt, srcFull}] from container.mapping[].
  // srcNorm = fieldName with __c suffix stripped (matches text in span.source-field).
  function buildTableMap() {
    const container = findByTag(TAGGING_CMP).find(isVisible) || findByTag(TAGGING_CMP)[0];
    if (!container) return new Map();
    const raw = safeGet(container, "mapping");
    if (!Array.isArray(raw)) return new Map();
    const map = new Map();
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const src = safeGet(item, "source"); const tgt = safeGet(item, "target");
      if (!src || !tgt) continue;
      const srcName = safeGet(src, "fieldName"); const dmoName = safeGet(tgt, "entityName"); const tgtName = safeGet(tgt, "fieldName");
      if (!srcName || !dmoName || !tgtName) continue;
      const norm = String(srcName).replace(/__c$/, "");
      if (!map.has(norm)) map.set(norm, []);
      map.get(norm).push({ dmo: dmoName, tgt: tgtName, srcFull: String(srcName) });
    }
    return map;
  }

  // Inject source + target API names into table rows.
  // Called for both inline and hover modes. Clears all stale spans first so
  // a DMO or DLO switch always shows fresh data.
  function tableRedraw() {
    const tableCmp = findByTag(TABLE_CMP).find(isVisible);
    if (!tableCmp) return;
    let sr = null; try { sr = tableCmp.shadowRoot; } catch (e) {}
    if (!sr) return;

    // Always clear first so DMO/DLO changes show fresh data
    try {
      for (const old of Array.from(sr.querySelectorAll(".dc-sapi-inline,.dc-tapi-inline"))) { try { old.remove(); } catch (e) {} }
    } catch (e) {}

    const tableMap = buildTableMap();
    if (!tableMap.size) return;
    const rawDmo = tableSelectedDmo();
    // resolve "__LABEL__:X" placeholder — means we detected the label but couldn't
    // map to an API name; filter loosely by checking entry dmo contains the label
    const selectedDmo = (rawDmo && rawDmo.startsWith("__LABEL__:")) ? null : rawDmo;
    const selectedDmoLabel = (rawDmo && rawDmo.startsWith("__LABEL__:")) ? rawDmo.slice(10) : null;

    let rows; try { rows = Array.from(sr.querySelectorAll("tr")); } catch (e) { return; }
    for (const row of rows) {
      // source span lives inside <th>
      let srcSpan = null; try { srcSpan = row.querySelector("span.source-field"); } catch (e) {}
      if (!srcSpan) continue;
      const srcNorm = (srcSpan.textContent || "").trim();
      if (!srcNorm) continue;

      const allEntries = tableMap.get(srcNorm) || [];
      // filter to current DMO for the TARGET side
      let entries;
      if (selectedDmo) {
        entries = allEntries.filter((e) => e.dmo === selectedDmo);
      } else if (selectedDmoLabel) {
        const ll = selectedDmoLabel.toLowerCase().replace(/\s+/g, "");
        entries = allEntries.filter((e) => e.dmo.toLowerCase().replace(/_/g, "").indexOf(ll) >= 0);
      } else {
        entries = allEntries;
      }

      // SOURCE API name: use full fieldName from mapping if available,
      // otherwise the span text is already the field name base — show it as-is.
      // This means ALL rows get a source annotation, not just mapped ones.
      const srcFull = entries.length ? entries[0].srcFull
                    : allEntries.length ? allEntries[0].srcFull
                    : srcNorm;  // span text is best-effort for unmapped fields

      // TARGET API name: only for rows mapped under current DMO
      const tgtNames = entries.length ? Array.from(new Set(entries.map((e) => e.tgt))) : [];
      const tgtText  = tgtNames.join(" | ");

      let th = null; try { th = row.querySelector("th"); } catch (e) {}
      let tds; try { tds = Array.from(row.querySelectorAll("td")); } catch (e) { tds = []; }
      const lastTd = tds.length ? tds[tds.length - 1] : null;

      // ── hover mode: always tag th; only tag lastTd when mapped ──
      if (state.on) {
        if (th) {
          th.dcApiName = srcFull;
          try { th.setAttribute("data-dc-api-name", srcFull); th.style.setProperty("cursor", "help", "important"); } catch (e) {}
        }
        if (lastTd && tgtText) {
          lastTd.dcApiName = tgtText;
          try { lastTd.setAttribute("data-dc-api-name", tgtText); lastTd.style.setProperty("cursor", "help", "important"); } catch (e) {}
        }
      }

      // ── inline mode: always inject source span; only inject target when mapped ──
      if (state.inline) {
        const mkSpan = (cls, text, color) => {
          const sp = document.createElement("span");
          sp.className = cls; sp.textContent = text;
          const s = (p, v) => { try { sp.style.setProperty(p, v, "important"); } catch (e) {} };
          s("display", "block"); s("font-family", "'SF Mono',Menlo,Consolas,monospace");
          s("font-size", "10px"); s("color", color); s("margin-top", "3px");
          s("white-space", "nowrap"); s("overflow", "hidden"); s("text-overflow", "ellipsis");
          s("max-width", "100%"); s("user-select", "text"); s("-webkit-user-select", "text");
          try { sp.setAttribute("title", text); } catch (e) {}
          return sp;
        };
        // source API name below the field name in <th> — ALL rows
        if (th) th.appendChild(mkSpan("dc-sapi-inline", srcFull, "#4a6fa5"));
        // target API name below combobox in last <td> — mapped rows only
        if (lastTd && tgtText) lastTd.appendChild(mkSpan("dc-tapi-inline", tgtText, "#4a6fa5"));
      }
    }
  }

  // Build export rows from container.mapping[] for the table view.
  // Honours the currently selected DMO (same filter as tableRedraw).
  function buildTableViewRows() {
    const container = findByTag(TAGGING_CMP).find(isVisible) || findByTag(TAGGING_CMP)[0];
    if (!container) return [];
    const raw = safeGet(container, "mapping");
    if (!Array.isArray(raw)) return [];

    const rawDmo = tableSelectedDmo();
    const selectedDmo = (rawDmo && rawDmo.startsWith("__LABEL__:")) ? null : rawDmo;
    const selectedDmoLabel = (rawDmo && rawDmo.startsWith("__LABEL__:")) ? rawDmo.slice(10) : null;

    // Build DMO label map from entity selector items
    const { labelToApi } = tableEntitySelectorInfo();
    const dmoLabels = new Map();
    for (const [label, api] of labelToApi) dmoLabels.set(api, label);

    // DLO label from source-list <th>
    let dloLabel = "";
    const tableCmp = findByTag(TABLE_CMP).find(isVisible);
    if (tableCmp) {
      let tsr = null; try { tsr = tableCmp.shadowRoot; } catch (e) {}
      if (tsr) {
        let srcTh = null; try { srcTh = tsr.querySelector("th.source-list"); } catch (e) {}
        if (srcTh) dloLabel = (srcTh.textContent || "").trim().replace(/\s*\(\d+\)\s*$/, "");
      }
    }

    const rows = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const src = safeGet(item, "source"); const tgt = safeGet(item, "target");
      if (!src || !tgt) continue;
      const srcEntity = safeGet(src, "entityName") || "";
      const srcField  = safeGet(src, "fieldName")  || "";
      const tgtEntity = safeGet(tgt, "entityName") || "";
      const tgtField  = safeGet(tgt, "fieldName")  || "";
      if (!srcField || !tgtField) continue;
      // DMO filter
      if (selectedDmo && tgtEntity !== selectedDmo) continue;
      if (selectedDmoLabel) {
        const ll = selectedDmoLabel.toLowerCase().replace(/\s+/g, "");
        if (tgtEntity.toLowerCase().replace(/_/g, "").indexOf(ll) < 0) continue;
      }
      rows.push({
        srcObj: srcEntity, srcObjLabel: dloLabel || srcEntity,
        sourceLabel: srcField, sourceApi: srcField, sourceType: "",
        dmo: tgtEntity, dmoLabel: dmoLabels.get(tgtEntity) || tgtEntity,
        targetLabel: tgtField, targetApi: tgtField, targetType: "",
      });
    }
    return rows;
  }

  // Returns true when the TABLE view is active and visible.
  // Canvas has visible ITEM rows; table view has TABLE_CMP but no visible ITEMs.
  // Using both conditions makes this reliable even when Lightning keeps cached
  // hidden views in the DOM alongside the active one.
  function isTableView() {
    if (findByTag(ITEM).some(isVisible)) return false;  // canvas is active
    const t = findByTag(TABLE_CMP);
    for (const el of t) {
      try {
        if (el.isConnected === false) continue;
        const r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) return true;
      } catch (e) {}  // no fallback-true — if rect throws, treat as not visible
    }
    return false;
  }

  // ---------- main redraw ----------
  // `on` starts FALSE: inline names are opt-in (user clicks "Show API names").
  // This keeps a freshly-loaded / newly-navigated page clean until requested.
  const state = { on: false, inline: false, srcDone: 0, tgtDone: 0, tgtMiss: 0 };

  function redraw() {
    if (!state.on && !state.inline) return;
    // SOURCE: there can be MULTIPLE source entities (each its own
    // <runtime_cdp-data-stream-attribute-list>), each possibly with multiple
    // sections (Is Mapped / Unmapped). Handle EACH list independently, scoping
    // rows to it. For EACH list, prefer matching BY LABEL via that list's
    // `.entity.fields[]` (section-order-proof, same as the DMO side); fall back
    // to order-zipping the attribute-name API names only if that data is absent.
    let sd = 0, srcCount = 0, apiTotal = 0;
    const pairs = [];
    const NON_FIELD_S = /^(Add New Field|Unmapped|Is Mapped|Mapped|Show more|Show less)\b/i;
    const NON_FIELD_TID_S = /^(add-new-field-btn|.*-btn|entity-list|search-input|main-container)$/i;
    const smset = mappedSourceSet(); // authoritative "dlo::field" pairs for collision disambiguation
    for (const listEl of findByTag(SRC_LIST)) {
      const { map, labelNames, entityName } = entityFieldMap(listEl); // label -> apiName + label -> [all apis]
      const attrApis = attrApiNames(listEl);           // ordered fallback
      apiTotal += (map.size || attrApis.length);
      // rows that belong to THIS list (nearest attribute-list ancestor is it)
      const rows = findByTag(ITEM).filter((it) => {
        if (ancestorOfTag(it, SRC_LIST) !== listEl) return false;
        const t = labelOf(it);
        return t && !HEADER.test(t) && !NON_FIELD_S.test(t) && !NON_FIELD_TID_S.test(t);
      });
      const useLabels = map.size > 0;
      // Collision-aware resolver: for a label shared by MULTIPLE fields (e.g. three
      // "Account Number"), order candidates MAPPED-FIRST via the authoritative
      // mapping[] set, then hand each rendered row the next one. Returns {api, sure}
      // so a genuinely ambiguous pick can be flagged "(?)" instead of shown as fact.
      // For a UNIQUE label this is identical to a plain lookup.
      const nextForLabel = makeCollisionResolver(labelNames || new Map(), smset, entityName);
      for (let i = 0; i < rows.length; i++) {
        const label = labelOf(rows[i]);
        // by label (robust, collision-aware) if available, else positional attribute name
        const resolved = useLabels ? nextForLabel(label) : null;
        const name = resolved ? resolved.api : attrApis[i];
        const uncertain = resolved ? !resolved.sure : false;
        if (!name) continue;
        srcCount++;
        if (pairs.length < 300) pairs.push([label, name, uncertain]);
        if (state.on && decorate(rows[i], name, uncertain)) sd++;
        if (state.inline) inlineDecorate(rows[i], name, uncertain);
      }
    }
    state.srcDone = sd;
    state.srcCount = srcCount; state.apiCount = apiTotal;
    state.srcPairs = pairs; // [label, apiName] for verifying alignment

    // ENTITY HEADERS (source DLOs): only for HOVER mode. Inline mode is
    // fields-only (header decoration reflows a different wrapper and distorts
    // the canvas), so we never inject inline text into headers.
    let hdrDone = 0;
    if (state.on) {
      for (const listEl of findByTag(SRC_CONTAINER)) {
        const { entityName } = entityFieldMap(listEl);
        if (entityName && decorateHeader(listEl, entityName)) hdrDone++;
      }
    }

    // TARGET: per DMO list, read entity.fields[] (label->name) and decorate
    // each rendered row by matching its label WITHIN THAT SAME LIST. Scoping
    // per list is what disambiguates same-label fields across different DMOs.
    let td = 0, miss = 0, tgtCount = 0;
    const tgtPairs = [];
    const tgtMissLabels = [];
    // Rows that are UI affordances, not fields — they have no API name and
    // should not count as misses. Matches both display labels ("Add New Field",
    // "Unmapped (n)") AND internal data-tid ids ("add-new-field-btn").
    const NON_FIELD = /^(Add New Field|Unmapped|Is Mapped|Mapped|Show more|Show less)\b/i;
    const NON_FIELD_TID = /^(add-new-field-btn|.*-btn|entity-list|search-input|main-container)$/i;
    const mset = mappedTargetSet(); // authoritative "dmo::field" pairs for collision disambiguation
    for (const { listEl, map, labelNames, entityName } of targetLists()) {
      // entity header (DMO title) -> hover mode only (fields-only for inline)
      if (state.on && entityName && decorateHeader(listEl, entityName)) hdrDone++;
      const items = itemsUnder(listEl).filter((it) => {
        const t = labelOf(it);
        return t && !HEADER.test(t) && !NON_FIELD.test(t) && !NON_FIELD_TID.test(t);
      });
      // Per-list resolver: for a label shared by >1 field, order candidates
      // mapped-first and hand each rendered row the next one; returns {api, sure}.
      const nextForLabelTarget = makeTargetResolver(labelNames || new Map(), mset, entityName);
      for (const it of items) {
        tgtCount++;
        const label = labelOf(it);
        const resolved = nextForLabelTarget(label);
        // Fall back to the plain first-match only if the resolver found nothing
        // (e.g. labelNames unavailable): still better than a miss.
        const name = resolved ? resolved.api : lookupByLabel(map, label);
        const uncertain = resolved ? !resolved.sure : false;
        if (name) {
          if (state.on && decorate(it, name, uncertain)) td++;
          if (state.inline) inlineDecorate(it, name, uncertain);
          if (tgtPairs.length < 300) tgtPairs.push([entityName, label, name, uncertain]);
        } else {
          miss++;
          if (tgtMissLabels.length < 40) tgtMissLabels.push([entityName, label]);
        }
      }
    }
    state.tgtDone = td; state.tgtMiss = miss; state.tgtCount = tgtCount;
    state.tgtPairs = tgtPairs;
    state.tgtMissLabels = tgtMissLabels;
    state.hdrDone = hdrDone;

    // TABLE VIEW: decorate rows with source + target API names.
    // Only runs when the table component is actually visible; canvas is unaffected.
    if (isTableView()) tableRedraw();

    updateBadge();
    // Inline names are ABSOLUTELY POSITIONED (out of flow): they don't change
    // row height, so the ◉ dots don't move and the canvas connector lines are
    // unaffected — no resize/reflow nudge needed.
  }

  // ---------- observe for re-renders ----------
  // A MutationObserver on documentElement does NOT see changes inside shadow
  // roots (the boundary blocks observation), and LWC renders these rows inside
  // shadow DOM. So expanding "Unmapped (n)" / scrolling adds rows the observer
  // never catches. We therefore ALSO poll: redraw() is idempotent (skips
  // already-correct rows), so a light periodic re-scan picks up any newly
  // rendered rows — mapped or unmapped — reliably.
  const anyOn = () => state.on || state.inline;
  let timer = null;
  function schedule() { if (timer) return; timer = setTimeout(() => { timer = null; if (anyOn()) redraw(); }, 250); }
  const mo = new MutationObserver(schedule);
  let poll = null;
  function observe() {
    try { mo.observe(document.documentElement, { subtree: true, childList: true, attributes: false }); } catch (e) {}
    if (!poll) poll = setInterval(() => { if (anyOn()) redraw(); }, 1200);
  }
  function unobserve() {
    if (anyOn()) return; // keep observing while EITHER mode is active
    try { mo.disconnect(); } catch (e) {}
    if (poll) { clearInterval(poll); poll = null; }
  }

  // Detect in-app navigation (SPA route change) and turn BOTH modes off so a
  // newly-opened data stream loads clean — the user re-enables when they want.
  let lastUrl = "";
  try { lastUrl = location.href; } catch (e) {}
  let navPoll = null;
  function watchNavigation() {
    if (navPoll) return;   // already watching — don't stack pollers
    navPoll = setInterval(() => {
      let u = ""; try { u = location.href; } catch (e) {}
      if (u !== lastUrl) {
        lastUrl = u;
        if (anyOn()) { state.on = false; state.inline = false; clearTags(); clearInline(); unobserve(); updateBadge(); }
        // On detail pages the launcher must disappear when the user navigates away.
        teardown();
      }
    }, 800);
  }

  // Reflects current state onto both toggle buttons (if present).
  function updateBadge() {
    state.summary = "hover:" + (state.on ? "on" : "off") + " inline:" + (state.inline ? "on" : "off");
    const tooltipIcon = "<svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor'><circle cx='8' cy='8' r='3'/><path d='M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41'/></svg>";
    const pinIcon    = "<svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor'><rect x='1' y='3' width='14' height='2' rx='1'/><rect x='1' y='7' width='10' height='2' rx='1'/><rect x='1' y='11' width='12' height='2' rx='1'/></svg>";
    const t = document.getElementById("dc-toggle-btn");
    if (t) {
      const on = state.on;
      t.dataset.active = on ? "1" : "";
      const lbl = t.querySelector(".dc-lbl");
      if (lbl) lbl.textContent = on ? "Tooltip: ON" : "API Tooltip";
      t.style.setProperty("background", on ? "#0d6efd" : "#111827", "important");
      t.style.setProperty("color", on ? "#fff" : "#fff", "important");
      t.style.setProperty("box-shadow", on ? "0 2px 10px rgba(13,110,253,.35)" : "none", "important");
      t.style.setProperty("opacity", "1", "important");   // clear any "busy" dim
    }
    const i = document.getElementById("dc-inline-btn");
    if (i) {
      const on = state.inline;
      i.dataset.active = on ? "1" : "";
      const lbl = i.querySelector(".dc-lbl");
      if (lbl) lbl.textContent = on ? "Unpin names" : "Pin API names";
      i.style.setProperty("background", on ? "#0d6efd" : "#111827", "important");
      i.style.setProperty("color", on ? "#fff" : "#fff", "important");
      i.style.setProperty("box-shadow", on ? "0 2px 10px rgba(13,110,253,.35)" : "none", "important");
      i.style.setProperty("opacity", "1", "important");   // clear any "busy" dim
    }
  }

  // Busy guard: the heavy work is redraw() (walks shadow DOM + decorates many rows),
  // which blocks the main thread. Without this, a user who doesn't see instant feedback
  // clicks AGAIN — and the second click toggles the mode back OFF (the reported bug).
  // While busy we ignore re-clicks and show a "working…" label; the button reflects the
  // new state BEFORE the heavy work by deferring redraw to the next frame (so it paints).
  let _busyToggle = false;
  function afterPaint(fn) {
    // double-rAF (or timeout fallback) guarantees the label repaint lands first.
    try { requestAnimationFrame(function () { requestAnimationFrame(fn); }); }
    catch (e) { setTimeout(fn, 16); }
  }
  function setBtnBusy(id, msg) {
    const b = document.getElementById(id); if (!b) return;
    const lbl = b.querySelector(".dc-lbl"); if (lbl) lbl.textContent = msg;
    b.style.setProperty("opacity", "0.75", "important");
  }

  // The two modes are MUTUALLY EXCLUSIVE — only one active at a time.
  function toggle() {  // hover mode
    if (_busyToggle) return;                       // ignore rapid re-clicks while working
    state.on = !state.on;
    updateBadge();                                 // reflect new state immediately
    if (state.on) {
      if (state.inline) { state.inline = false; clearInline(); }
      _busyToggle = true; setBtnBusy("dc-toggle-btn", "Working…");
      afterPaint(function () {
        try { bindHover(); redraw(); observe(); } catch (e) {}
        _busyToggle = false; updateBadge();
      });
    } else { clearTags(); unobserve(); }
  }
  function toggleInline() {  // visible + searchable inline "Pin API names" mode
    if (_busyToggle) return;                       // ignore rapid re-clicks while working
    state.inline = !state.inline;
    updateBadge();                                 // button flips to "Unpin names" NOW
    if (state.inline) {
      if (state.on) { state.on = false; clearTags(); }
      _busyToggle = true; setBtnBusy("dc-inline-btn", "Pinning…");
      // Defer the heavy pin pass so the button visibly changes first (no "did it work?"
      // confusion), then re-label with a brief count so the user knows it finished.
      afterPaint(function () {
        try { redraw(); observe(); } catch (e) {}
        _busyToggle = false; updateBadge();
        const b = document.getElementById("dc-inline-btn");
        const lbl = b && b.querySelector(".dc-lbl");
        if (lbl) {
          const n = (state.srcDone || 0) + (state.tgtDone || 0);
          lbl.textContent = n > 0 ? ("Pinned " + n) : "Unpin names";
          if (n > 0) setTimeout(function () { if (state.inline && lbl) lbl.textContent = "Unpin names"; }, 1400);
        }
      });
    } else { clearInline(); unobserve(); }
  }

  // ---------- report target-side diagnosis to an on-page box ----------
  function showDiag() {
    const rep = {
      source: { apiNamesInDom: state.apiCount, fieldRows: state.srcCount, decorated: state.srcDone },
      sourcePairs: state.srcPairs || [],
      target: { fieldRows: state.tgtCount, decorated: state.tgtDone, missing: state.tgtMiss },
      targetPairs: (state.tgtPairs || []).slice(0, 40),
      targetMissLabels: state.tgtMissLabels || [],
    };
    // Only surface a small hint box if NOTHING decorated (likely not on the
    // mapping canvas). Silent otherwise — no console output.
    if (state.srcDone === 0 && state.tgtDone === 0) {
      try {
        const old = document.getElementById("dc-decor-diag"); if (old) old.remove();
        const wrap = document.createElement("div");
        wrap.id = "dc-decor-diag";
        wrap.style.cssText = "position:fixed;inset:auto 16px 60px auto;z-index:2147483647;width:560px;max-width:94vw;background:#fff;border:2px solid #6b1f9a;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.3);font:12px -apple-system,sans-serif";
        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;align-items:center;padding:8px 10px;background:#6b1f9a;color:#fff;border-radius:6px 6px 0 0";
        bar.innerHTML = "<strong style='flex:1'>No fields found — open a DLO&rarr;DMO mapping page.</strong>";
        const close = document.createElement("button"); close.textContent = "✕"; close.title = "Dismiss this message";
        close.style.cssText = "border:none;background:transparent;color:#fff;font-size:16px;cursor:pointer"; close.onclick = () => wrap.remove();
        bar.appendChild(close);
        const ta = document.createElement("textarea");
        ta.value = JSON.stringify(rep, null, 2);
        ta.style.cssText = "width:100%;height:300px;border:none;padding:8px;font:11px 'SF Mono',Menlo,monospace;box-sizing:border-box;resize:vertical";
        ta.onclick = () => ta.select();
        wrap.appendChild(bar); wrap.appendChild(ta); document.body.appendChild(wrap); ta.select();
      } catch (e) {}
    }
  }

  // ================= EXPORT / LIST VIEW =================
  // Returns rows: { srcObj, srcObjLabel, sourceLabel, sourceApi, dmo, dmoLabel, targetLabel, targetApi }
  // In canvas view: reads TGT_CONTAINER entity.fields[] (label+api, isMapped filter).
  // In table view:  reads container.mapping[] directly (already has API names).
  function buildMappingRows() {
    if (isTableView()) return buildTableViewRows();

    // ── Authoritative source-API resolver (fixes label-collision bug) ──────────
    // The target field only exposes sourceLabel, so resolving the source API by
    // LABEL breaks when a DLO has several fields sharing one label (e.g. three
    // "Account Number" fields). The tagging container's mapping[] array carries
    // the EXACT source.fieldName -> target.fieldName pairing (same data the table
    // view uses), so we key on it FIRST and fall back to label only if absent.
    //   key: dmoApi + "::" + targetApi  ->  { srcObj, sourceApi }
    const exactByTarget = new Map();
    try {
      const cont = findVisibleByTag(TAGGING_CMP)[0] || findByTag(TAGGING_CMP)[0];
      const rawMap = cont && safeGet(cont, "mapping");
      if (Array.isArray(rawMap)) {
        for (const it of rawMap) {
          if (!it || typeof it !== "object") continue;
          const src = safeGet(it, "source"), tgt = safeGet(it, "target");
          if (!src || !tgt) continue;
          const tEnt = safeGet(tgt, "entityName") || "", tFld = safeGet(tgt, "fieldName") || "";
          const sEnt = safeGet(src, "entityName") || "", sFld = safeGet(src, "fieldName") || "";
          if (tFld && sFld) exactByTarget.set(tEnt + "::" + tFld, { srcObj: sEnt, sourceApi: sFld });
        }
      }
    } catch (e) {}

    // label -> {api, dlo, dloLabel}, across all source entities. Also keep the
    // set of source object labels so we can attribute nested labels like
    // "cartItem.currency" (prefix "cartItem" = the source object).
    // labelCounts tracks colliding labels so the fallback can flag ambiguity
    // instead of silently returning the first match (the old bug).
    const byLabel = new Map();
    const labelCounts = new Map();
    const objByLabel = new Map(); // source-object label -> {name,label}
    for (const listEl of findVisibleByTag(SRC_CONTAINER)) {
      let ent = null; try { ent = listEl.entity; } catch (e) {}
      const dlo = (ent && safeGet(ent, "name")) || "";
      const dloLabel = (ent && safeGet(ent, "label")) || "";
      if (dloLabel) objByLabel.set(dloLabel, { name: dlo, label: dloLabel });
      const { map, typeMap } = entityFieldMap(listEl);
      for (const [label, name] of map) {
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
        if (!byLabel.has(label)) byLabel.set(label, { api: name, dlo: dlo, dloLabel: dloLabel, type: typeMap.get(label) || "" });
      }
    }
    // resolve -> {sourceApi, srcObj, srcObjLabel, sourceType}
    // Prefer the EXACT mapping[] pairing (keyed by DMO+target field). Only if the
    // container didn't expose mapping[] do we fall back to matching by label.
    function resolveSource(sourceLabel, dmoApi, targetApi) {
      // 1) authoritative: exact source.fieldName for this target field
      const exact = (dmoApi && targetApi) ? exactByTarget.get(dmoApi + "::" + targetApi) : null;
      if (exact) {
        const dloLabel = objByLabel.get(exact.srcObj) ? exact.srcObj : "";
        // find the source object's display label if we have it
        let srcObjLabel = exact.srcObj;
        for (const [lbl, o] of objByLabel) { if (o.name === exact.srcObj) { srcObjLabel = o.label; break; } }
        // recover type from byLabel if the label is unique
        const meta = byLabel.get(sourceLabel);
        const type = (meta && labelCounts.get(sourceLabel) === 1) ? meta.type : "";
        return { sourceApi: exact.sourceApi, srcObj: exact.srcObj, srcObjLabel: srcObjLabel, sourceType: type };
      }
      // 2) fallback: match by label (only reached if mapping[] wasn't exposed)
      const hit = byLabel.get(sourceLabel);
      if (hit) {
        return { sourceApi: hit.api, srcObj: hit.dlo, srcObjLabel: hit.dloLabel, sourceType: hit.type };
      }
      // nested "obj.field" — attribute to the object by its prefix
      const dot = sourceLabel.indexOf(".");
      if (dot > 0) {
        const prefix = sourceLabel.slice(0, dot);
        const obj = objByLabel.get(prefix);
        if (obj) return { sourceApi: "", srcObj: obj.name, srcObjLabel: obj.label, sourceType: "" };
      }
      return { sourceApi: "", srcObj: "", srcObjLabel: "", sourceType: "" };
    }
    const rows = [];
    for (const listEl of findVisibleByTag(TGT_CONTAINER)) {
      let entity = null; try { entity = listEl.entity; } catch (e) {}
      if (!entity) continue;
      const dmo = safeGet(entity, "name") || "";
      const dmoLabel = safeGet(entity, "label") || "";
      const fields = safeGet(entity, "fields");
      if (!fields || typeof fields.length !== "number") continue;
      for (let i = 0; i < fields.length; i++) {
        const f = safeGet(fields, i); if (!f) continue;
        const mapped = !!safeGet(f, "isMapped") || !!safeGet(f, "isMappedFromDb") || !!safeGet(f, "isMappedFromAgent");
        if (!mapped) continue;
        const sourceLabel = safeGet(f, "sourceLabel") || "";
        const targetApi = safeGet(f, "name") || "";
        const s = resolveSource(sourceLabel, dmo, targetApi);
        rows.push({
          srcObj: s.srcObj, srcObjLabel: s.srcObjLabel,
          sourceLabel: sourceLabel, sourceApi: s.sourceApi, sourceType: s.sourceType || "",
          dmo, dmoLabel,
          targetLabel: safeGet(f, "label") || "",
          targetApi: targetApi,
          targetType: (function () { const t = safeGet(f, "type"); return t == null ? "" : String(t); })(),
        });
      }
    }
    return rows;
  }

  // Ordered SOURCE (DLO) -> TARGET (DMO), the way data flows.
  const EXPORT_COLS = [
    ["srcObj", "Source Object (DLO)"],
    ["sourceLabel", "Source Field (label)"], ["sourceApi", "Source Field API"], ["sourceType", "Source Type"],
    ["dmo", "Target Object (DMO)"],
    ["targetLabel", "Target Field (label)"], ["targetApi", "Target Field API"], ["targetType", "Target Type"],
  ];
  function rowsToTable(rows, sep) {
    const esc = sep === "," ? (s) => (/[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s) : (s) => String(s).replace(/\t/g, " ");
    const head = EXPORT_COLS.map((c) => c[1]).join(sep);
    const body = rows.map((r) => EXPORT_COLS.map((c) => esc(r[c[0]] == null ? "" : r[c[0]])).join(sep)).join("\n");
    return head + "\n" + body;
  }

  // Make an element draggable by a handle (pointer-based; sets left/top).
  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    const down = (e) => {
      // ignore drags that start on interactive controls or selectable text
      const tg = e.target;
      if (tg && tg.closest && tg.closest("button,select,input,textarea,a,[style*='user-select:text'],.dc-ac-sub")) return;
      if (tg && window.getComputedStyle(tg).userSelect === "text") return;
      dragging = true;
      const r = el.getBoundingClientRect();
      // pin to left/top and drop any centering transform
      el.style.setProperty("left", r.left + "px", "important");
      el.style.setProperty("top", r.top + "px", "important");
      el.style.setProperty("right", "auto", "important");
      el.style.setProperty("bottom", "auto", "important");
      el.style.setProperty("transform", "none", "important");
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    };
    const move = (e) => {
      if (!dragging) return;
      let nx = ox + (e.clientX - sx), ny = oy + (e.clientY - sy);
      // keep on-screen
      const w = el.offsetWidth || 200, h = 40;
      nx = Math.max(4, Math.min(nx, window.innerWidth - Math.min(w, 120)));
      ny = Math.max(4, Math.min(ny, window.innerHeight - h));
      el.style.setProperty("left", nx + "px", "important");
      el.style.setProperty("top", ny + "px", "important");
    };
    const up = () => { dragging = false; window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); };
    handle.style.cursor = "move";
    handle.addEventListener("pointerdown", down, true);
  }

  function addResizeHandle(el, minW, minH) {
    minW = minW || 340; minH = minH || 240;
    const rsz = document.createElement("div");
    rsz.style.cssText = "position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:se-resize;z-index:10;background:transparent";
    rsz.innerHTML = "<svg width='12' height='12' viewBox='0 0 12 12' style='position:absolute;right:3px;bottom:3px;opacity:.35'><path d='M2 10h8M6 6h4M10 2v8' stroke='#5c6b8a' stroke-width='1.5' stroke-linecap='round'/></svg>";
    el.appendChild(rsz);
    let rsx=0, rsy=0, rw=0, rh=0, resizing=false;
    rsz.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); e.preventDefault();
      resizing=true; rsz.setPointerCapture(e.pointerId);
      const r2 = el.getBoundingClientRect();
      rsx=e.clientX; rsy=e.clientY; rw=r2.width; rh=r2.height;
      el.style.transform="none";
      el.style.left = r2.left+"px"; el.style.top = r2.top+"px";
    });
    rsz.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const nw = Math.max(minW, rw + (e.clientX - rsx));
      const nh = Math.max(minH, rh + (e.clientY - rsy));
      el.style.width  = Math.min(nw, window.innerWidth  - 20) + "px";
      el.style.height = Math.min(nh, window.innerHeight - 20) + "px";
    });
    rsz.addEventListener("pointerup", () => { resizing=false; });
  }

  let exportEl = null;
  let onDocDown = null, onKey = null;
  function closeExport() {
    if (exportEl) { exportEl.remove(); exportEl = null; }
    if (onDocDown) { document.removeEventListener("pointerdown", onDocDown, true); onDocDown = null; }
    if (onKey) { document.removeEventListener("keydown", onKey, true); onKey = null; }
    hideBackdrop();
  }
  // Mapping-export modal INSTANT tooltips — self-contained for this feature only.
  var _mxTipEl = null;
  function installMappingExportTooltips(container) {
    if (!container || container.__mxTipWired) return;
    container.__mxTipWired = true;
    if (!_mxTipEl) {
      _mxTipEl = document.createElement("div");
      _mxTipEl.style.cssText = "position:fixed;display:none;z-index:2147483647;max-width:280px;background:#1e293b;color:#fff;font:500 11px/1.45 -apple-system,sans-serif;padding:7px 10px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;";
      document.body.appendChild(_mxTipEl);
    }
    var show = function (el) {
      var tip = el.getAttribute("data-tip") || el.getAttribute("title"); if (!tip) return;
      if (el.hasAttribute("title")) { el.setAttribute("data-tip", tip); el.removeAttribute("title"); }
      _mxTipEl.textContent = tip; _mxTipEl.style.display = "block";
      var r = el.getBoundingClientRect(); var top = r.top - _mxTipEl.offsetHeight - 8; if (top < 6) top = r.bottom + 8;
      var left = Math.min(Math.max(6, r.left), window.innerWidth - _mxTipEl.offsetWidth - 6);
      _mxTipEl.style.top = top + "px"; _mxTipEl.style.left = left + "px";
    };
    var hide = function () { if (_mxTipEl) _mxTipEl.style.display = "none"; };
    container.addEventListener("mouseover", function (e) { var el = e.target && e.target.closest ? e.target.closest("[title],[data-tip]") : null; if (!el || !container.contains(el)) return; var tag = (el.tagName || "").toLowerCase(); if (tag === "td" || tag === "th") return; if (tag !== "button" && tag !== "select" && tag !== "label" && tag !== "a" && !el.hasAttribute("data-tab")) return; show(el); }, true);
    container.addEventListener("mouseout", hide, true);
    container.addEventListener("click", hide, true);
  }
  function openExport() {
    // Rebuild fresh from the CURRENT (visible) page each time it opens.
    let allRows = buildMappingRows();
    let dmos = Array.from(new Set(allRows.map((r) => r.dmo))).sort();
    let filter = "__ALL__";

    if (!exportEl) { exportEl = document.createElement("div"); document.body.appendChild(exportEl); }
    exportEl.id = "dc-export";
    exportEl.style.cssText = "position:fixed;top:5vh;left:50%;transform:translateX(-50%);z-index:2147483647;width:min(1000px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#fff;color:#16325c;border:1px solid #c9cede;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.5);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden";

    // Close on click OUTSIDE the modal (ignore clicks on the launcher button so
    // it doesn't immediately reopen/close), and on Escape.
    if (!onDocDown) {
      onDocDown = (e) => {
        if (!exportEl) return;
        const t = e.target;
        if (exportEl.contains(t)) return;
        if (t && t.closest && t.closest("#dc-export-btn")) return;
        closeExport();
      };
      document.addEventListener("pointerdown", onDocDown, true);
    }
    if (!onKey) {
      onKey = (e) => { if (e.key === "Escape") closeExport(); };
      document.addEventListener("keydown", onKey, true);
    }

    function render() {
      const rows = filter === "__ALL__" ? allRows : allRows.filter((r) => r.dmo === filter);
      const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const opts = ['<option value="__ALL__">All DMOs (' + allRows.length + ")</option>"]
        .concat(dmos.map((d) => '<option value="' + esc(d) + '"' + (d === filter ? " selected" : "") + ">" + esc(d) + " (" + allRows.filter((r) => r.dmo === d).length + ")</option>")).join("");
      const ty = (t) => t ? "<span class='ty'>" + esc(t) + "</span>" : "";
      const trs = rows.map((r) =>
        "<tr>" +
        "<td>" + (esc(r.srcObjLabel) || "<span class='muted'>system</span>") + (r.srcObj ? "<div class='api'>" + esc(r.srcObj) + "</div>" : "") + "</td>" +
        "<td>" + esc(r.sourceLabel) + (r.sourceApi ? "<div class='api'>" + esc(r.sourceApi) + ty(r.sourceType) + "</div>" : "") + "</td>" +
        "<td class='arrow'>&rarr;</td>" +
        "<td>" + esc(r.dmoLabel) + "<div class='api'>" + esc(r.dmo) + "</div></td>" +
        "<td>" + esc(r.targetLabel) + "<div class='api tgt'>" + esc(r.targetApi) + ty(r.targetType) + "</div></td>" +
        "</tr>").join("");
      exportEl.innerHTML =
        "<style>" +
        "#dc-export .hd{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#f3f6fb;border-bottom:1px solid #e0e5ee;flex-shrink:0;flex-wrap:wrap}" +
        "#dc-export .hd strong{font-size:15px;flex-shrink:0}#dc-export select{padding:5px 8px;border:1px solid #c9cede;border-radius:6px;font-size:12px;min-width:0;flex:1 1 120px;max-width:340px}" +
        "#dc-export .sp{flex:1 1 0}#dc-export button{flex-shrink:0;border:1px solid #0b5cab;background:#0b5cab;color:#fff;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;font-size:12px;white-space:nowrap}" +
        "#dc-export button.sec{background:#fff;color:#0b5cab}#dc-export .x{flex-shrink:0;border:none;background:transparent;color:#5c6b8a;font-size:20px;padding:0 4px;cursor:pointer;line-height:1;margin-left:4px}" +
        "#dc-export .bd{overflow:auto;padding:0;flex:1;min-height:0}" +
        "#dc-export table{border-collapse:collapse;width:100%;font-size:12px}" +
        "#dc-export th{position:sticky;top:0;background:#fff;text-align:left;padding:8px 12px;border-bottom:2px solid #e0e5ee;color:#5c6b8a;font-size:11px;text-transform:uppercase;letter-spacing:.03em}" +
        "#dc-export td{padding:7px 12px;border-bottom:1px solid #eef1f6;vertical-align:top}" +
        "#dc-export td .api{font:11px 'SF Mono',Menlo,monospace;color:#0b5cab;margin-top:1px;word-break:break-all}" +
        "#dc-export td .api.tgt{color:#6b1f9a}" +
        "#dc-export td .ty{display:inline-block;margin-left:6px;padding:0 5px;border-radius:8px;background:#eef1f6;color:#5c6b8a;font:10px/1.6 -apple-system,sans-serif}" +
        "#dc-export td.arrow{color:#8a94ab;text-align:center;font-size:14px;width:20px}" +
        "#dc-export .muted{color:#b0b7c6;font-style:italic}" +
        "#dc-export .ft{padding:8px 16px;border-top:1px solid #e0e5ee;color:#8a94ab;font-size:11px;background:#f9fafc}" +
        "</style>" +
        "<div class='hd'><strong>Mappings: DLO&nbsp;&rarr;&nbsp;DMO</strong>" +
        "<select id='dc-x-dmo' title='Filter the mappings by a specific DMO (or show all)'>" + opts + "</select>" +
        "<span class='sp'></span>" +
        "<button id='dc-x-copy' title='Copy all shown mappings (with API names) to the clipboard, tab-separated for pasting into Google Sheets / Excel'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets</button>" +
        "<button class='sec' id='dc-x-csv' title='Download the shown mappings as a CSV file'>Download CSV</button>" +
        "<button class='x' id='dc-x-close' title='Close this mappings view'>&times;</button></div>" +
        "<div class='bd'><table><thead><tr><th>Source object (DLO)</th><th>Source field</th><th></th><th>Target object (DMO)</th><th>Target field</th></tr></thead><tbody>" +
        (trs || "<tr><td colspan='5' style='padding:24px;text-align:center;color:#8a94ab'>No mapped fields found.</td></tr>") +
        "</tbody></table></div>" +
        "<div class='ft'>" + rows.length + " mapping(s)" + (filter === "__ALL__" ? " across " + dmos.length + " DMO(s)" : "") + " · reads DLO&rarr;DMO · source API/object blank = system field (Data Source, Key Qualifier, etc.)</div>";
      exportEl.querySelector("#dc-x-close").onclick = closeExport;
      exportEl.querySelector("#dc-x-dmo").onchange = (e) => { filter = e.target.value; render(); };
      // header is the drag handle (buttons/select inside are ignored by makeDraggable)
      const hd = exportEl.querySelector(".hd"); if (hd) makeDraggable(exportEl, hd);
      addResizeHandle(exportEl, 480, 300);
      try { installMappingExportTooltips(exportEl); } catch (e) {}
      exportEl.querySelector("#dc-x-copy").onclick = (e) => {
        navigator.clipboard.writeText(rowsToTable(rows, "\t")).then(() => { e.target.textContent = "✓ Copied!"; setTimeout(() => (e.target.innerHTML = "<svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets"), 1200); }).catch(() => {});
      };
      exportEl.querySelector("#dc-x-csv").onclick = () => {
        try {
          const blob = new Blob([rowsToTable(rows, ",")], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          // Name the file after the actual DLO/DMO(s) in view, e.g.
          //   one DLO → one DMO : "<DLO>_to_<DMO>_DLO-to-DMO-mapping.csv"
          //   many DLOs → one DMO: "<DMO>_DLO-to-DMO-mapping.csv"
          //   one DLO → many DMOs: "<DLO>_DLO-to-DMO-mapping.csv"
          //   otherwise          : "DLO-to-DMO-mapping.csv"
          const clean = (s) => String(s == null ? "" : s).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
          const srcObjs = Array.from(new Set(rows.map(r => r.srcObjLabel || r.srcObj).filter(Boolean)));
          const tgtObjs = Array.from(new Set(rows.map(r => r.dmoLabel || r.dmo).filter(Boolean)));
          let namePart;
          if (srcObjs.length === 1 && tgtObjs.length === 1) namePart = clean(srcObjs[0]) + "_to_" + clean(tgtObjs[0]);
          else if (tgtObjs.length === 1) namePart = clean(tgtObjs[0]);
          else if (srcObjs.length === 1) namePart = clean(srcObjs[0]);
          else namePart = "";
          a.download = (namePart ? namePart + "_" : "") + "DLO-to-DMO-mapping.csv";
          document.body.appendChild(a); a.click(); a.remove();
        } catch (e) {}
      };
    }
    render();
  }

  // Fully remove the tool from the page: inline names off, tooltip + tags gone,
  // export modal closed, control bar removed, timers stopped. Re-running the
  // bookmarklet/snippet re-creates everything.
  function teardown() {
    try { state.on = false; state.inline = false; unobserve(); } catch (e) {}
    try { clearTags(); clearInline(); } catch (e) {}  // tooltip + tags + inline spans
    try { closeExport(); } catch (e) {}    // closes mapping/segment modal + its listeners
    // Close in-dev Data Explorer surfaces too (guarded — stripped from public build).
    try { if (typeof closeExploreModal === "function") closeExploreModal(); } catch (e) {}
    try { if (typeof closeAllColumnsTable === "function") closeAllColumnsTable(); } catch (e) {}
    try { if (typeof closeSoqlEditor === "function") closeSoqlEditor(); } catch (e) {}
    // Backstop: remove any of our modal roots by id, in case a close handle went stale.
    try {
      ["dc-explore-modal", "dc-allcols-table", "dc-colviz-panel", "dc-cell-tools", "dc-export", "dc-detail-export", "dc-hide-overlay", "dc-ai-settings-dialog"].forEach(function (id) {
        var el = document.getElementById(id); if (el) el.remove();
      });
    } catch (e) {}
    // Remove transform view
    try { if (typeof closeTransformView === "function") closeTransformView(); } catch (e) {}
    try { if (navPoll) { clearInterval(navPoll); navPoll = null; } } catch (e) {}
    try { var bar = document.getElementById("dc-bar"); if (bar) bar.remove(); } catch (e) {}
    // Nuclear cleanup: remove any remaining elements our tool created
    try { document.querySelectorAll("[id^='dc-']").forEach(function (el) { el.remove(); }); } catch (e) {}
    try { delete window.__DC_DECOR__; } catch (e) { window.__DC_DECOR__ = null; }
  }

  // DRIFT METER: proves whether inline names move the ◉ connector anchors.
  // Measures every field row's dot position with inline OFF, turns it ON,
  // re-measures, and returns the max vertical drift. 0px = names don't move
  // anything → any perceived "break" is line crossing, not our decoration.
  // Usage in console:  __DC_DECOR__.driftMeter()
  function dotRects() {
    // The ◉ dot is the row's mapping socket; measure the row item host's rect
    // top (the dot is vertically centered on the row, so row-top drift == dot drift).
    const out = [];
    const push = (it) => {
      try {
        const label = labelOf(it);
        if (!label || HEADER.test(label)) return;
        const r = it.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) out.push({ label, top: r.top, mid: r.top + r.height / 2 });
      } catch (e) {}
    };
    findByTag(ITEM).forEach(push);
    return out;
  }
  function driftMeter() {
    const wasInline = state.inline, wasOn = state.on;
    // baseline with EVERYTHING off
    if (state.inline) { state.inline = false; clearInline(); }
    if (state.on) { state.on = false; clearTags(); }
    const before = dotRects();
    const beforeMap = {}; before.forEach((r) => { beforeMap[r.label] = r.mid; });
    // turn inline ON and re-measure
    state.inline = true; redraw();
    const after = dotRects();
    let max = 0, moved = 0; const worst = [];
    after.forEach((r) => {
      if (!(r.label in beforeMap)) return;
      const d = Math.abs(r.mid - beforeMap[r.label]);
      if (d > 0.5) { moved++; worst.push({ label: r.label, drift: Math.round(d * 10) / 10 }); }
      if (d > max) max = d;
    });
    worst.sort((a, b) => b.drift - a.drift);
    // restore prior state
    if (!wasInline) { state.inline = false; clearInline(); }
    if (wasOn) { state.on = true; bindHover(); redraw(); }
    const summary = { rowsMeasured: after.length, rowsMoved: moved, maxDriftPx: Math.round(max * 10) / 10, worst: worst.slice(0, 8) };
    return summary;
  }

  // PROBE: dump the REAL structure + computed layout of a field row's label,
  // piercing shadow DOM (plain document.querySelector can't). Used to fix
  // below-label placement precisely instead of guessing. Pass a substring of
  // the field label (e.g. "eventId" for the Primary Key row). Returns the
  // label's tag, its computed display/flex, and each child's tag/text/display.
  //   __DC_DECOR__.probeRow("eventId")
  function probeRow(labelSubstr) {
    const gcs = (el) => { try { return (window.getComputedStyle ? window.getComputedStyle(el) : {}) || {}; } catch (e) { return {}; } };
    const describe = (el) => {
      if (!el) return null;
      const s = gcs(el);
      let cls = ""; try { cls = el.getAttribute && (el.getAttribute("class") || ""); } catch (e) {}
      let txt = ""; try { txt = (el.textContent || "").trim().slice(0, 40); } catch (e) {}
      return { tag: tagOf(el), class: cls, text: txt, display: s.display, flexDir: s.flexDirection, flexWrap: s.flexWrap, position: s.position };
    };
    const matches = findByTag(ITEM).filter((it) => {
      const l = labelOf(it); return l && (!labelSubstr || l.toLowerCase().indexOf(String(labelSubstr).toLowerCase()) >= 0);
    });
    const report = matches.slice(0, 3).map((it) => {
      let sr = null; try { sr = it.shadowRoot; } catch (e) {}
      let labelEl = null; try { labelEl = sr && sr.querySelector("h4.name, h4"); } catch (e) {}
      const kids = [];
      if (labelEl) { try { for (const c of labelEl.children) kids.push(describe(c)); } catch (e) {} }
      let parent = null; try { parent = labelEl && labelEl.parentElement; } catch (e) {}
      return {
        rowLabel: labelOf(it),
        label: describe(labelEl),
        labelChildCount: kids.length,
        labelChildren: kids,
        labelParent: describe(parent),
      };
    });
    return report;
  }

  // GEOMETRY PROBE: measures the REAL pixel geometry of a row so placement is
  // computed, not guessed. For each matching row it reports the row (.root)
  // rect, the h4 label rect, the label's TEXT rect (via a Range over the text
  // node), and the ◉ dot rect. The key output is `gapBelowTextPx` = how much
  // empty vertical space exists between the bottom of the label text and the
  // bottom of the row — i.e. whether a below-label line can fit WITHOUT growing
  // the row. Run: __DC_DECOR__.probeGeom("eventId")
  function probeGeom(labelSubstr) {
    const R = (el) => { try { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), h: Math.round(r.height), w: Math.round(r.width) }; } catch (e) { return null; } };
    // rect of the actual rendered text inside an element (first text-bearing node)
    const textRect = (el) => {
      try {
        const rng = document.createRange();
        // select the element's text content; if it has child spans, this still
        // bounds the visible glyphs.
        rng.selectNodeContents(el);
        const r = rng.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      } catch (e) { return null; }
    };
    const matches = findByTag(ITEM).filter((it) => {
      const l = labelOf(it); return l && (!labelSubstr || l.toLowerCase().indexOf(String(labelSubstr).toLowerCase()) >= 0);
    });
    const report = matches.slice(0, 4).map((it) => {
      let sr = null; try { sr = it.shadowRoot; } catch (e) {}
      let root = null, h4 = null, dot = null;
      try { root = sr && sr.querySelector(".root, .normal-border"); } catch (e) {}
      try { h4 = sr && sr.querySelector("h4.name, h4"); } catch (e) {}
      try { dot = sr && sr.querySelector(".mappingTargetIconContainer, [class*='mappingTargetIcon']"); } catch (e) {}
      const rootR = root && R(root), h4R = h4 && R(h4), txtR = h4 && textRect(h4), dotR = dot && R(dot);
      // gap between bottom of the label TEXT and bottom of the ROW
      let gap = null;
      if (rootR && txtR) gap = rootR.bottom - txtR.bottom;
      return {
        rowLabel: labelOf(it),
        rowRect: rootR, rowHeight: rootR && rootR.h,
        labelRect: h4R,
        labelTextRect: txtR,
        dotRect: dotR, dotCenterY: dotR ? Math.round(dotR.top + dotR.h / 2) : null,
        gapBelowTextPx: gap,   // >~12 means a 10px line fits below WITHOUT growing the row
      };
    });
    return report;
  }

  window.__DC_DECOR__ = { toggle, toggleInline, teardown, redraw, state, targetLists, buildMappingRows, openExport, driftMeter, probeRow, probeGeom, _diag: showDiag,
    tableRedraw, buildTableMap,
    // URL the tool initialized on — used by the re-click guard to tell a same-page
    // toggle-off from an after-navigation re-detect (SPA route change in the same tab).
    loadUrl: (function () { try { return location.href; } catch (e) { return ""; } })(),
    // Build stamp — bump when verifying which code is actually loaded in the page.
    buildTag: "navfix-7-empty",
    // Live diagnostics for the SPA navigation watcher (why teardown may not be firing).
    navDiag: function () { return { polling: !!navPoll, lastUrl: lastUrl, currentUrl: (function () { try { return location.href; } catch (e) { return "?"; } })(), changed: (function () { try { return location.href !== lastUrl; } catch (e) { return "?"; } })() }; },
    _test: { API_ATTR, HEADER } };

  // Keeps a dragged FAB within the visible viewport when the window resizes
  // (e.g. DevTools opens/closes). Only active after the first drag switches the
  // wrap from right/bottom to left/top positioning.
  function addFabResizeGuard(wrap) {
    window.addEventListener("resize", () => {
      // Only clamp if already in left/top mode (i.e. has been dragged)
      if (wrap.style.right === "auto" || wrap.style.bottom === "auto") {
        const x = parseFloat(wrap.style.left) || 0;
        const y = parseFloat(wrap.style.top)  || 0;
        wrap.style.left = Math.max(4, Math.min(x, window.innerWidth  - 54)) + "px";
        wrap.style.top  = Math.max(4, Math.min(y, window.innerHeight - 54)) + "px";
      }
    });
  }

  // Compact FAB (Floating Action Button) launcher — 44px circle, bottom-right.
  // Click the FAB to expand/collapse the action menu above it.
  // No drag needed: bottom-right never overlaps SF navigation.
  function ensureLauncher() {
    if (document.getElementById("dc-bar")) return;
    const wrap = document.createElement("div");
    wrap.id = "dc-bar";
    wrap.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none";

    // --- action menu (hidden by default, shown above FAB) ---
    const menu = document.createElement("div");
    menu.id = "dc-fab-menu";
    menu.style.cssText = "position:relative;width:220px;background:#111827;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);overflow:hidden;padding:8px;pointer-events:none;transition:opacity .2s cubic-bezier(.34,1.56,.64,1),transform .2s cubic-bezier(.34,1.56,.64,1);opacity:0;transform:translateY(12px) scale(.95);";
    menu.setAttribute("aria-hidden", "true");

    const tooltipIconSvg = "<svg width='14' height='14' viewBox='0 0 16 16' fill='white'><circle cx='8' cy='8' r='3'/><path d='M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41'/></svg>";
    const pinIconSvg     = "<svg width='14' height='14' viewBox='0 0 16 16' fill='white'><path d='M9.5 2l.5 3.5L12 7v1H9v4l-1 2-1-2V8H4V7l2-1.5L6.5 2h3z'/></svg>";
    const exportIconSvg  = "<svg width='14' height='14' viewBox='0 0 16 16' fill='white'><path d='M8 1v9M4 6l4 4 4-4'/><rect x='2' y='13' width='12' height='2' rx='1'/></svg>";

    const mkBtn = (id, label, title, iconGrad, iconSvg, subtitle) => {
      const b = document.createElement("button");
      b.id = id;
      b.title = title;
      b.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:10px;cursor:pointer;border:none;background:#111827;color:#fff;text-align:left;transition:background .12s;";
      b.onmouseenter = () => { b.style.background = "rgba(255,255,255,.07)"; };
      b.onmouseleave = () => { b.style.background = "#111827"; };
      const iconBox = "<div style='flex-shrink:0;width:32px;height:32px;border-radius:10px;background:" + iconGrad + ";display:flex;align-items:center;justify-content:center;'>" + iconSvg + "</div>";
      const textCol = "<div style='display:flex;flex-direction:column;gap:1px;'><span style='font:600 13px/1.2 -apple-system,sans-serif;color:#fff;'>" + label + "</span><span style='font:400 11px/1.3 -apple-system,sans-serif;color:#94a3b8;'>" + subtitle + "</span></div>";
      b.innerHTML = iconBox + textCol;
      return b;
    };

    const tog = mkBtn("dc-toggle-btn", "API Tooltip",  "Show API name on hover",  "linear-gradient(135deg,#3b82f6,#2563eb)", tooltipIconSvg, "Hover to see API names");
    const inl = mkBtn("dc-inline-btn", "Pin API names","Pin API names on canvas",  "linear-gradient(135deg,#ec4899,#db2777)", pinIconSvg,     "Pin all on canvas");
    const exp = mkBtn("dc-export-btn", "Export",       "Export mappings",          "linear-gradient(135deg,#f59e0b,#d97706)", exportIconSvg,  "All fields with types");

    const separator = document.createElement("div");
    separator.style.cssText = "height:1px;background:rgba(255,255,255,.08);margin:4px 0;";

    const dismissRow = document.createElement("button");
    dismissRow.title = "Remove Data 360 Inspector";
    dismissRow.innerHTML = "<span style='font:500 12px/1 -apple-system,sans-serif;color:#ef4444;display:flex;align-items:center;gap:6px;padding:2px 0;'><span style='font-size:14px;line-height:1;'>×</span>Remove</span>";
    dismissRow.style.cssText = "display:flex;align-items:center;width:100%;padding:8px 10px;border-radius:10px;cursor:pointer;border:none;background:#111827;transition:background .12s;";
    dismissRow.onmouseenter = () => (dismissRow.style.background = "rgba(239,68,68,.08)");
    dismissRow.onmouseleave = () => (dismissRow.style.background = "#111827");
    dismissRow.onclick = (e) => { e.stopPropagation(); teardown(); };

    tog.onclick = (e) => { e.stopPropagation(); toggle(); };
    inl.onclick = (e) => { e.stopPropagation(); toggleInline(); };
    exp.onclick = (e) => { e.stopPropagation(); openExport(); };

    menu.appendChild(tog);
    menu.appendChild(inl);
    menu.appendChild(exp);
    menu.appendChild(separator);
    menu.appendChild(dismissRow);

    // --- FAB circle button ---
    const fab = document.createElement("button");
    fab.id = "dc-fab";
    fab.title = "Data 360 Inspector";
    fab.innerHTML = "<svg width='22' height='22' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'><circle cx='12' cy='12' r='10' stroke='#fff' stroke-width='1.5'/><circle cx='12' cy='4' r='1.2' fill='#fff'/><circle cx='17.7' cy='6.3' r='1.2' fill='#fff'/><circle cx='20' cy='12' r='1.2' fill='#fff'/><circle cx='17.7' cy='17.7' r='1.2' fill='#fff'/><circle cx='12' cy='20' r='1.2' fill='#fff'/><circle cx='6.3' cy='17.7' r='1.2' fill='#fff'/><circle cx='4' cy='12' r='1.2' fill='#fff'/><circle cx='6.3' cy='6.3' r='1.2' fill='#fff'/><circle cx='12' cy='9.5' r='2.5' fill='#fff'/><path d='M8 16.5c0-2.2 1.8-4 4-4s4 1.8 4 4' stroke='#fff' stroke-width='1.5' stroke-linecap='round'/></svg>";
    fab.style.cssText = "width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;pointer-events:auto;background:linear-gradient(135deg,#2d2b55 0%,#5b4f9e 100%);box-shadow:0 4px 18px rgba(91,79,158,.5);display:flex;align-items:center;justify-content:center;transition:box-shadow .15s,transform .12s;flex-shrink:0;";
    fab.onmouseenter = () => { fab.style.boxShadow = "0 6px 24px rgba(91,79,158,.65)"; fab.style.transform = "scale(1.07)"; };
    fab.onmouseleave = () => { fab.style.boxShadow = "0 4px 18px rgba(91,79,158,.5)"; fab.style.transform = "scale(1)"; };

    let menuOpen = false;
    const openMenu = () => {
      menuOpen = true;
      menu.style.opacity = "1";
      menu.style.transform = "translateY(0) scale(1)";
      menu.setAttribute("aria-hidden", "false");
      menu.style.pointerEvents = "auto";
    };
    const closeMenu = () => {
      menuOpen = false;
      menu.style.opacity = "0";
      menu.style.transform = "translateY(12px) scale(.95)";
      menu.setAttribute("aria-hidden", "true");
      menu.style.pointerEvents = "none";
    };
    fab.onclick = (e) => { e.stopPropagation(); menuOpen ? closeMenu() : openMenu(); };

    // close menu when clicking outside
    document.addEventListener("pointerdown", (e) => {
      if (menuOpen && !wrap.contains(e.target)) closeMenu();
    }, true);

    // Drag the FAB to reposition. Distinguish tap (< 6px move) from drag.
    // Uses right/bottom so the menu always stays above/left of the FAB.
    let fabDragMoved = false;
    fab.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      fabDragMoved = false;
      const r0 = wrap.getBoundingClientRect();
      let ox = r0.left, oy = r0.top;
      const mv = (ev) => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!fabDragMoved && Math.sqrt(dx*dx+dy*dy) > 5) {
          fabDragMoved = true; fab.releasePointerCapture(e.pointerId);
          wrap.style.right = "auto"; wrap.style.bottom = "auto";
          wrap.style.left = ox + "px"; wrap.style.top = oy + "px";
        }
        if (!fabDragMoved) return;
        let nx = Math.max(4, Math.min(ox + dx, window.innerWidth  - 54));
        let ny = Math.max(4, Math.min(oy + dy, window.innerHeight - 54));
        wrap.style.left = nx + "px"; wrap.style.top = ny + "px";
      };
      const up = () => {
        window.removeEventListener("pointermove", mv, true);
        window.removeEventListener("pointerup",   up, true);
        if (fabDragMoved) { setTimeout(() => { fabDragMoved = false; }, 10); }
      };
      window.addEventListener("pointermove", mv, true);
      window.addEventListener("pointerup",   up, true);
    }, true);
    // Suppress toggle-click after a drag
    fab.addEventListener("click", (e) => { if (fabDragMoved) { e.stopImmediatePropagation(); fabDragMoved = false; } }, true);

    wrap.appendChild(menu);
    wrap.appendChild(fab);
    addFabResizeGuard(wrap);
    document.body.appendChild(wrap);
  }

  // ===== DETAIL PAGE — FIELD / RELATIONSHIP CSV EXPORT =====
  // DMO: two-tab modal (Fields + Relationships) with full metadata header.
  // DataStream: single-tab field list (Field Name, Label, API, Type, Used As,
  //             Formula Field, Formula Expression, Status, Creation Type, PK).
  // DLO: discussed separately.

  function detectDetailPageType() {
    try {
      const h = location.href;
      if (/\/r\/DataStream\/[a-zA-Z0-9]{15,18}\//i.test(h)) return "DataStream";
      if (/\/r\/DataLakeObjectInstance\/[a-zA-Z0-9]{15,18}\//i.test(h)) return "DLO";
      if (/c__objectApiName=[a-zA-Z0-9_]+/i.test(h)) return "DMO";
      /* [in-development features removed from public build] */
    } catch (e) {}
    return null;
  }

  // Scans all label→value pairs from record detail layouts.
  // Handles three DOM patterns used across DS / DLO / DMO pages:
  //   1. slds-form-element  (standard Lightning layout)
  //   2. test-id__field-label-container + test-id__field-value  (record detail panels)
  //   3. item-field / item-label / item-value  (DS/DLO sidebar stacked layout)
  function readAllFormPairs() {
    const pairs = new Map();
    const clean = (v) => v.replace(/^(.+?)\1\1$/, "$1").replace(/^(.+?)\1$/, "$1");

    // Pattern 1 & 2: slds-form-element__label and test-id__field-label variants
    eachElement(document, (el) => {
      let c = ""; try { c = el.getAttribute("class") || ""; } catch (e) {}
      const isLabel = c.includes("test-id__field-label") || c.includes("slds-form-element__label");
      if (!isLabel) return;
      const label = (el.textContent || "").trim();
      if (!label || pairs.has(label)) return;
      let valEl = null;
      try {
        const form = el.closest(".slds-form-element") || el.parentElement;
        if (form) valEl = form.querySelector(".test-id__field-value,.slds-form-element__static,.slds-form-element__control .slds-truncate");
      } catch (e) {}
      if (!valEl) {
        try {
          let s = el.nextElementSibling;
          if (!s && el.parentElement) s = el.parentElement.nextElementSibling;
          if (s) { const sc = (s.getAttribute && s.getAttribute("class")) || ""; if (!/label/i.test(sc)) valEl = s; }
        } catch (e) {}
      }
      const rawVal = valEl ? (valEl.textContent || "").trim() : "";
      if (rawVal.length > 300) return;
      pairs.set(label, clean(rawVal));
    });

    // Pattern 3 removed — item-field elements are standalone value cells with no paired item-value sibling.

    return pairs;
  }

  // Read the record name from page h1. The h1 concatenates type prefix + name, e.g.
  // "Data StreamGoods Product" or "Data Lake ObjectPeronalization-identity 42AD987F".
  // Strip known prefixes to get just the record name.
  function readRecordTitle(prefix) {
    const SKIP = ["Data Cloud", "Home", "Data Streams", "Data Lake Objects", "Data Model Objects",
      "Data StreamsRecently Viewed", "Data Lake ObjectsRecently Viewed", "Data Model ObjectsRecently Viewed"];
    const prefixes = prefix ? [prefix] : ["Data Stream", "Data Lake Object", "Data Model Object"];
    const candidates = [];
    eachElement(document, (el) => {
      try {
        if ((el.tagName || "").toLowerCase() !== "h1") return;
        const txt = (el.textContent || "").trim();
        if (!txt || txt.length > 200) return;
        if (SKIP.includes(txt)) return;
        // Strip known type prefixes that get concatenated
        for (const p of prefixes) {
          if (txt.startsWith(p)) { candidates.push(txt.slice(p.length).trim()); return; }
        }
        candidates.push(txt);
      } catch (e) {}
    });
    // Last h1 is usually the most specific (deepest shadow)
    return candidates[candidates.length - 1] || candidates[0] || "";
  }

  // Collect all standalone item-field text values (used on DS/DLO sidebar — values are NOT paired).
  function readItemFieldValues() {
    const vals = [];
    eachElement(document, (el) => {
      let c = ""; try { c = el.getAttribute("class") || ""; } catch (e) {}
      if (!c.includes("item-field")) return;
      const txt = (el.textContent || "").trim();
      if (txt) vals.push(txt);
    });
    return vals;
  }

  // ── DataStream data readers ───────────────────────────────────────────────

  function readDsMetadata() {
    const pairs = readAllFormPairs();
    const get = (...keys) => {
      for (const k of keys) { const v = pairs.get(k); if (v) return v; } return "";
    };
    // item-field values: standalone sidebar values in order: category, name, apiName, connector, status, date, objectApiName...
    // Confirmed from probe: [Other, Goods Product, Goods_Product__dll, UploadedFiles, Active, ...]
    const ifVals = readItemFieldValues();
    // objectApiName ends in __dll/__dlm/__c/__ds — pick first match
    const ifApiName = ifVals.find(v => /__(dll|dlm|c|ds)$/i.test(v)) || "";
    // category is one of the known SF Data Cloud categories
    const KNOWN_CATS = /^(Other|Profile|Engagement|Behavioral|Identity|Unified|Contact\s|Order|Product|Account|Lead|Case|Event)$/i;
    const ifCategory = ifVals.find(v => KNOWN_CATS.test(v)) || "";
    // connector: matches known types
    const CONNECTORS = /^(UploadedFiles|Salesforce|S3|Azure|GCS|Marketing Cloud|MuleSoft|Heroku)/i;
    const ifConnector = ifVals.find(v => CONNECTORS.test(v)) || "";

    return {
      name:          get("Data Stream Name") || readRecordTitle("Data Stream"),
      objectApiName: ifApiName || get("Object API Name", "API Name"),
      streamType:    get("Stream Type", "Type", "Data Stream Type"),
      connectorType: ifConnector || get("Data Connector Type", "Connector Type", "Connector"),
      status:        get("Data Stream Status") || get("Status"),
      refreshMode:   get("Refresh Mode"),
      category:      ifCategory || get("Category", "Object Category"),
    };
  }

  // Identifies the field datatable by having headerLabel + fieldLabel columns
  // (not the refresh-history datatable which has startExecutionTime).
  function readDsFields() {
    const tables = findByTag("runtime_cdp-custom-datatable");
    const pick = tables.find(t => {
      const cols = safeGet(t, "columns");
      if (!Array.isArray(cols)) return false;
      const names = cols.map(c => safeGet(c, "fieldName") || "");
      return names.includes("headerLabel") && names.includes("fieldLabel");
    });
    if (!pick) return [];
    const data = safeGet(pick, "data");
    if (!Array.isArray(data)) return [];
    const boolStr = (v) => String(v || "false").toLowerCase() === "true" ? "Yes" : "No";
    return data.map(item => {
      if (!item || typeof item !== "object") return null;
      const isFormula = String(safeGet(item, "isFormulaField") || "false").toLowerCase() === "true";
      return {
        fieldName:       safeGet(item, "headerLabel")       || "",
        fieldLabel:      safeGet(item, "fieldLabel")        || safeGet(item, "label") || "",
        fieldApiName:    safeGet(item, "fieldName")         || "",
        type:            safeGet(item, "type")              || "",
        fieldUsedAs:     safeGet(item, "fieldUsedAs")       || "",
        isFormulaField:  boolStr(isFormula),
        formulaExpr:     isFormula ? (safeGet(item, "formula") || "") : "",
        status:          safeGet(item, "dataLakeFieldStatus") || "",
        creationType:    safeGet(item, "creationType")      || "",
        isPrimaryKey:    boolStr(safeGet(item, "primaryKey")),
        isEventDate:     boolStr(safeGet(item, "isEventDate")),
        isOrgUnit:       boolStr(safeGet(item, "isOrgUnit")),
        keyQualifierName: safeGet(item, "keyQualifierName") || "",
        usageTag:        safeGet(item, "usageTag")          || "",
      };
    }).filter(Boolean);
  }

  // ── DataStream export modal ───────────────────────────────────────────────

  let detailExportEl = null;
  let dcBackdropEl   = null;

  function showBackdrop(onClickClose) {
    if (dcBackdropEl) return;
    dcBackdropEl = document.createElement("div");
    dcBackdropEl.style.cssText = "position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);";
    dcBackdropEl.onclick = onClickClose;
    document.body.appendChild(dcBackdropEl);
  }
  function hideBackdrop() {
    if (dcBackdropEl) { dcBackdropEl.remove(); dcBackdropEl = null; }
  }

  // ── Detail-export (Data Stream / DLO / DMO) INSTANT tooltips ────────────────────
  // Self-contained for this feature only (own element + own bubble). No shared code —
  // changing another feature's tooltips can never affect this one. Shows any control's
  // title text immediately on hover (native title is ~1.5s and undiscoverable).
  var _deTipEl = null;
  function installDetailExportTooltips(container) {
    if (!container || container.__deTipWired) return;
    container.__deTipWired = true;
    if (!_deTipEl) {
      _deTipEl = document.createElement("div");
      _deTipEl.style.cssText = "position:fixed;display:none;z-index:2147483647;max-width:280px;background:#1e293b;color:#fff;font:500 11px/1.45 -apple-system,sans-serif;padding:7px 10px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;";
      document.body.appendChild(_deTipEl);
    }
    var show = function (el) {
      var tip = el.getAttribute("data-tip") || el.getAttribute("title");
      if (!tip) return;
      if (el.hasAttribute("title")) { el.setAttribute("data-tip", tip); el.removeAttribute("title"); }
      _deTipEl.textContent = tip; _deTipEl.style.display = "block";
      var r = el.getBoundingClientRect();
      var top = r.top - _deTipEl.offsetHeight - 8; if (top < 6) top = r.bottom + 8;
      var left = Math.min(Math.max(6, r.left), window.innerWidth - _deTipEl.offsetWidth - 6);
      _deTipEl.style.top = top + "px"; _deTipEl.style.left = left + "px";
    };
    var hide = function () { if (_deTipEl) _deTipEl.style.display = "none"; };
    container.addEventListener("mouseover", function (e) { var el = e.target && e.target.closest ? e.target.closest("[title],[data-tip]") : null; if (!el || !container.contains(el)) return; var tag = (el.tagName || "").toLowerCase(); if (tag === "td" || tag === "th") return; if (tag !== "button" && tag !== "select" && tag !== "label" && tag !== "a" && !el.hasAttribute("data-tab")) return; show(el); }, true);
    container.addEventListener("mouseout", hide, true);
    container.addEventListener("click", hide, true);
  }

  function openDsExport() {
    const meta   = readDsMetadata();
    const fields = readDsFields();

    const DS_COLS = [
      ["fieldName",       "Field Name"],
      ["fieldLabel",      "Field Label"],
      ["fieldApiName",    "Field API Name"],
      ["type",            "Data Type"],
      ["fieldUsedAs",     "Field Used As"],
      ["isFormulaField",  "Formula Field"],
      ["formulaExpr",     "Formula Expression"],
      ["status",          "Status"],
      ["creationType",    "Creation Type"],
      ["isPrimaryKey",    "Primary Key"],
      ["isEventDate",     "Is Event Date"],
      ["isOrgUnit",       "Is Org Unit"],
      ["keyQualifierName","Key Qualifier Name"],
      ["usageTag",        "Usage Tag"],
    ];
    const csvEsc = (s) => { const t = String(s==null?"":s); return /[",\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t; };
    const tsvEsc = (s) => String(s==null?"":s).replace(/\t/g," ");
    const buildMetaStr = () => {
      const parts = [];
      if (meta.name)          parts.push("Data Stream: " + meta.name);
      if (meta.objectApiName) parts.push("API Name: " + meta.objectApiName);
      if (meta.streamType)    parts.push("Type: " + meta.streamType);
      if (meta.connectorType) parts.push("Connector: " + meta.connectorType);
      if (meta.status)        parts.push("Status: " + meta.status);
      if (meta.refreshMode)   parts.push("Refresh Mode: " + meta.refreshMode);
      if (meta.category)      parts.push("Category: " + meta.category);
      return parts.join("\n");
    };
    const toText = (rows, cols, sep) => {
      const e = sep === "," ? csvEsc : tsvEsc;
      const dataRows = cols.map(c=>c[1]).join(sep)+"\n"+rows.map(r=>cols.map(c=>e(r[c[0]])).join(sep)).join("\n");
      return dataRows + "\n\n" + e(buildMetaStr());
    };
    const buildMetaXlsxRow = () => [buildMetaStr()];
    const download = (text, filename) => {
      try {
        const b=new Blob([text],{type:"text/csv"});
        const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=filename;
        document.body.appendChild(a); a.click(); a.remove();
      } catch(e){}
    };
    const esc = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const chip = (text, color) => text ? "<span style='display:inline-block;padding:1px 8px;border-radius:10px;background:" + color + ";color:#fff;font-size:11px;margin:0 2px'>" + esc(text) + "</span>" : "";
    const safeFilename = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g,"_");

    if (!detailExportEl) { detailExportEl=document.createElement("div"); document.body.appendChild(detailExportEl); }
    detailExportEl.id="dc-detail-export";
    detailExportEl.style.cssText="position:fixed;top:4vh;left:50%;transform:translateX(-50%);z-index:2147483647;width:min(1200px,97vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;color:#16325c;border:1px solid #c9cede;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.5);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden";

    const fieldTrs = fields.map(r =>
      "<tr>" +
      "<td>" + esc(r.fieldName) + "</td>" +
      "<td>" + esc(r.fieldLabel) + "</td>" +
      "<td class='api'>" + esc(r.fieldApiName) + "</td>" +
      "<td>" + esc(r.type) + "</td>" +
      "<td>" + esc(r.fieldUsedAs) + "</td>" +
      "<td class='center'>" + esc(r.isFormulaField) + "</td>" +
      "<td class='mono small'>" + esc(r.formulaExpr) + "</td>" +
      "<td><span class='badge " + (r.status==="ACTIVE"?"active":"inactive") + "'>" + esc(r.status) + "</span></td>" +
      "<td>" + esc(r.creationType) + "</td>" +
      "<td class='center'>" + esc(r.isPrimaryKey) + "</td>" +
      "</tr>"
    ).join("") || "<tr><td colspan='10' class='empty'>No fields found. Make sure the Fields tab is active.</td></tr>";

    detailExportEl.innerHTML =
      "<style>" +
      "#dc-detail-export .hd{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#f3f6fb;border-bottom:1px solid #e0e5ee;flex-shrink:0;flex-wrap:wrap}" +
      "#dc-detail-export .hd strong{font-size:15px;flex-shrink:0}" +
      "#dc-detail-export .toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e0e5ee;background:#fff;flex-shrink:0}" +
      "#dc-detail-export .sp{flex:1 1 0}" +
      "#dc-detail-export button{flex:1;min-width:0;white-space:nowrap;border:1px solid #0b5cab;background:#0b5cab;color:#fff;border-radius:6px;padding:7px 10px;font-weight:600;cursor:pointer;font-size:12px;text-align:center}" +
      "#dc-detail-export button.sec{background:#fff;color:#0b5cab}" +
      "#dc-detail-export .x{flex:0 0 auto;min-width:auto;border:none;background:transparent;color:#5c6b8a;font-size:20px;padding:0 4px;cursor:pointer;line-height:1;margin-left:4px}" +
      "#dc-detail-export .bd{overflow:auto;flex:1;min-height:0}" +
      "#dc-detail-export table{border-collapse:collapse;width:100%;font-size:12px}" +
      "#dc-detail-export th{position:sticky;top:0;background:#fff;text-align:left;padding:7px 10px;border-bottom:2px solid #e0e5ee;color:#5c6b8a;font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}" +
      "#dc-detail-export td{padding:5px 10px;border-bottom:1px solid #eef1f6;vertical-align:top}" +
      "#dc-detail-export td.api{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#0b5cab}" +
      "#dc-detail-export td.mono{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#6b1f9a;word-break:break-all;max-width:280px}" +
      "#dc-detail-export td.small{font-size:10px}" +
      "#dc-detail-export td.center{text-align:center;color:#5c6b8a}" +
      "#dc-detail-export .badge{display:inline-block;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600}" +
      "#dc-detail-export .badge.active{background:#d4f0db;color:#0a6b2d}" +
      "#dc-detail-export .badge.inactive{background:#f0d4d4;color:#6b0a0a}" +
      "#dc-detail-export .empty{padding:24px;text-align:center;color:#8a94ab}" +
      "#dc-detail-export .meta-bar{display:flex;flex-wrap:wrap;gap:4px 18px;padding:7px 16px;background:#f9fafc;border-bottom:1px solid #e0e5ee;font-size:11px;color:#5c6b8a;flex-shrink:0}" +
      "#dc-detail-export .meta-bar b{color:#16325c}" +
      "#dc-detail-export .ft{padding:6px 16px;border-top:1px solid #e0e5ee;color:#8a94ab;font-size:11px;background:#f9fafc;flex-shrink:0}" +
      "</style>" +
      "<div class='hd'>" +
        "<strong>" + esc(meta.name || "Data Stream") + "</strong>" +
        (meta.streamType    ? chip(meta.streamType,    "#0b5cab") : "") +
        (meta.connectorType ? chip(meta.connectorType, "#6b1f9a") : "") +
        (meta.status        ? chip(meta.status.replace(/active/i,"Active").replace(/inactive/i,"Inactive"), meta.status.toLowerCase().includes("active")?"#0a6b2d":"#8a94ab") : "") +
        (meta.refreshMode   ? chip(meta.refreshMode,   "#5c6b8a") : "") +
        "<span class='sp'></span><button class='x' id='dc-d-close'>&times;</button>" +
      "</div>" +
      "<div class='meta-bar'>" +
        (meta.name          ? "<span><b>Name:</b> " + esc(meta.name)              + "</span>" : "") +
        (meta.objectApiName ? "<span><b>API Name:</b> <span style='font-family:SF Mono,Menlo,monospace'>" + esc(meta.objectApiName) + "</span></span>" : "") +
        (meta.category      ? "<span><b>Category:</b> " + esc(meta.category)      + "</span>" : "") +
        (meta.streamType    ? "<span><b>Stream Type:</b> " + esc(meta.streamType)    + "</span>" : "") +
        (meta.connectorType ? "<span><b>Connector:</b> " + esc(meta.connectorType) + "</span>" : "") +
        (meta.refreshMode   ? "<span><b>Refresh Mode:</b> " + esc(meta.refreshMode)  + "</span>" : "") +
        (meta.status        ? "<span><b>Status:</b> " + esc(meta.status)           + "</span>" : "") +
      "</div>" +
      "<div class='toolbar'>" +
        "<button id='dc-d-copy'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets</button>" +
        "<button class='sec' id='dc-d-csv'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><path d='M3 2h7l3 3v9H3z' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M10 2v3h3'/><path d='M6 9l2 2 2-2M8 7v4'/></svg>Download CSV</button>" +
      "</div>" +
      "<div class='bd'><table><thead><tr>" +
        "<th>Field Name</th><th>Field Label</th><th>Field API Name</th><th>Data Type</th>" +
        "<th>Field Used As</th><th>Formula</th><th>Formula Expression</th><th>Status</th>" +
        "<th>Creation Type</th><th>PK</th>" +
      "</tr></thead><tbody>" + fieldTrs + "</tbody></table></div>" +
      "<div class='ft'>" + fields.length + " field(s)" +
        (meta.name          ? " · " + esc(meta.name)          : "") +
        (meta.streamType    ? " · " + esc(meta.streamType)    : "") +
        (meta.connectorType ? " · " + esc(meta.connectorType) : "") +
      "</div>";

    const closeDetail = () => { if (detailExportEl) { detailExportEl.remove(); detailExportEl=null; } hideBackdrop(); };
    detailExportEl.querySelector("#dc-d-close").onclick = closeDetail;
    detailExportEl.querySelector("#dc-d-copy").onclick = (e) => {
      navigator.clipboard.writeText(toText(fields, DS_COLS, "\t")).then(() => {
        e.target.textContent = "✓ Copied!"; setTimeout(() => (e.target.innerHTML = "<svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets"), 1200);
      }).catch(()=>{});
    };
    detailExportEl.querySelector("#dc-d-csv").onclick = () => {
      download(toText(fields, DS_COLS, ","), safeFilename(meta.name||"datastream")+"-fields.csv");
    };
    const hd=detailExportEl.querySelector(".hd"); if(hd) makeDraggable(detailExportEl,hd);
    addResizeHandle(detailExportEl, 480, 300);
    try { installDetailExportTooltips(detailExportEl); } catch (e) {}
    const onEsc=(e)=>{ if(e.key==="Escape"){closeDetail();document.removeEventListener("keydown",onEsc,true);} };
    document.addEventListener("keydown",onEsc,true);
    const onOut=(e)=>{ if(detailExportEl&&!detailExportEl.contains(e.target)){closeDetail();document.removeEventListener("pointerdown",onOut,true);} };
    setTimeout(()=>document.addEventListener("pointerdown",onOut,true),100);
  }

  // ── DLO data readers ─────────────────────────────────────────────────────

  function readDloMetadata() {
    const pairs = readAllFormPairs();
    const get = (...keys) => { for (const k of keys) { const v = pairs.get(k); if (v) return v; } return ""; };

    // item-field standalone values (no paired item-value — confirmed by probe).
    // Order from probe: [category, name, apiName(__dll), connector, status, date, objectApiName, ...]
    const ifVals = readItemFieldValues();

    // API name: first item-field value ending in __dll/__dlm/__c
    const apiName = ifVals.find(v => /__(dll|dlm|c)$/i.test(v)) || get("API Name", "Object API Name");

    // DLO name: item-field value that is NOT an apiName, category, connector, date, status, or blank
    // From probe: e.g. "Peronalization-identity 42AD987F", "Goods Product"
    const KNOWN_CATS = /^(Other|Profile|Engagement|Behavioral|Identity|Unified|Contact\s|Order|Product|Account|Lead|Case|Event)$/i;
    const CONNECTORS = /^(UploadedFiles|Salesforce|S3|Azure|GCS|Marketing Cloud|MuleSoft|Heroku)/i;
    const STATUS_RE  = /^(Active|Inactive|Draft|Deprecated)$/i;
    const DATE_RE    = /^\d{1,2}\/\d{1,2}\/\d{4}/;
    const dloName = ifVals.find(v =>
      v.length > 2 &&
      !KNOWN_CATS.test(v) &&
      !CONNECTORS.test(v) &&
      !STATUS_RE.test(v) &&
      !DATE_RE.test(v) &&
      !/__(dll|dlm|c)$/i.test(v) &&
      !/^[A-Z0-9_]+$/.test(v)   // skip all-caps identifiers
    ) || get("Name", "Data Lake Object Name") || readRecordTitle("Data Lake Object");

    const category = ifVals.find(v => KNOWN_CATS.test(v)) || get("Category", "Object Category");
    const status   = ifVals.find(v => STATUS_RE.test(v))  || get("Data Lake Object Status", "Status");

    return { apiName, name: dloName, category, status };
  }

  // DLO field table: identified by columns having "fieldLabel" + "keyQualifier" fieldNames.
  function readDloFields() {
    const tables = findByTag("runtime_cdp-custom-datatable");
    const pick = tables.find(t => {
      const cols = safeGet(t, "columns");
      if (!Array.isArray(cols)) return false;
      const names = cols.map(c => safeGet(c, "fieldName") || "");
      return names.includes("fieldLabel") && names.includes("keyQualifier");
    });
    if (!pick) return [];
    const data = safeGet(pick, "data");
    if (!Array.isArray(data)) return [];

    const extractMulti = (v) => {
      if (!v) return "";
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v.map(x => x && (safeGet(x, "label") || safeGet(x, "name") || String(x))).filter(Boolean).join("; ");
      return "";
    };
    const boolStr = (v) => String(v || "false").toLowerCase() === "true" ? "Yes" : "No";

    return data.map(item => {
      if (!item || typeof item !== "object") return null;
      const kq = safeGet(item, "keyQualifier");
      const keyQualifier = kq ? (typeof kq === "object" ? (safeGet(kq, "label") || safeGet(kq, "name") || "") : String(kq)) : "";
      return {
        fieldLabel:           safeGet(item, "fieldLabel") || safeGet(item, "label") || "",
        fieldApiName:         safeGet(item, "fieldName")  || "",
        type:                 safeGet(item, "type")       || "",
        fieldUsedAs:          safeGet(item, "fieldUsedAs") || "",
        keyQualifier,
        keyQualifierName:     safeGet(item, "keyQualifierName") || "",
        assignedTags:         extractMulti(safeGet(item, "assignedTags")),
        assignedClassifications: extractMulti(safeGet(item, "assignedClassifications")),
        status:               safeGet(item, "dataLakeFieldStatus") || "",
        creationType:         safeGet(item, "creationType") || "",
        isPrimaryKey:         boolStr(safeGet(item, "primaryKey")),
        isEventDate:          boolStr(safeGet(item, "isEventDate")),
        isOrgUnit:            boolStr(safeGet(item, "isOrgUnit")),
        usageTag:             safeGet(item, "usageTag") || "",
      };
    }).filter(Boolean);
  }

  // ── DLO export modal ──────────────────────────────────────────────────────

  function openDloExport() {
    const meta   = readDloMetadata();
    const fields = readDloFields();

    const DLO_COLS = [
      ["fieldLabel",            "Field Label"],
      ["fieldApiName",          "Field API Name"],
      ["type",                  "Data Type"],
      ["fieldUsedAs",           "Field Used As"],
      ["keyQualifier",          "Key Qualifier"],
      ["keyQualifierName",      "Key Qualifier Name"],
      ["assignedTags",          "Tags"],
      ["assignedClassifications","Classifications"],
      ["status",                "Status"],
      ["creationType",          "Creation Type"],
      ["isPrimaryKey",          "Primary Key"],
      ["isEventDate",           "Is Event Date"],
      ["isOrgUnit",             "Is Org Unit"],
      ["usageTag",              "Usage Tag"],
    ];
    const csvEsc = (s) => { const t=String(s==null?"":s); return /[",\n]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t; };
    const tsvEsc = (s) => String(s==null?"":s).replace(/\t/g," ");
    const buildMetaStr = () => {
      const parts = [];
      if (meta.name)     parts.push("DLO: " + meta.name);
      if (meta.apiName)  parts.push("API Name: " + meta.apiName);
      if (meta.category) parts.push("Category: " + meta.category);
      if (meta.status)   parts.push("Status: " + meta.status);
      return parts.join("\n");
    };
    const toText = (rows, cols, sep) => {
      const e = sep===","?csvEsc:tsvEsc;
      const dataRows = cols.map(c=>c[1]).join(sep)+"\n"+rows.map(r=>cols.map(c=>e(r[c[0]])).join(sep)).join("\n");
      return dataRows + "\n\n" + e(buildMetaStr());
    };
    const buildMetaXlsxRow = () => [buildMetaStr()];
    const download = (text, fn) => {
      try { const b=new Blob([text],{type:"text/csv"}); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=fn; document.body.appendChild(a); a.click(); a.remove(); } catch(e){}
    };
    const esc = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const chip = (text, color) => text ? "<span style='display:inline-block;padding:1px 8px;border-radius:10px;background:"+color+";color:#fff;font-size:11px;margin:0 2px'>"+esc(text)+"</span>" : "";
    const safeFilename = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g,"_");

    if (!detailExportEl) { detailExportEl=document.createElement("div"); document.body.appendChild(detailExportEl); }
    detailExportEl.id="dc-detail-export";
    detailExportEl.style.cssText="position:fixed;top:4vh;left:50%;transform:translateX(-50%);z-index:2147483647;width:min(1100px,97vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;color:#16325c;border:1px solid #c9cede;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.5);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden";

    const fieldTrs = fields.map(r =>
      "<tr>" +
      "<td>" + esc(r.fieldLabel) + "</td>" +
      "<td class='api'>" + esc(r.fieldApiName) + "</td>" +
      "<td>" + esc(r.type) + "</td>" +
      "<td>" + esc(r.fieldUsedAs) + "</td>" +
      "<td class='mono'>" + esc(r.keyQualifier) + "</td>" +
      "<td>" + esc(r.assignedTags) + "</td>" +
      "<td>" + esc(r.assignedClassifications) + "</td>" +
      "<td><span class='badge " + (r.status==="ACTIVE"?"active":"inactive") + "'>" + esc(r.status) + "</span></td>" +
      "<td class='center'>" + esc(r.isPrimaryKey) + "</td>" +
      "</tr>"
    ).join("") || "<tr><td colspan='9' class='empty'>No fields found. Make sure the Fields tab is active.</td></tr>";

    detailExportEl.innerHTML =
      "<style>" +
      "#dc-detail-export .hd{display:flex;align-items:center;gap:8px;padding:10px 16px;background:#f3f6fb;border-bottom:1px solid #e0e5ee;flex-shrink:0;flex-wrap:wrap}" +
      "#dc-detail-export .hd strong{font-size:15px;flex-shrink:0}" +
      "#dc-detail-export .hd .sub{font:11px 'SF Mono',Menlo,monospace;color:#5c6b8a;min-width:0}" +
      "#dc-detail-export .toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #e0e5ee;background:#fff;flex-shrink:0}" +
      "#dc-detail-export .sp{flex:1 1 0}" +
      "#dc-detail-export button{flex:1;min-width:0;white-space:nowrap;border:1px solid #0b5cab;background:#0b5cab;color:#fff;border-radius:6px;padding:7px 10px;font-weight:600;cursor:pointer;font-size:12px;text-align:center}" +
      "#dc-detail-export button.sec{background:#fff;color:#0b5cab}" +
      "#dc-detail-export .x{flex:0 0 auto;min-width:auto;border:none;background:transparent;color:#5c6b8a;font-size:20px;padding:0 4px;cursor:pointer;line-height:1;margin-left:4px}" +
      "#dc-detail-export .bd{overflow:auto;flex:1;min-height:0}" +
      "#dc-detail-export table{border-collapse:collapse;width:100%;font-size:12px}" +
      "#dc-detail-export th{position:sticky;top:0;background:#fff;text-align:left;padding:7px 10px;border-bottom:2px solid #e0e5ee;color:#5c6b8a;font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}" +
      "#dc-detail-export td{padding:5px 10px;border-bottom:1px solid #eef1f6;vertical-align:top}" +
      "#dc-detail-export td.api{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#0b5cab}" +
      "#dc-detail-export td.mono{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#6b1f9a}" +
      "#dc-detail-export td.center{text-align:center;color:#5c6b8a}" +
      "#dc-detail-export .badge{display:inline-block;padding:1px 7px;border-radius:8px;font-size:10px;font-weight:600}" +
      "#dc-detail-export .badge.active{background:#d4f0db;color:#0a6b2d}" +
      "#dc-detail-export .badge.inactive{background:#f0d4d4;color:#6b0a0a}" +
      "#dc-detail-export .empty{padding:24px;text-align:center;color:#8a94ab}" +
      "#dc-detail-export .meta-bar{display:flex;flex-wrap:wrap;gap:4px 18px;padding:7px 16px;background:#f9fafc;border-bottom:1px solid #e0e5ee;font-size:11px;color:#5c6b8a;flex-shrink:0}" +
      "#dc-detail-export .meta-bar b{color:#16325c}" +
      "#dc-detail-export .ft{padding:6px 16px;border-top:1px solid #e0e5ee;color:#8a94ab;font-size:11px;background:#f9fafc;flex-shrink:0}" +
      "</style>" +
      "<div class='hd'>" +
        "<strong>" + esc(meta.name || meta.apiName || "Data Lake Object") + "</strong>" +
        "<span class='sub'>" + esc(meta.apiName) + "</span>" +
        (meta.category ? chip(meta.category, "#0b5cab") : "") +
        (meta.status   ? chip(meta.status, meta.status.toLowerCase()==="active"?"#0a6b2d":"#8a94ab") : "") +
        "<span class='sp'></span><button class='x' id='dc-d-close'>&times;</button>" +
      "</div>" +
      "<div class='meta-bar'>" +
        (meta.name     ? "<span><b>DLO Name:</b> " + esc(meta.name)     + "</span>" : "") +
        (meta.apiName  ? "<span><b>API Name:</b> <span style='font-family:SF Mono,Menlo,monospace'>" + esc(meta.apiName) + "</span></span>" : "") +
        (meta.category ? "<span><b>Category:</b> " + esc(meta.category) + "</span>" : "") +
        (meta.status   ? "<span><b>Status:</b> "   + esc(meta.status)   + "</span>" : "") +
      "</div>" +
      "<div class='toolbar'>" +
        "<button id='dc-d-copy'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets</button>" +
        "<button class='sec' id='dc-d-csv'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><path d='M3 2h7l3 3v9H3z' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M10 2v3h3'/><path d='M6 9l2 2 2-2M8 7v4'/></svg>Download CSV</button>" +
      "</div>" +
      "<div class='bd'><table><thead><tr>" +
        "<th>Field Label</th><th>Field API Name</th><th>Data Type</th><th>Field Used As</th>" +
        "<th>Key Qualifier</th><th>Tags</th><th>Classifications</th><th>Status</th><th>PK</th>" +
      "</tr></thead><tbody>" + fieldTrs + "</tbody></table></div>" +
      "<div class='ft'>" + fields.length + " field(s)" +
        (meta.name     ? " · " + esc(meta.name)     : "") +
        (meta.apiName  ? " · " + esc(meta.apiName)  : "") +
        (meta.category ? " · " + esc(meta.category) : "") +
      "</div>";

    const closeDetail = () => { if (detailExportEl) { detailExportEl.remove(); detailExportEl=null; } hideBackdrop(); };
    detailExportEl.querySelector("#dc-d-close").onclick = closeDetail;
    detailExportEl.querySelector("#dc-d-copy").onclick = (e) => {
      navigator.clipboard.writeText(toText(fields, DLO_COLS, "\t")).then(() => {
        e.target.textContent = "✓ Copied!"; setTimeout(() => (e.target.innerHTML = "<svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets"), 1200);
      }).catch(()=>{});
    };
    detailExportEl.querySelector("#dc-d-csv").onclick = () => {
      download(toText(fields, DLO_COLS, ","), safeFilename(meta.apiName||meta.name||"dlo")+"-fields.csv");
    };
    const hd=detailExportEl.querySelector(".hd"); if(hd) makeDraggable(detailExportEl,hd);
    addResizeHandle(detailExportEl, 480, 300);
    try { installDetailExportTooltips(detailExportEl); } catch (e) {}
    const onEsc=(e)=>{ if(e.key==="Escape"){closeDetail();document.removeEventListener("keydown",onEsc,true);} };
    document.addEventListener("keydown",onEsc,true);
    const onOut=(e)=>{ if(detailExportEl&&!detailExportEl.contains(e.target)){closeDetail();document.removeEventListener("pointerdown",onOut,true);} };
    setTimeout(()=>document.addEventListener("pointerdown",onOut,true),100);
  }

  // ── DMO data readers ──────────────────────────────────────────────────────

  // Read DMO metadata from runtime_cdp-data-model-tab-object-details-dialog-fields.objectDetails
  function readDmoMetadata() {
    const els = findByTag("runtime_cdp-data-model-tab-object-details-dialog-fields");
    for (const el of els) {
      const od = safeGet(el, "objectDetails");
      if (!od || typeof od !== "object") continue;
      const dataStreams   = Array.isArray(safeGet(od, "dataStream"))   ? safeGet(od, "dataStream")   : [];
      const dataLakeObjs  = Array.isArray(safeGet(od, "dataLakeObject")) ? safeGet(od, "dataLakeObject") : [];
      return {
        name:           safeGet(od, "name")     || "",
        label:          safeGet(od, "label")    || "",
        category:       safeGet(od, "category") || "",
        description:    safeGet(od, "description") || "",
        dataStreams,
        dataLakeObjects: dataLakeObjs,
      };
    }
    // URL fallback
    let apiName = "";
    try {
      const m = location.href.match(/[?&]c__objectApiName=([^&]+)/i);
      if (m) apiName = decodeURIComponent(m[1]);
    } catch (e) {}
    return { name: apiName, label: "", category: "", description: "", dataStreams: [], dataLakeObjects: [] };
  }

  // Read all field rows from the DMO datatable (runtime_cdp-custom-datatable with isMapped col).
  function readDmoFields() {
    const tables = findByTag("runtime_cdp-custom-datatable");
    // DMO table has isMapped column; prefer visible but fall back if hidden (tab not active)
    const pick = tables.find(t => {
      const cols = safeGet(t, "columns");
      return Array.isArray(cols) && cols.some(c => safeGet(c, "fieldName") === "isMapped");
    });
    if (!pick) return [];
    const data = safeGet(pick, "data");
    if (!Array.isArray(data)) return [];

    const extractMulti = (v) => {
      if (!v) return "";
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return v.map(x => (x && (safeGet(x, "label") || safeGet(x, "name") || String(x)))).filter(Boolean).join("; ");
      return "";
    };
    const boolStr = (v) => { const s = String(v || "false").toLowerCase(); return s === "true" ? "True" : "False"; };

    return data.map(item => {
      if (!item || typeof item !== "object") return null;
      const pf = safeGet(item, "parentField");
      const keyQualifier = pf ? (typeof pf === "object" ? (safeGet(pf, "label") || safeGet(pf, "name") || "") : String(pf)) : "";
      return {
        label:                  safeGet(item, "label")    || "",
        name:                   safeGet(item, "name")     || "",
        type:                   safeGet(item, "type")     || "",
        isMapped:               boolStr(safeGet(item, "isMapped")),
        isDistinct:             boolStr(safeGet(item, "isDistinct")),
        keyQualifier,
        assignedTags:           extractMulti(safeGet(item, "assignedTags")),
        assignedClassifications: extractMulti(safeGet(item, "assignedClassifications")),
        isPrimaryKey:           boolStr(safeGet(item, "isPrimaryKey")),
        creationType:           safeGet(item, "creationType") || "",
        usageTag:               safeGet(item, "UsageTag")     || "",
      };
    }).filter(Boolean);
  }

  // Read relationships — include all rows (isActive can be boolean true or string "true")
  function readDmoRelationships() {
    const els = findByTag("runtime_cdp-data-model-tab-object-details-dialog-relationships");
    for (const el of els) {
      const raw = safeGet(el, "relationships");
      if (!Array.isArray(raw) || !raw.length) continue;
      const isActiveVal = (r) => {
        const v = safeGet(r, "isActive");
        return v === true || v === "true";
      };
      // Use all rows if none have isActive=true (field may not exist), otherwise filter
      const filtered = raw.filter(r => r && isActiveVal(r));
      const rows = filtered.length ? filtered : raw.filter(Boolean);
      return rows.map(r => ({
        sourceEntityLabel:  safeGet(r, "sourceEntityLabel")  || safeGet(r, "objectLabel")  || "",
        sourceEntity:       safeGet(r, "sourceEntity")       || safeGet(r, "objectApiName") || "",
        sourceFieldLabel:   safeGet(r, "sourceFieldLabel")   || safeGet(r, "fieldLabel")   || "",
        sourceField:        safeGet(r, "sourceField")        || safeGet(r, "fieldApiName") || "",
        keyQualifierSource: safeGet(r, "keyQualifierSource") || safeGet(r, "keyQualifier") || "",
        cardinality:        safeGet(r, "cardinality")        || "",
        cardinalityLabel:   safeGet(r, "cardinalityLabel")   || safeGet(r, "cardinality")  || "",
        targetEntityLabel:  safeGet(r, "targetEntityLabel")  || safeGet(r, "relatedObjectLabel")  || "",
        targetEntity:       safeGet(r, "targetEntity")       || safeGet(r, "relatedObjectApiName") || "",
        targetFieldLabel:   safeGet(r, "targetFieldLabel")   || safeGet(r, "relatedFieldLabel")   || "",
        targetField:        safeGet(r, "targetField")        || safeGet(r, "relatedFieldApiName") || "",
        keyQualifierTarget: safeGet(r, "keyQualifierTarget") || "",
      }));
    }
    return [];
  }

  // ── DMO export modal ──────────────────────────────────────────────────────

  // Minimal XLSX builder — produces a real .xlsx (Office Open XML) with multiple sheets.
  // No external library needed; uses only base64 + Blob.
  // buildXlsx(sheets, opts)
  // sheets: [{name, rows, headerRow?}]
  //   rows: array of arrays of cell values (string/number/null)
  //   headerRow: 1-based row index to bold (default 1)
  // opts.wrapLastRow: if true, last row's first cell gets wrapText (for multi-line meta cell)
  function buildXlsx(sheets, opts) {
    opts = opts || {};
    const xmlEsc = (s) => String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const colLetter = (n) => { let s=""; n++; while(n>0){s=String.fromCharCode(64+(n%26||26))+s;n=Math.floor((n-(n%26?0:26))/26);} return s; };

    // Style IDs: 0=normal, 1=bold, 2=wrap (for meta cell)
    const stylesXml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
      "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">" +
      "<fonts count=\"2\"><font><sz val=\"11\"/></font><font><b/><sz val=\"11\"/></font></fonts>" +
      "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>" +
      "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>" +
      "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>" +
      "<cellXfs count=\"3\">" +
        "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>" +           // 0: normal
        "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>" +           // 1: bold
        "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"><alignment wrapText=\"1\"/></xf>" + // 2: wrap
      "</cellXfs>" +
      "</styleSheet>";

    const sharedStrings = []; const ssIndex = {};
    const si = (v) => { const s=String(v==null?"":v); if(s in ssIndex) return ssIndex[s]; const i=sharedStrings.length; sharedStrings.push(s); ssIndex[s]=i; return i; };

    const sheetXmls = sheets.map(({name, rows, headerRow}) => {
      const hRow = (headerRow != null ? headerRow : 1); // which row is bold (1-based)
      const totalRows = rows.length;
      const cells = rows.map((row, ri) => {
        const rowNum = ri + 1;
        const isBoldRow = rowNum === hRow;
        const isLastRow = rowNum === totalRows;
        return row.map((val, ci) => {
          const ref = colLetter(ci) + rowNum;
          let sAttr = "";
          if (isBoldRow) sAttr = " s=\"1\"";
          else if (isLastRow && ci === 0 && opts.wrapLastRow) sAttr = " s=\"2\"";
          if (typeof val === "number" && isFinite(val)) return "<c r=\""+ref+"\""+sAttr+" t=\"n\"><v>"+val+"</v></c>";
          // For strings with newlines, use inline string <is> instead of shared string
          const str = String(val==null?"":val);
          if (str.includes("\n")) {
            const parts = str.split("\n").map(p=>"<r><t xml:space=\"preserve\">"+xmlEsc(p)+"</t></r>").join("");
            return "<c r=\""+ref+"\""+sAttr+" t=\"inlineStr\"><is>"+parts+"</is></c>";
          }
          return "<c r=\""+ref+"\""+sAttr+" t=\"s\"><v>"+si(val)+"</v></c>";
        }).join("");
      }).map((rowCells, ri) => "<row r=\""+(ri+1)+"\">"+rowCells+"</row>").join("");
      return "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>"+cells+"</sheetData></worksheet>";
    });

    const ssXml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" count=\""+sharedStrings.length+"\" uniqueCount=\""+sharedStrings.length+"\">"+
      sharedStrings.map(s=>"<si><t xml:space=\"preserve\">"+xmlEsc(s)+"</t></si>").join("")+"</sst>";

    const sheetNames = sheets.map(s=>s.name);
    const wbXml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>"+
      sheetNames.map((n,i)=>"<sheet name=\""+xmlEsc(n)+"\" sheetId=\""+(i+1)+"\" r:id=\"rId"+(i+1)+"\"/>").join("")+"</sheets></workbook>";

    const relsXml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"+
      sheetNames.map((_,i)=>"<Relationship Id=\"rId"+(i+1)+"\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet"+(i+1)+".xml\"/>").join("")+
      "<Relationship Id=\"rId"+(sheetNames.length+1)+"\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\" Target=\"sharedStrings.xml\"/>"+
      "<Relationship Id=\"rId"+(sheetNames.length+2)+"\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>";

    const pkgRels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>";
    const ct = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"+
      sheetNames.map((_,i)=>"<Override PartName=\"/xl/worksheets/sheet"+(i+1)+".xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>").join("")+"</Types>";

    const enc = new TextEncoder();
    const files = [
      ["[Content_Types].xml",        enc.encode(ct)],
      ["_rels/.rels",                enc.encode(pkgRels)],
      ["xl/workbook.xml",            enc.encode(wbXml)],
      ["xl/_rels/workbook.xml.rels", enc.encode(relsXml)],
      ["xl/sharedStrings.xml",       enc.encode(ssXml)],
      ["xl/styles.xml",              enc.encode(stylesXml)],
      ...sheetXmls.map((xml, i) => ["xl/worksheets/sheet"+(i+1)+".xml", enc.encode(xml)]),
    ];
    const u32 = (n) => { const b=new Uint8Array(4); new DataView(b.buffer).setUint32(0,n,true); return b; };
    const u16 = (n) => { const b=new Uint8Array(2); new DataView(b.buffer).setUint16(0,n,true); return b; };
    const crc32 = (data) => {
      let c = 0xFFFFFFFF;
      const t = new Uint32Array(256); for(let i=0;i<256;i++){let x=i;for(let j=0;j<8;j++) x=x&1?(x>>>1)^0xEDB88320:(x>>>1);t[i]=x;}
      for(const b of data) c=t[(c^b)&0xff]^(c>>>8);
      return (c^0xFFFFFFFF)>>>0;
    };
    const chunks = []; const centralDir = []; let offset = 0;
    for (const [name, data] of files) {
      const nameBytes = enc.encode(name);
      const crc = crc32(data);
      const local = new Uint8Array([0x50,0x4B,0x03,0x04,20,0,0,0,0,0,0,0,0,0,...u32(crc),...u32(data.length),...u32(data.length),...u16(nameBytes.length),...u16(0),...nameBytes,...data]);
      centralDir.push({nameBytes, crc, size: data.length, offset});
      chunks.push(local);
      offset += local.length;
    }
    const cdStart = offset;
    for (const {nameBytes, crc, size, offset: off} of centralDir) {
      chunks.push(new Uint8Array([0x50,0x4B,0x01,0x02,20,0,20,0,0,0,0,0,0,0,0,0,...u32(crc),...u32(size),...u32(size),...u16(nameBytes.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(off),...nameBytes]));
    }
    const cdSize = chunks.reduce((a,c)=>a+c.length,0) - cdStart;
    chunks.push(new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,...u16(centralDir.length),...u16(centralDir.length),...u32(cdSize),...u32(cdStart),0,0]));
    const total = chunks.reduce((a,c)=>a+c.length,0);
    const buf = new Uint8Array(total); let pos=0;
    for(const c of chunks){buf.set(c,pos);pos+=c.length;}
    return buf;
  }

  function openDmoExport() {
    const meta  = readDmoMetadata();
    const fields = readDmoFields();
    const rels   = readDmoRelationships();

    const FIELD_COLS = [
      ["label",                   "Field Label"],
      ["name",                    "Field API Name"],
      ["type",                    "Data Type"],
      ["isMapped",                "Is Mapped"],
      ["isDistinct",              "Enable Value Suggestion"],
      ["keyQualifier",            "Key Qualifier"],
      ["assignedTags",            "Tags"],
      ["assignedClassifications", "Classifications"],
      ["isPrimaryKey",            "Is Primary Key"],
      ["creationType",            "Creation Type"],
      ["usageTag",                "Usage Tag"],
    ];
    // Include the API names alongside each label (the UI shows both stacked; the export
    // was label-only). Order mirrors the on-screen columns: each label is followed by its
    // API name so a reader can map DMO/field label → API name directly.
    const REL_COLS = [
      ["sourceEntityLabel",  "Object"],
      ["sourceEntity",       "Object API Name"],
      ["sourceFieldLabel",   "Field"],
      ["sourceField",        "Field API Name"],
      ["keyQualifierSource", "Key Qualifier (Field)"],
      ["cardinality",        "Cardinality"],
      ["targetEntityLabel",  "Related Object"],
      ["targetEntity",       "Related Object API Name"],
      ["targetFieldLabel",   "Related Field"],
      ["targetField",        "Related Field API Name"],
      ["keyQualifierTarget", "Key Qualifier (Related Field)"],
    ];

    const csvEsc = (s) => { const t = String(s == null ? "" : s); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const tsvEsc = (s) => String(s == null ? "" : s).replace(/\t/g, " ");
    const metaLines = (sep) => {
      const e = sep === "," ? csvEsc : tsvEsc;
      const dsList  = meta.dataStreams.map(d => d.label || d.name).join("; ");
      const dloList = meta.dataLakeObjects.map(d => d.label || d.name).join("; ");
      return [
        [e("DMO Label"),        e(meta.label)],
        [e("DMO API Name"),     e(meta.name)],
        [e("Category"),         e(meta.category)],
        [e("Mapped Data Streams"), e(dsList)],
        [e("Mapped DLOs"),      e(dloList)],
        ["",""],
      ].map(r => r.join(sep)).join("\n");
    };
    const toText = (rows, cols, sep) => {
      const e = sep === "," ? csvEsc : tsvEsc;
      // NOTE: metaLines() ends WITHOUT a trailing newline (its last entry is the blank
      // spacer row ["",""] → just a separator char). Concatenating the header directly
      // put a leading empty cell on the header row, shifting every header one column
      // right vs the data. Insert the newline so the header starts at column A.
      return metaLines(sep) + "\n" + cols.map(c => c[1]).join(sep) + "\n" +
             rows.map(r => cols.map(c => e(r[c[0]])).join(sep)).join("\n");
    };
    const download = (text, filename) => {
      try {
        const b = new Blob([text], { type: "text/csv" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
      } catch (e) {}
    };

    const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const safeFilename = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, "_");

    if (!detailExportEl) { detailExportEl = document.createElement("div"); document.body.appendChild(detailExportEl); }
    detailExportEl.id = "dc-detail-export";
    detailExportEl.style.cssText = "position:fixed;top:4vh;left:50%;transform:translateX(-50%);z-index:2147483647;width:min(1100px,96vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;color:#16325c;border:1px solid #c9cede;border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.5);font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;overflow:hidden";

    // Build field rows HTML
    const fieldTrs = fields.map(r =>
      "<tr>" +
      "<td>" + esc(r.label) + "</td>" +
      "<td class='api'>" + esc(r.name) + "</td>" +
      "<td>" + esc(r.type) + "</td>" +
      "<td class='bool'>" + esc(r.isMapped) + "</td>" +
      "<td class='bool'>" + esc(r.isDistinct) + "</td>" +
      "<td class='mono'>" + esc(r.keyQualifier) + "</td>" +
      "<td>" + esc(r.assignedTags) + "</td>" +
      "<td>" + esc(r.assignedClassifications) + "</td>" +
      "</tr>"
    ).join("") || "<tr><td colspan='8' class='empty'>No fields found — make sure the Fields tab was opened at least once.</td></tr>";

    // Build relationship rows HTML
    const relTrs = rels.map(r =>
      "<tr>" +
      "<td>" + esc(r.sourceEntityLabel) + "<div class='sub'>" + esc(r.sourceEntity) + "</div></td>" +
      "<td>" + esc(r.sourceFieldLabel)  + "<div class='sub'>" + esc(r.sourceField)  + "</div></td>" +
      "<td class='mono'>" + esc(r.keyQualifierSource) + "</td>" +
      "<td><span class='card'>" + esc(r.cardinalityLabel || r.cardinality) + "</span> " + esc(r.cardinality) + "</td>" +
      "<td>" + esc(r.targetEntityLabel) + "<div class='sub'>" + esc(r.targetEntity) + "</div></td>" +
      "<td>" + esc(r.targetFieldLabel)  + "<div class='sub'>" + esc(r.targetField)  + "</div></td>" +
      "<td class='mono'>" + esc(r.keyQualifierTarget) + "</td>" +
      "</tr>"
    ).join("") || "<tr><td colspan='7' class='empty'>No active relationships found — switch to Relationships tab first if this is empty.</td></tr>";

    // Metadata chips
    const dsList  = meta.dataStreams.map(d   => "<span class='chip'>" + esc(d.label || d.name) + "</span>").join("") || "<span class='muted'>—</span>";
    const dloList = meta.dataLakeObjects.map(d => "<span class='chip'>" + esc(d.label || d.name) + "</span>").join("") || "<span class='muted'>—</span>";

    detailExportEl.innerHTML =
      "<style>" +
      "#dc-detail-export .hd{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#f3f6fb;border-bottom:1px solid #e0e5ee;flex-shrink:0;flex-wrap:wrap}" +
      "#dc-detail-export .hd strong{font-size:15px;flex-shrink:0}" +
      "#dc-detail-export .meta-bar{display:flex;flex-wrap:wrap;gap:6px 20px;padding:8px 16px;background:#f9fafc;border-bottom:1px solid #e0e5ee;font-size:11px;color:#5c6b8a;flex-shrink:0}" +
      "#dc-detail-export .meta-bar b{color:#16325c}" +
      "#dc-detail-export .chip{display:inline-block;padding:1px 7px;border-radius:10px;background:#e8edf6;color:#16325c;margin:1px 2px;font-size:11px}" +
      "#dc-detail-export .muted{color:#b0b7c6;font-style:italic}" +
      "#dc-detail-export .tabs{display:flex;gap:0;padding:0 16px;border-bottom:1px solid #e0e5ee;background:#fff;flex-shrink:0;flex-wrap:wrap;align-items:flex-end}" +
      "#dc-detail-export .tab{padding:9px 18px;cursor:pointer;font:600 12px -apple-system,sans-serif;color:#5c6b8a;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}" +
      "#dc-detail-export .tab.active{color:#0b5cab;border-bottom-color:#0b5cab}" +
      "#dc-detail-export .tab-actions{display:none}" +
      "#dc-detail-export .toolbar{display:flex;flex-wrap:wrap;gap:8px;padding:8px 12px;border-bottom:1px solid #e0e5ee;background:#fff;flex-shrink:0}" +
      "#dc-detail-export button{flex:1 1 120px;min-width:110px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid #0b5cab;background:#0b5cab;color:#fff;border-radius:6px;padding:7px 8px;font-weight:600;cursor:pointer;font-size:12px;text-align:center}" +
      "#dc-detail-export button.sec{background:#fff;color:#0b5cab}" +
      "#dc-detail-export button svg{flex-shrink:0}" +
      "#dc-detail-export .x{flex:0 0 auto;min-width:auto;border:none;background:transparent;color:#5c6b8a;font-size:20px;padding:0 4px;cursor:pointer;line-height:1;margin-left:4px}" +
      "#dc-detail-export .bd{overflow:auto;flex:1;min-height:0}" +
      "#dc-detail-export table{border-collapse:collapse;width:100%;font-size:12px}" +
      "#dc-detail-export th{position:sticky;top:0;background:#fff;text-align:left;padding:8px 12px;border-bottom:2px solid #e0e5ee;color:#5c6b8a;font-size:11px;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}" +
      "#dc-detail-export td{padding:6px 12px;border-bottom:1px solid #eef1f6;vertical-align:top}" +
      "#dc-detail-export td.api{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#0b5cab}" +
      "#dc-detail-export td.mono{font-family:'SF Mono',Menlo,monospace;font-size:11px;color:#6b1f9a}" +
      "#dc-detail-export td.bool{text-align:center;color:#5c6b8a}" +
      "#dc-detail-export .sub{font-family:'SF Mono',Menlo,monospace;font-size:10px;color:#8a94ab;margin-top:1px}" +
      "#dc-detail-export .card{display:inline-block;padding:1px 6px;border-radius:8px;background:#eef1f6;color:#5c6b8a;font-size:10px;margin-right:4px}" +
      "#dc-detail-export .empty{padding:24px;text-align:center;color:#8a94ab}" +
      "#dc-detail-export .sp{flex:1}" +
      "#dc-detail-export .ft{padding:6px 16px;border-top:1px solid #e0e5ee;color:#8a94ab;font-size:11px;background:#f9fafc;flex-shrink:0}" +
      "#dc-detail-export .pane{display:none}#dc-detail-export .pane.active{display:block}" +
      "</style>" +
      "<div class='hd'>" +
        "<strong>" + esc(meta.label || meta.name) + "</strong>" +
        "<span class='muted' style='font-size:11px;font-family:SF Mono,Menlo,monospace'>" + esc(meta.name) + "</span>" +
        "<span class='chip'>" + esc(meta.category || "—") + "</span>" +
        "<span class='sp'></span>" +
        "<button class='x' id='dc-d-close'>&times;</button>" +
      "</div>" +
      "<div class='meta-bar'>" +
        "<span><b>Data Stream:</b> " + dsList  + "</span>" +
        "<span><b>Data Lake Object:</b> " + dloList + "</span>" +
        (meta.description ? "<span><b>Description:</b> " + esc(meta.description) + "</span>" : "") +
      "</div>" +
      "<div class='tabs'>" +
        "<div class='tab active' id='dc-tab-fields'>Fields (" + fields.length + ")</div>" +
        "<div class='tab' id='dc-tab-rels'>Relationships (" + rels.length + ")</div>" +
      "</div>" +
      "<div class='toolbar'>" +
        "<button id='dc-d-copy'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets</button>" +
        "<button class='sec' id='dc-d-csv'><svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><path d='M3 2h7l3 3v9H3z' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M10 2v3h3'/><path d='M6 9l2 2 2-2M8 7v4'/></svg>Download XLS</button>" +
      "</div>" +
      "<div class='bd'>" +
        "<div class='pane active' id='dc-pane-fields'><table><thead><tr>" +
          "<th>Field Label</th><th>Field API Name</th><th>Data Type</th><th>Is Mapped</th><th>Value Suggestion</th><th>Key Qualifier</th><th>Tags</th><th>Classifications</th>" +
        "</tr></thead><tbody>" + fieldTrs + "</tbody></table></div>" +
        "<div class='pane' id='dc-pane-rels'><table><thead><tr>" +
          "<th>Object</th><th>Field</th><th>Key Qualifier (Field)</th><th>Cardinality</th><th>Related Object</th><th>Related Field</th><th>Key Qualifier (Related)</th>" +
        "</tr></thead><tbody>" + relTrs + "</tbody></table></div>" +
      "</div>" +
      "<div class='ft' id='dc-d-ft'>" + fields.length + " field(s)</div>";

    const closeDetail = () => { if (detailExportEl) { detailExportEl.remove(); detailExportEl = null; } hideBackdrop(); };
    detailExportEl.querySelector("#dc-d-close").onclick = closeDetail;

    // Tab switching
    let activeTab = "fields";
    const tabFields = detailExportEl.querySelector("#dc-tab-fields");
    const tabRels   = detailExportEl.querySelector("#dc-tab-rels");
    const paneFields = detailExportEl.querySelector("#dc-pane-fields");
    const paneRels   = detailExportEl.querySelector("#dc-pane-rels");
    const ftEl       = detailExportEl.querySelector("#dc-d-ft");
    tabFields.onclick = () => {
      activeTab = "fields";
      tabFields.classList.add("active"); tabRels.classList.remove("active");
      paneFields.classList.add("active"); paneRels.classList.remove("active");
      ftEl.textContent = fields.length + " field(s)";
    };
    function renderRels() {
      const tbody = paneRels.querySelector("tbody");
      if (tbody) tbody.innerHTML = rels.map(r =>
        "<tr>" +
        "<td>" + esc(r.sourceEntityLabel) + "<div class='sub'>" + esc(r.sourceEntity) + "</div></td>" +
        "<td>" + esc(r.sourceFieldLabel)  + "<div class='sub'>" + esc(r.sourceField)  + "</div></td>" +
        "<td class='mono'>" + esc(r.keyQualifierSource) + "</td>" +
        "<td><span class='card'>" + esc(r.cardinalityLabel || r.cardinality) + "</span> " + esc(r.cardinality) + "</td>" +
        "<td>" + esc(r.targetEntityLabel) + "<div class='sub'>" + esc(r.targetEntity) + "</div></td>" +
        "<td>" + esc(r.targetFieldLabel)  + "<div class='sub'>" + esc(r.targetField)  + "</div></td>" +
        "<td class='mono'>" + esc(r.keyQualifierTarget) + "</td>" +
        "</tr>"
      ).join("") || "<tr><td colspan='7' class='empty'>No relationships found.</td></tr>";
    }

    // Pre-load relationships in background so the tab is ready when clicked
    let relsLoaded = false;
    setTimeout(() => {
      if (!detailExportEl) return;
      const freshRels = readDmoRelationships();
      if (freshRels.length) {
        rels.length = 0; freshRels.forEach(r => rels.push(r));
        tabRels.textContent = "Relationships (" + rels.length + ")";
        renderRels();
        relsLoaded = true;
      }
    }, 300);

    tabRels.onclick = () => {
      activeTab = "rels";
      tabRels.classList.add("active"); tabFields.classList.remove("active");
      paneRels.classList.add("active"); paneFields.classList.remove("active");
      if (!relsLoaded) {
        // Fallback: try reading again if background load got nothing
        const freshRels = readDmoRelationships();
        rels.length = 0; freshRels.forEach(r => rels.push(r));
        tabRels.textContent = "Relationships (" + rels.length + ")";
        renderRels();
        relsLoaded = true;
      }
      ftEl.textContent = rels.length + " relationship(s)";
    };

    detailExportEl.querySelector("#dc-d-copy").onclick = (e) => {
      const text = activeTab === "fields" ? toText(fields, FIELD_COLS, "\t") : toText(rels, REL_COLS, "\t");
      navigator.clipboard.writeText(text).then(() => {
        e.target.textContent = "✓ Copied!"; setTimeout(() => (e.target.innerHTML = "<svg width='13' height='13' viewBox='0 0 16 16' fill='currentColor' style='vertical-align:middle;margin-right:4px'><rect x='5' y='4' width='8' height='10' rx='1.5' fill='none' stroke='currentColor' stroke-width='1.5'/><path d='M3 2h7v2H5v8H3z' fill='currentColor'/></svg>Copy for Sheets"), 1200);
      }).catch(() => {});
    };
    detailExportEl.querySelector("#dc-d-csv").onclick = () => {
      const fn = safeFilename(meta.name || meta.label || "dmo");
      const dsList  = meta.dataStreams.map(d => d.label || d.name).join("; ");
      const dloList = meta.dataLakeObjects.map(d => d.label || d.name).join("; ");
      const fieldHeader = FIELD_COLS.map(c => c[1]);
      const fieldRows   = fields.map(r => FIELD_COLS.map(c => r[c[0]] || ""));
      const relHeader = REL_COLS.map(c => c[1]);
      const relRows   = rels.map(r => REL_COLS.map(c => r[c[0]] || ""));
      // Meta as paragraph (\n) in last row A, headers bold in row 1
      const fMetaParts = [];
      if (meta.label || meta.name) fMetaParts.push("DMO: " + (meta.label || meta.name));
      if (meta.name)    fMetaParts.push("API Name: " + meta.name);
      if (meta.category) fMetaParts.push("Category: " + meta.category);
      if (dsList)       fMetaParts.push("Data Streams: " + dsList);
      if (dloList)      fMetaParts.push("DLOs: " + dloList);
      const fieldMetaRow = [fMetaParts.join("\n")];
      const relMetaRow   = [["DMO: "+(meta.label||meta.name), "API Name: "+meta.name].filter(Boolean).join("\n")];
      try {
        const xlsx = buildXlsx([
          { name: "Fields",        rows: [fieldHeader, ...fieldRows, [], fieldMetaRow], headerRow: 1 },
          { name: "Relationships", rows: [relHeader,   ...relRows,   [], relMetaRow],   headerRow: 1 },
        ], { wrapLastRow: true });
        const blob = new Blob([xlsx], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fn + "-export.xlsx";
        document.body.appendChild(a); a.click(); a.remove();
      } catch(e) {
        // Fallback to CSV if XLSX builder fails
        download(toText(fields, FIELD_COLS, ","), fn + "-fields.csv");
      }
    };

    const hd = detailExportEl.querySelector(".hd"); if (hd) makeDraggable(detailExportEl, hd);
    addResizeHandle(detailExportEl, 480, 300);
    try { installDetailExportTooltips(detailExportEl); } catch (e) {}
    const onEsc = (e) => { if (e.key === "Escape") { closeDetail(); document.removeEventListener("keydown", onEsc, true); } };
    document.addEventListener("keydown", onEsc, true);
    const onOut = (e) => { if (detailExportEl && !detailExportEl.contains(e.target)) { closeDetail(); document.removeEventListener("pointerdown", onOut, true); } };
    setTimeout(() => document.addEventListener("pointerdown", onOut, true), 100);
  }

  // Inline names start OFF — show the control bar and wait for the user to
  // click "Show API names". Export works independently, on demand.
  // On detail pages, show a single "Download fields CSV" button instead.
  // ── Segment rules readers ─────────────────────────────────────────────────

  /* [in-development features removed from public build] */

  // ═══════════════════════════════════════════════════════════════════════════════
  // Activation Export feature (extension-only)
  // ═══════════════════════════════════════════════════════════════════════════════

  // Detect if we're on an Activation page
  function isActivationPage() {
    return /marketSegmentActivation/i.test(window.location.href) || /\/r\/MarketSegmentActivation\//i.test(window.location.href);
  }

  // Get the activation ID from URL (supports both wizard and record view)
  function getActivationIdFromUrl() {
    // Wizard: ?runtime_cdp__recordId=85RKh000000oLlmMAE
    var params = new URLSearchParams(window.location.search);
    var fromParam = params.get("runtime_cdp__recordId");
    if (fromParam) return fromParam;
    // Record view: /r/MarketSegmentActivation/85RKh000000oLlwMAE/view
    var pathMatch = window.location.pathname.match(/\/r\/MarketSegmentActivation\/([a-zA-Z0-9]{15,18})/i);
    if (pathMatch) return pathMatch[1];
    return "";
  }

  // Fetch activation data — extension-only (reliable Connect API)
  function fetchActivationViaBridge(activationId) {
    return fetchActivationViaExtension(activationId);
  }

  var _activationAuraToken = "";
  var _activationAuraContext = "";

  function scrapeActivationDOM() {
    var result = { attributes: [], contactPoints: [], segmentOn: "", publishSchedule: "", platform: "", businessUnit: "", attrCount: 0 };
    var foundAttrList = false;
    function walkShadow(root, depth) {
      if (depth > 10) return;
      root.querySelectorAll("*").forEach(function(el) {
        // PRECISE: Find "Attributes Included" heading → get sibling <ul> → <li> items
        if (!foundAttrList && el.tagName === "H4" && /Attributes Included/i.test(el.textContent.trim())) {
          var m = el.textContent.trim().match(/\((\d+)\)/);
          if (m) result.attrCount = parseInt(m[1], 10);
          // Find the <ul> list — check siblings and parent's children
          var parent = el.parentElement;
          if (parent) {
            var lists = parent.querySelectorAll("ul, ol");
            for (var li = 0; li < lists.length; li++) {
              var items = lists[li].querySelectorAll("li");
              if (items.length >= 3) {
                Array.from(items).forEach(function(item) {
                  var txt = item.textContent.trim();
                  if (txt.length > 0 && txt.length < 80) result.attributes.push(txt);
                });
                foundAttrList = true;
                break;
              }
            }
          }
        }
        // Contact points — find by section heading "Select contact points" area
        if (el.tagName === "H2" || el.tagName === "H3" || el.tagName === "DIV") {
          var elTxt = el.textContent.trim();
          if (/^Email$/i.test(elTxt) && el.nextElementSibling && /Selected/i.test(el.nextElementSibling.textContent || "")) {
            if (result.contactPoints.indexOf("EMAIL") < 0) result.contactPoints.push({ type: "EMAIL", desc: "Email (Selected)" });
          }
        }
        // Sidebar specific fields (target elements with lwc-20hmoda60ll attribute for precision)
        if (el.textContent && el.children && el.children.length < 5) {
          var txt2 = el.textContent.trim();
          if (/^Segment On:/.test(txt2) && txt2.length < 60 && !result.segmentOn) {
            result.segmentOn = txt2.replace(/^Segment On:\s*/i, "").replace(/Publish Schedule.*/, "").trim();
          }
          if (/^Publish Schedule:/.test(txt2) && txt2.length < 40 && !result.publishSchedule) {
            result.publishSchedule = txt2.replace(/^Publish Schedule:\s*/i, "").trim();
          }
          if (/^Platform:/.test(txt2) && txt2.length < 60 && !/Business/.test(txt2) && !result.platform) {
            result.platform = txt2.replace(/^Platform:\s*/i, "").trim();
          }
          if (/^Business Units:/.test(txt2) && txt2.length < 60 && !result.businessUnit) {
            result.businessUnit = txt2.replace(/^Business Units:\s*/i, "").trim();
          }
        }
        if (el.shadowRoot) walkShadow(el.shadowRoot, depth + 1);
      });
    }
    walkShadow(document, 0);
    // If sidebar only gave ~10, also try scraping from wizard main area (full attribute list)
    if (!foundAttrList || result.attributes.length < 5) {
      // Fallback: look for li items in the Activation Summary section
      walkShadow(document, 0);
    }
    // Dedupe + filter empty
    result.attributes = result.attributes.filter(function(v, i, a) { return v && v.length > 0 && a.indexOf(v) === i; });
    return result;
  }

  function fetchActivationViaAura(activationId) {
    return new Promise(function(resolve, reject) {
      // Capture Aura token by intercepting XHR (same approach as our successful probes)
      if (!_activationAuraToken) {
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function(body) {
          if (body && /aura\.token/.test(String(body))) {
            var tm = String(body).match(/aura\.token=([^&]+)/);
            var cm = String(body).match(/aura\.context=([^&]+)/);
            if (tm) _activationAuraToken = decodeURIComponent(tm[1]);
            if (cm) _activationAuraContext = decodeURIComponent(cm[1]);
            XMLHttpRequest.prototype.send = origSend; // restore after capture
          }
          return origSend.apply(this, arguments);
        };
      }
      // Also try from _auraSniff
      if (!_activationAuraToken && _auraSniff && _auraSniff.token) {
        _activationAuraToken = _auraSniff.token;
        _activationAuraContext = _auraSniff.context;
      }

      function tryWithToken() {
        var token = _activationAuraToken;
        var context = _activationAuraContext;
        if (!token || !context) {
          // No Aura token — try DOM-only scrape
          var domOnly = scrapeActivationDOM();
          if (domOnly.attributes.length > 0) {
            var merged = { _source: "bookmarklet (DOM scrape only)", name: "", status: "Unknown" };
            merged.attributesConfig = { attributes: domOnly.attributes.map(function(label) { return { label: label, name: "", source: "DOM", dataSourceType: "" }; }) };
            if (domOnly.contactPoints.length > 0) merged.contactPointsConfig = { contactPoints: domOnly.contactPoints.map(function(cp) { return { type: cp.type, contactPointEntityName: cp.desc }; }) };
            if (domOnly.segmentOn) merged.activationTargetSubjectConfig = { masterLabel: domOnly.segmentOn };
            if (domOnly.publishSchedule) merged.publishSchedule = domOnly.publishSchedule;
            if (domOnly.platform) merged.activationTarget = { name: "", platformName: domOnly.platform, status: "" };
            if (domOnly.businessUnit) merged.businessUnit = domOnly.businessUnit;
            resolve(merged);
            return;
          }
          reject(new Error("No session captured and no data visible in DOM. Navigate to the activation wizard (step 2) then try again."));
          return;
        }
        // Call getActivationStatusProperties + getRecord in parallel
        var results = {};
        var pending = 2;
        function checkDone() {
          pending--;
          if (pending <= 0) {
            // Merge results into a combined object
            var merged = {};
            if (results.status) {
              var rv = results.status;
              merged.name = rv.Name; merged.status = rv.ActivationStatus;
              merged.activationType = rv.ActivationFlowType;
              merged.refreshType = rv.ActivationRefreshType;
              merged.dataSpaceName = rv.DataSpace && rv.DataSpace.Name;
              merged.activationTargetName = rv.ActivationTarget && rv.ActivationTarget.MasterLabel;
              merged.activationTarget = { name: rv.ActivationTarget && rv.ActivationTarget.MasterLabel, platformName: rv.PlatformName || "", status: rv.ActivationStatus };
              merged.marketSegmentId = rv.MarketSegmentId;
              merged.activationTargetSubjectConfig = { masterLabel: rv.ActivationObjectName };
              merged.createdDate = rv.CreatedDate;
              merged.lastModifiedDate = rv.LastModifiedDate;
              merged.id = rv.Id;
              merged.membershipName = rv.ActivationObjectName;
              merged._source = "bookmarklet-aura (basic view)";
            }
            if (results.record) {
              var rec = results.record;
              if (!merged.name && rec.Name) merged.name = rec.Name;
              merged.processingType = rec.ActivationProcessingType;
              merged.lastPublishStatus = rec.LastPublishStatus;
              merged.developerName = rec.DeveloperName;
            }
            // Enrich with DOM scraping (attributes, contact points, sidebar)
            var domData = scrapeActivationDOM();
            if (domData.attributes.length > 0) {
              merged.attributesConfig = { attributes: domData.attributes.map(function(label) { return { label: label, name: "", source: "DOM", dataSourceType: "" }; }) };
            }
            if (domData.contactPoints.length > 0) {
              merged.contactPointsConfig = { contactPoints: domData.contactPoints.map(function(cp) { return { type: cp.type, contactPointEntityName: cp.desc }; }) };
            }
            if (domData.segmentOn) merged.activationTargetSubjectConfig = { masterLabel: domData.segmentOn };
            if (domData.publishSchedule) merged.publishSchedule = domData.publishSchedule;
            if (domData.platform) merged.activationTarget = Object.assign(merged.activationTarget || {}, { platformName: domData.platform });
            if (domData.businessUnit) merged.businessUnit = domData.businessUnit;
            if (domData.attrCount) merged._attrCount = domData.attrCount;
            merged._source = "bookmarklet (Aura + DOM scrape)";

            if (Object.keys(merged).length === 0) {
              reject(new Error("Could not read activation data."));
              return;
            }
            resolve(merged);
          }
        }

        // Action 1: getActivationStatusProperties
        var act1 = { id: "dca-1;a", descriptor: "serviceComponent://ui.cdp.components.controllers.MarketSegmentActivationController/ACTION$getActivationStatusProperties", callingDescriptor: "UNKNOWN", params: { recordId: activationId } };
        var form1 = "message=" + encodeURIComponent(JSON.stringify({ actions: [act1] })) + "&aura.context=" + encodeURIComponent(context) + "&aura.token=" + encodeURIComponent(token);
        fetch("/aura?r=881&getActivationStatusProperties=1", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: form1, credentials: "include" })
          .then(function(r) { return r.json(); }).then(function(j) {
            if (j.actions && j.actions[0] && j.actions[0].state === "SUCCESS") results.status = j.actions[0].returnValue;
            checkDone();
          }).catch(function() { checkDone(); });

        // Action 2: getRecord (DetailController)
        var act2 = { id: "dca-2;a", descriptor: "serviceComponent://ui.force.components.controllers.detail.DetailController/ACTION$getRecord", callingDescriptor: "UNKNOWN", params: { recordId: activationId } };
        var form2 = "message=" + encodeURIComponent(JSON.stringify({ actions: [act2] })) + "&aura.context=" + encodeURIComponent(context) + "&aura.token=" + encodeURIComponent(token);
        fetch("/aura?r=882&getRecord=1", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: form2, credentials: "include" })
          .then(function(r) { return r.json(); }).then(function(j) {
            if (j.actions && j.actions[0] && j.actions[0].state === "SUCCESS") results.record = j.actions[0].returnValue && j.actions[0].returnValue.record || j.actions[0].returnValue;
            checkDone();
          }).catch(function() { checkDone(); });
      }

      // If token already captured, try immediately; otherwise wait for next XHR
      if (_activationAuraToken) {
        tryWithToken();
      } else {
        // Wait for user interaction to trigger an Aura XHR
        setTimeout(function() {
          // Check again after a brief delay
          if (_activationAuraToken) { tryWithToken(); return; }
          // Still no token — tell user to interact
          reject(new Error("No session captured yet. Click Edit on the activation (or navigate to another tab and back) to trigger a request, then click Export Activation again."));
        }, 2000);
      }
    });
  }

  function fetchActivationViaExtension(activationId) {
    return new Promise(function (resolve, reject) {
      var id = "dca-" + (_dcBridgeSeq = (_dcBridgeSeq || 0) + 1);
      var done = false;
      function onMsg(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.__dcRes !== "dc-activation" || d.id !== id) return;
        window.removeEventListener("message", onMsg, false);
        if (done) return;
        done = true;
        if (d.ok && d.resp) resolve(d.resp);
        else reject(new Error(d.error || (d.resp && d.resp.error) || "activation read failed"));
      }
      window.addEventListener("message", onMsg, false);
      window.postMessage({ __dcReq: "dc-activation", id: id, activationId: activationId }, "*");
      setTimeout(function () {
        if (!done) {
          done = true;
          window.removeEventListener("message", onMsg, false);
          reject(new Error("bridge timeout"));
        }
      }, 20000);
    });
  }

  // Show activation data in a modal
  function renderActivationValue(val, depth) {
    depth = depth || 0;
    var esc = function(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); };
    if (val === null || val === undefined) return "<span style='color:#94a3b8;'>—</span>";
    if (typeof val === "boolean") return "<span style='color:" + (val ? "#059669" : "#dc2626") + ";font-weight:600;'>" + val + "</span>";
    if (typeof val === "number") return "<span style='color:#2563eb;'>" + val + "</span>";
    if (typeof val === "string") {
      if (val.length === 0) return "<span style='color:#94a3b8;'>—</span>";
      return "<span style='color:#1f2937;'>" + esc(val) + "</span>";
    }
    if (Array.isArray(val)) {
      if (val.length === 0) return "<span style='color:#94a3b8;'>Empty list</span>";
      if (typeof val[0] === "object") {
        var cols = [];
        val.forEach(function(item) { if (item) Object.keys(item).forEach(function(k) { if (cols.indexOf(k) < 0) cols.push(k); }); });
        var html = "<table style='width:100%;border-collapse:collapse;font-size:11px;margin:4px 0;'>";
        html += "<thead><tr style='background:#f1f5f9;'>" + cols.map(function(c) { return "<th style='padding:5px 8px;border:1px solid #e2e8f0;font:600 10px system-ui;color:#475569;text-align:left;'>" + esc(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
        val.forEach(function(item) {
          html += "<tr>" + cols.map(function(c) {
            var v = item ? item[c] : null;
            if (v && typeof v === "object") return "<td style='padding:5px 8px;border:1px solid #e2e8f0;font-size:10px;color:#6b7280;'>" + esc(JSON.stringify(v)) + "</td>";
            return "<td style='padding:5px 8px;border:1px solid #e2e8f0;'>" + renderActivationValue(v) + "</td>";
          }).join("") + "</tr>";
        });
        html += "</tbody></table>";
        return html;
      }
      return val.map(function(v) { return renderActivationValue(v, depth); }).join(", ");
    }
    if (typeof val === "object") {
      var keys = Object.keys(val);
      if (keys.length === 0) return "<span style='color:#94a3b8;'>Empty</span>";
      var html2 = "<table style='width:100%;border-collapse:collapse;font-size:12px;margin:4px 0;" + (depth > 0 ? "background:#f9fafb;" : "") + "'>";
      keys.forEach(function(k) {
        html2 += "<tr><td style='padding:5px 10px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#374151;width:180px;vertical-align:top;font-size:11px;'>" + esc(k) + "</td><td style='padding:5px 10px;border-bottom:1px solid #f1f5f9;'>" + renderActivationValue(val[k], depth + 1) + "</td></tr>";
      });
      html2 += "</table>";
      return html2;
    }
    return esc(String(val));
  }

  function generateRichDashboardHTML(data, targetName) {
    var esc = function(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); };
    var jsonStr = JSON.stringify(JSON.stringify(data));

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Activation Studio Inspector - ${esc(targetName)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
.container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); overflow: hidden; }
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
.header h1 { font-size: 32px; margin-bottom: 8px; font-weight: 700; }
.header p { font-size: 14px; opacity: 0.9; }
.tabs { display: flex; border-bottom: 2px solid #e5e7eb; background: #f9fafb; overflow-x: auto; }
.tab { padding: 16px 24px; cursor: pointer; font-weight: 600; color: #6b7280; border-bottom: 3px solid transparent; transition: all 0.2s; white-space: nowrap; }
.tab:hover { background: #f3f4f6; color: #374151; }
.tab.active { color: #667eea; border-bottom-color: #667eea; background: white; }
.tab-content { display: none; padding: 30px; max-height: calc(100vh - 300px); overflow-y: auto; }
.tab-content.active { display: block; }
.section { margin-bottom: 30px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
.section-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 20px; font-weight: 700; font-size: 16px; }
.section-body { padding: 20px; background: white; }
.kv-grid { display: grid; grid-template-columns: 200px 1fr; gap: 12px 20px; }
.kv-label { font-weight: 600; color: #374151; font-size: 13px; }
.kv-value { color: #1f2937; font-size: 13px; word-break: break-word; }
.pill-path { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.pill { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.arrow { color: #9ca3af; font-size: 18px; font-weight: bold; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
th { padding: 12px; text-align: left; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
tbody tr:hover { background: #f9fafb; }
.entity-group { margin-bottom: 24px; }
.entity-header { background: #f3f4f6; padding: 10px 16px; font-weight: 700; color: #1f2937; border-left: 4px solid #667eea; margin-bottom: 8px; border-radius: 4px; }
.badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.badge-active { background: #d1fae5; color: #065f46; }
.badge-inactive { background: #fee2e2; color: #991b1b; }
.filter-box { background: #fef3c7; border: 1px solid #fcd34d; padding: 14px; border-radius: 6px; margin-bottom: 12px; }
.filter-box strong { color: #92400e; }
.contact-point-card { background: #dbeafe; border: 1px solid #93c5fd; padding: 16px; border-radius: 8px; margin-bottom: 14px; }
.contact-point-card h4 { color: #1e40af; margin-bottom: 10px; font-size: 14px; }
pre { background: #1e293b; color: #e2e8f0; padding: 16px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.6; }
.empty-state { text-align: center; color: #9ca3af; padding: 40px; font-style: italic; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🎯 Activation Studio Inspector</h1>
    <p>Deep-dive analysis of your Data Cloud activation configuration</p>
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="studio">📊 Studio UI View</div>
    <div class="tab" data-tab="filters">🎯 Audience Filters & Rules</div>
    <div class="tab" data-tab="schema">🔗 Target Schema & Multi-Hop Joins</div>
    <div class="tab" data-tab="audit">📋 Audit Logs & Metadata</div>
  </div>

  <div id="studio" class="tab-content active"></div>
  <div id="filters" class="tab-content"></div>
  <div id="schema" class="tab-content"></div>
  <div id="audit" class="tab-content"></div>
</div>

<script>
const embeddedData = JSON.parse(${jsonStr});

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}

function processJSON() {
  const data = embeddedData;
  if (!data) return;

  const targetName = (data.activationTarget && (data.activationTarget.name || data.activationTargetName)) || data.name || 'Unknown';

  // === TAB 1: Studio UI View ===
  let studioHTML = '';

  // Overview Section
  studioHTML += '<div class="section"><div class="section-header">📋 Activation Overview</div><div class="section-body"><div class="kv-grid">';
  studioHTML += kvRow('Name', data.name || data.activationTargetName);
  studioHTML += kvRow('Status', data.status ? \`<span class="badge badge-\${data.status === 'ACTIVE' ? 'active' : 'inactive'}">\${data.status}</span>\` : '');
  studioHTML += kvRow('Type', data.activationType);
  studioHTML += kvRow('Platform', data.activationTarget && data.activationTarget.platformName);
  studioHTML += kvRow('Target', data.activationTargetName);
  studioHTML += kvRow('Data Space', data.dataSpaceName);
  studioHTML += kvRow('Segment', data.segmentApiName);
  studioHTML += kvRow('Refresh Type', data.refreshType);
  studioHTML += kvRow('Processing Type', data.processingType);
  studioHTML += kvRow('Enabled', data.isEnabled || data.enabled);
  studioHTML += kvRow('Last Publish Date', data.lastPublishDate);
  studioHTML += kvRow('Last Publish Status', data.lastPublishStatus);
  studioHTML += kvRow('Created', data.createdDate);
  studioHTML += kvRow('Last Modified', data.lastModifiedDate);
  studioHTML += kvRow('Developer Name', data.developerName);
  studioHTML += '</div></div></div>';

  // Membership Section
  studioHTML += '<div class="section"><div class="section-header">👥 Activation Membership</div><div class="section-body">';
  if (data.activationTargetSubjectConfig) {
    const sub = data.activationTargetSubjectConfig;
    studioHTML += '<div class="kv-grid">';
    studioHTML += kvRow('Subject Entity', sub.masterLabel || sub.developerName);
    studioHTML += kvRow('Developer Name', sub.developerName);
    studioHTML += kvRow('Membership Name', data.membershipName);
    studioHTML += '</div>';
  } else {
    studioHTML += '<div class="empty-state">No membership configured</div>';
  }
  studioHTML += '</div></div>';

  // Contact Points Section
  studioHTML += '<div class="section"><div class="section-header">📧 Contact Points</div><div class="section-body">';
  if (data.contactPointsConfig && data.contactPointsConfig.contactPoints && data.contactPointsConfig.contactPoints.length > 0) {
    data.contactPointsConfig.contactPoints.forEach(cp => {
      studioHTML += \`<div class="contact-point-card"><h4>📌 \${esc(cp.type || 'Unknown Type')}</h4>\`;
      studioHTML += \`<div class="kv-grid">\`;
      studioHTML += kvRow('Entity', cp.contactPointEntityName);
      if (cp.fieldConfig && cp.fieldConfig.contactPointFields) {
        const fields = cp.fieldConfig.contactPointFields.map(f => \`\${f.label} (\${f.name})\`).join(', ');
        studioHTML += kvRow('Fields', fields);
      }
      studioHTML += \`</div>\`;

      // Path visualization with pills
      if (cp.queryPathConfig && cp.queryPathConfig.configs && cp.queryPathConfig.configs.length > 0) {
        cp.queryPathConfig.configs.forEach((cfg, idx) => {
          if (cfg.queryPath && cfg.queryPath.length > 0) {
            studioHTML += \`<div style="margin-top:12px;"><strong>Path \${idx + 1}:</strong></div><div class="pill-path">\`;
            cfg.queryPath.forEach((step, stepIdx) => {
              const objLabel = step.objectLabel || (step.objectName || '').replace(/__dlm$|__cio$/g, '');
              const fieldLabel = step.fieldLabel || step.fieldName || '';
              if (stepIdx > 0) studioHTML += '<span class="arrow">→</span>';
              studioHTML += \`<span class="pill">\${esc(objLabel)}.\${esc(fieldLabel)}</span>\`;
            });
            studioHTML += '</div>';
          }
        });
      }

      if (cp.sourceConfig && cp.sourceConfig.contactPointSources) {
        studioHTML += '<div style="margin-top:12px;">';
        cp.sourceConfig.contactPointSources.forEach(src => {
          studioHTML += kvRow('Source', \`\${src.name} (Priority: \${src.dataSourcePriority})\`);
        });
        studioHTML += '</div>';
      }
      studioHTML += '</div>';
    });
  } else {
    studioHTML += '<div class="empty-state">No contact points configured</div>';
  }
  studioHTML += '</div></div>';

  // Attributes Section - Grouped by Entity
  studioHTML += '<div class="section"><div class="section-header">📊 Attributes Included</div><div class="section-body">';
  if (data.attributesConfig && data.attributesConfig.attributes && data.attributesConfig.attributes.length > 0) {
    const byEntity = {};
    data.attributesConfig.attributes.forEach(a => {
      const en = a.entityName || 'Unknown';
      if (!byEntity[en]) byEntity[en] = [];
      byEntity[en].push(a);
    });

    Object.keys(byEntity).sort().forEach(en => {
      const attrs = byEntity[en];
      studioHTML += \`<div class="entity-group"><div class="entity-header">\${esc(en.replace(/__dlm$|__cio$/g, ''))} (\${attrs.length} attributes)</div>\`;
      studioHTML += '<table><thead><tr><th>#</th><th>Label</th><th>Preferred Name</th><th>API Name</th><th>Type</th><th>Source</th></tr></thead><tbody>';
      attrs.forEach((a, i) => {
        studioHTML += \`<tr>
          <td>\${i+1}</td>
          <td>\${esc(a.label)}</td>
          <td style="color:#059669;font-style:italic;">\${esc(a.preferredName || '')}</td>
          <td style="font-family:monospace;color:#4a6fa5;">\${esc(a.name)}</td>
          <td>\${esc(a.dataSourceType)}</td>
          <td>\${esc(a.source)}</td>
        </tr>\`;
      });
      studioHTML += '</tbody></table></div>';
    });
  } else {
    studioHTML += '<div class="empty-state">No attributes configured</div>';
  }
  studioHTML += '</div></div>';

  // Campaign Data Section
  studioHTML += '<div class="section"><div class="section-header">🎯 Campaign Data</div><div class="section-body">';
  if (data.staticDataConfig && data.staticDataConfig.staticData && data.staticDataConfig.staticData.length > 0) {
    studioHTML += '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>';
    data.staticDataConfig.staticData.forEach(sd => {
      studioHTML += \`<tr><td style="font-weight:600;">\${esc(sd.name)}</td><td>\${esc(sd.value)}</td></tr>\`;
    });
    studioHTML += '</tbody></table>';
  } else {
    studioHTML += '<div class="empty-state">No campaign data</div>';
  }
  studioHTML += '</div></div>';

  document.getElementById('studio').innerHTML = studioHTML;

  // === TAB 2: Filters ===
  let filtersHTML = '<div class="section"><div class="section-header">🎯 Related DMO Filters</div><div class="section-body">';
  if (data.relatedDmoFiltersConfig && data.relatedDmoFiltersConfig.filters && data.relatedDmoFiltersConfig.filters.length > 0) {
    data.relatedDmoFiltersConfig.filters.forEach(f => {
      filtersHTML += '<div class="filter-box">';
      filtersHTML += \`<strong>Entity:</strong> \${esc(f.entityName || '')}<br>\`;
      if (f.entityFilter && f.entityFilter.condition) {
        const cond = f.entityFilter.condition;
        const field = (cond.subject && cond.subject.fieldName) || '';
        const op = cond.operator || '';
        const vals = cond.firstBoundValue != null ? \`\${cond.firstBoundValue} - \${cond.secondBoundValue}\` : (cond.values || []).join(', ');
        filtersHTML += \`<strong>Condition:</strong> \${esc(field)} \${esc(op)} \${esc(vals)}<br>\`;
      }
      if (f.filterLimit) {
        filtersHTML += \`<strong>Limit:</strong> Max \${f.filterLimit.maxNumberOfValues} values, order \${esc(f.filterLimit.order)}<br>\`;
      }
      filtersHTML += '</div>';
    });
  } else {
    filtersHTML += '<div class="empty-state">No related DMO filters configured</div>';
  }
  filtersHTML += '</div></div>';

  filtersHTML += '<div class="section"><div class="section-header">🎯 Direct DMO Filters</div><div class="section-body">';
  if (data.directDmoFiltersConfig && data.directDmoFiltersConfig.filters && data.directDmoFiltersConfig.filters.length > 0) {
    filtersHTML += \`<pre>\${esc(JSON.stringify(data.directDmoFiltersConfig.filters, null, 2))}</pre>\`;
  } else {
    filtersHTML += '<div class="empty-state">No direct DMO filters configured</div>';
  }
  filtersHTML += '</div></div>';

  document.getElementById('filters').innerHTML = filtersHTML;

  // === TAB 3: Schema ===
  let schemaHTML = '<div class="section"><div class="section-header">🔗 Activation Record Schema</div><div class="section-body">';
  if (data.activationRecordSchema) {
    try {
      const schema = typeof data.activationRecordSchema === 'string' ? JSON.parse(data.activationRecordSchema) : data.activationRecordSchema;
      if (schema.fields && Array.isArray(schema.fields)) {
        schemaHTML += '<table><thead><tr><th>#</th><th>Field Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>';
        schema.fields.forEach((field, i) => {
          schemaHTML += \`<tr>
            <td>\${i+1}</td>
            <td style="font-family:monospace;color:#4a6fa5;font-weight:600;">\${esc(field.name || field.fieldName)}</td>
            <td>\${esc(field.type || field.dataType)}</td>
            <td>\${field.required || field.isRequired ? '✓' : ''}</td>
            <td>\${esc(field.description || '')}</td>
          </tr>\`;
        });
        schemaHTML += '</tbody></table>';
      } else {
        schemaHTML += \`<pre>\${esc(JSON.stringify(schema, null, 2))}</pre>\`;
      }
    } catch (e) {
      schemaHTML += \`<pre>\${esc(data.activationRecordSchema)}</pre>\`;
    }
  } else {
    schemaHTML += '<div class="empty-state">No schema available</div>';
  }
  schemaHTML += '</div></div>';

  // Query Paths with visual representation
  schemaHTML += '<div class="section"><div class="section-header">🔗 Multi-Hop Join Paths</div><div class="section-body">';
  if (data.contactPointsConfig && data.contactPointsConfig.contactPoints && data.contactPointsConfig.contactPoints.length > 0) {
    data.contactPointsConfig.contactPoints.forEach((cp, cpIdx) => {
      if (cp.queryPathConfig && cp.queryPathConfig.configs && cp.queryPathConfig.configs.length > 0) {
        schemaHTML += \`<h4 style="margin-bottom:12px;">Contact Point: \${esc(cp.type || 'Unknown')}</h4>\`;
        cp.queryPathConfig.configs.forEach((cfg, idx) => {
          if (cfg.queryPath && cfg.queryPath.length > 0) {
            schemaHTML += \`<div style="margin-bottom:20px;"><strong>Path \${idx + 1}:</strong><div class="pill-path" style="margin-top:8px;">\`;
            cfg.queryPath.forEach((step, stepIdx) => {
              const objLabel = step.objectLabel || (step.objectName || '').replace(/__dlm$|__cio$/g, '');
              const fieldLabel = step.fieldLabel || step.fieldName || '';
              if (stepIdx > 0) schemaHTML += '<span class="arrow">→</span>';
              schemaHTML += \`<span class="pill">\${esc(objLabel)}.\${esc(fieldLabel)}</span>\`;
            });
            schemaHTML += '</div></div>';
          }
        });
      }
    });
  } else {
    schemaHTML += '<div class="empty-state">No query paths configured</div>';
  }
  schemaHTML += '</div></div>';

  document.getElementById('schema').innerHTML = schemaHTML;

  // === TAB 4: Audit ===
  let auditHTML = '<div class="section"><div class="section-header">📋 Audience DMO Information</div><div class="section-body"><div class="kv-grid">';
  auditHTML += kvRow('History Audience DMO', data.historyAudienceDmoLabel);
  auditHTML += kvRow('History Audience API', data.historyAudienceDmoApiName);
  auditHTML += kvRow('Latest Audience DMO', data.latestAudienceDmoLabel);
  auditHTML += kvRow('Latest Audience API', data.latestAudienceDmoApiName);
  auditHTML += kvRow('Last Run', data.latestAudienceDmoLastRunTimestamp);
  auditHTML += '</div></div></div>';

  auditHTML += '<div class="section"><div class="section-header">🔍 Raw JSON</div><div class="section-body">';
  auditHTML += \`<pre>\${esc(JSON.stringify(data, null, 2))}</pre>\`;
  auditHTML += '</div></div>';

  document.getElementById('audit').innerHTML = auditHTML;
}

function kvRow(label, value) {
  if (!value && value !== 0 && value !== false) return '';
  return \`<div class="kv-label">\${esc(label)}</div><div class="kv-value">\${value}</div>\`;
}

// Auto-process on load
document.addEventListener('DOMContentLoaded', processJSON);
processJSON();
</script>
</body>
</html>`;
  }

  function showActivationModal(data) {
    var existing = document.getElementById("dc-activation-modal");
    if (existing) existing.remove();
    var esc = function(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); };
    var targetName = (data.activationTarget && (data.activationTarget.name || data.activationTargetName)) || data.name || "Activation";
    var target = data.activationTarget || {};
    var sub = data.activationTargetSubjectConfig || {};
    var attrs = (data.attributesConfig && data.attributesConfig.attributes) || [];
    var cps = (data.contactPointsConfig && data.contactPointsConfig.contactPoints) || [];
    var staticData = (data.staticDataConfig && data.staticDataConfig.staticData) || [];
    var filters = (data.relatedDmoFiltersConfig && data.relatedDmoFiltersConfig.filters) || [];

    // Helper: render path pills
    function renderPath(configs) {
      if (!configs || !configs.length) return "";
      var ph = "<div style='margin:6px 0;'>";
      configs.forEach(function(cfg) {
        if (!cfg.queryPath) return;
        ph += "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:4px 0;'>";
        cfg.queryPath.forEach(function(step, si) {
          if (si > 0) ph += "<span style='color:#0284c7;font-weight:bold;'>→</span>";
          var objDisplay = esc((step.objectLabel || step.objectName || "").replace(/__dlm$|__cio$/g,""));
          var objApi = step.objectName ? "<span style='color:#94a3b8;font-size:9px;font-weight:400;'> [" + esc(step.objectName) + "]</span>" : "";
          var fieldDisplay = step.fieldLabel || step.fieldName || "";
          var fieldApi = (step.fieldName && step.fieldLabel && step.fieldName !== step.fieldLabel) ? " <span style='font-size:9px;color:#94a3b8;'>" + esc(step.fieldName) + "</span>" : "";
          ph += "<span style='background:#fff;border:1px solid #0284c7;color:#0369a1;border-radius:14px;padding:3px 10px;font-size:10px;font-weight:600;white-space:nowrap;'>" + objDisplay + objApi + " <span style='color:#64748b;font-weight:400;'>(" + esc(fieldDisplay) + fieldApi + ")</span></span>";
        });
        ph += "</div>";
      });
      return ph + "</div>";
    }

    // Build tab content
    // TAB 1: Studio UI (with sidebar)
    var tab1Main = "";
    var tab1Sidebar = "";
    // Overview grid
    tab1Main += "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;padding:14px;background:#fafafa;border:1px solid #eee;border-radius:6px;margin-bottom:16px;'>";
    var ovFields = [["Name", data.name],["Status", data.status],["Platform", target.platformName],["Target", data.activationTargetName],["Type", data.activationType],["Data Space", data.dataSpaceName],["Segment", data.segmentApiName],["Refresh", data.refreshType],["Processing", data.processingType],["Last Publish", data.lastPublishStatus]];
    ovFields.forEach(function(f) { if (f[1]) tab1Main += "<div><div style='font:700 9px system-ui;color:#64748b;text-transform:uppercase;'>" + f[0] + "</div><div style='font:500 12px system-ui;color:#1e293b;margin-top:2px;'>" + esc(String(f[1])) + "</div></div>"; });
    tab1Main += "</div>";
    // Membership
    tab1Main += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin-bottom:16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:4px;'>Activation Membership</div><div style='font:600 12px system-ui;color:#0176d3;'>" + esc(sub.masterLabel || data.membershipName || "") + "</div><div style='font:400 11px system-ui;color:#64748b;'>" + esc(sub.developerName || "") + "</div></div>";
    // Contact Points
    if (cps.length > 0) {
      tab1Main += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin-bottom:16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:8px;'>Contact Points</div>";
      cps.forEach(function(cp) {
        tab1Main += "<div style='padding:10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;margin-bottom:8px;'>";
        tab1Main += "<div style='font:600 12px system-ui;color:#0369a1;margin-bottom:4px;'>Channel: " + esc(cp.type || "") + " — " + esc(cp.contactPointEntityName || "") + "</div>";
        if (cp.fieldConfig && cp.fieldConfig.contactPointFields) {
          cp.fieldConfig.contactPointFields.forEach(function(f) { tab1Main += "<div style='font-size:11px;color:#1e293b;'>Field: <b>" + esc(f.label) + "</b> (" + esc(f.name) + ")</div>"; });
        }
        if (cp.queryPathConfig && cp.queryPathConfig.configs) tab1Main += renderPath(cp.queryPathConfig.configs);
        tab1Main += "</div>";
      });
      tab1Main += "</div>";
    }
    // Attributes grouped
    tab1Main += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin-bottom:16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:8px;'>Mapped Attributes (" + attrs.length + ")</div>";
    var byEntity = {};
    attrs.forEach(function(a) { var en = a.entityName || "Unknown"; if (!byEntity[en]) byEntity[en] = []; byEntity[en].push(a); });
    Object.keys(byEntity).sort().forEach(function(en) {
      var ea = byEntity[en];
      var objType = en.endsWith("__dlm") ? "DMO" : en.endsWith("__cio") ? "CIO" : "Custom";
      var tagStyle = objType === "DMO" ? "background:#e0f2fe;color:#0369a1;" : objType === "CIO" ? "background:#f3e8ff;color:#6b21a8;" : "background:#f3f4f6;color:#374151;";
      tab1Main += "<div style='font:600 12px system-ui;color:#1e293b;padding:6px 10px;background:#f3f4f6;border-radius:4px;margin:10px 0 4px;display:flex;align-items:center;gap:8px;'>" + esc(en.replace(/__dlm$|__cio$/g,"")) + " (" + ea.length + ") <span style='font-size:9px;padding:2px 6px;border-radius:3px;" + tagStyle + "'>" + objType + "</span></div>";
      tab1Main += "<table style='width:100%;border-collapse:collapse;font-size:11px;'><thead><tr style='background:#f9fafb;'><th style='padding:5px 8px;border:1px solid #e5e7eb;width:25px;'>#</th><th style='padding:5px 8px;border:1px solid #e5e7eb;'>Label</th><th style='padding:5px 8px;border:1px solid #e5e7eb;'>API Name</th><th style='padding:5px 8px;border:1px solid #e5e7eb;'>Output Name</th><th style='padding:5px 8px;border:1px solid #e5e7eb;'>Source</th></tr></thead><tbody>";
      ea.forEach(function(a, i) {
        var srcStyle = a.source === "DIRECT" ? "background:#dcfce7;color:#166534;" : a.source === "RELATED" ? "background:#fef3c7;color:#92400e;" : "background:#fae8ff;color:#86198f;";
        tab1Main += "<tr><td style='padding:5px 8px;border:1px solid #e5e7eb;text-align:center;color:#6b7280;'>" + (i+1) + "</td><td style='padding:5px 8px;border:1px solid #e5e7eb;'>" + esc(a.label || a.name) + "</td><td style='padding:5px 8px;border:1px solid #e5e7eb;font:10px monospace;color:#0369a1;'>" + esc(a.name || "") + "</td><td style='padding:5px 8px;border:1px solid #e5e7eb;font:10px monospace;color:#4a6fa5;'>" + esc(a.preferredName || a.referenceAttributeName || "") + "</td><td style='padding:5px 8px;border:1px solid #e5e7eb;'><span style='font-size:9px;padding:1px 5px;border-radius:3px;" + srcStyle + "'>" + esc(a.source || a.type || "") + "</span></td></tr>";
      });
      tab1Main += "</tbody></table>";
    });
    tab1Main += "</div>";
    // Campaign
    if (staticData.length > 0) {
      tab1Main += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin-bottom:16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:8px;'>Campaign Data</div>";
      tab1Main += "<table style='width:100%;border-collapse:collapse;font-size:12px;'><thead><tr style='background:#f9fafb;'><th style='padding:6px 10px;border:1px solid #e5e7eb;'>Name</th><th style='padding:6px 10px;border:1px solid #e5e7eb;'>Value</th></tr></thead><tbody>";
      staticData.forEach(function(sd) { tab1Main += "<tr><td style='padding:6px 10px;border:1px solid #e5e7eb;font-weight:600;'>" + esc(sd.name) + "</td><td style='padding:6px 10px;border:1px solid #e5e7eb;font-family:monospace;'>" + esc(sd.value) + "</td></tr>"; });
      tab1Main += "</tbody></table></div>";
    }

    // Waterfall Child Segments
    if (data.waterfallSelectedChildSegmentsConfig && data.waterfallSelectedChildSegmentsConfig.childSegmentsConfig) {
      var childSegs = data.waterfallSelectedChildSegmentsConfig.childSegmentsConfig.childSegments || [];
      var allSelected = data.waterfallSelectedChildSegmentsConfig.selectedAllSegments;
      if (childSegs.length > 0) {
        tab1Main += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;margin-bottom:16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:8px;'>Waterfall Segments" + (allSelected ? " (All Selected)" : "") + "</div>";
        tab1Main += "<div style='display:flex;flex-wrap:wrap;gap:6px;'>";
        childSegs.forEach(function(seg) { tab1Main += "<span style='background:#dbeafe;color:#1e40af;padding:4px 10px;border-radius:12px;font-size:11px;font-weight:600;'>" + esc(seg.replace(/^TDI_/,"")) + "</span>"; });
        tab1Main += "</div></div>";
      }
    }

    // Sidebar: Activation Overview + Attributes Included
    tab1Sidebar += "<div style='font:700 13px system-ui;color:#374151;margin-bottom:12px;border-bottom:1px solid #e5e7eb;padding-bottom:8px;'>Activation Overview</div>";
    tab1Sidebar += "<div style='display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;'><div style='width:24px;height:24px;border-radius:50%;background:#e06e00;color:#fff;display:flex;align-items:center;justify-content:center;font:bold 9px system-ui;flex-shrink:0;'>DS</div><div><b>" + esc(data.dataSpaceName || "") + "</b><div style='font-size:10px;color:#64748b;'>Data Space</div></div></div>";
    tab1Sidebar += "<div style='display:flex;align-items:flex-start;gap:10px;margin-bottom:12px;'><div style='width:24px;height:24px;border-radius:50%;background:#0176d3;color:#fff;display:flex;align-items:center;justify-content:center;font:bold 9px system-ui;flex-shrink:0;'>A</div><div><b style='color:#0176d3;'>" + esc(data.name || "") + "</b><div style='font-size:10px;color:#64748b;'>Status: <span style='background:#dcfce7;color:#15803d;padding:1px 6px;border-radius:8px;font-size:9px;font-weight:700;'>" + esc(data.status || "") + "</span></div><div style='font-size:10px;color:#64748b;'>Refresh: " + esc(data.refreshType || "") + "</div></div></div>";
    tab1Sidebar += "<div style='display:flex;align-items:flex-start;gap:10px;margin-bottom:14px;'><div style='width:24px;height:24px;border-radius:50%;background:#c23934;color:#fff;display:flex;align-items:center;justify-content:center;font:bold 9px system-ui;flex-shrink:0;'>MC</div><div><b>" + esc(target.name || data.activationTargetName || "") + "</b><div style='font-size:10px;color:#64748b;'>" + esc(target.platformName || "") + "</div></div></div>";
    // Build complete attributes list (merge: regular attrs + contact point fields + waterfall system fields)
    var allIncluded = [];
    // Waterfall system fields (SubSegmentId, SubSegmentName)
    if (data.waterfallSelectedChildSegmentsConfig) {
      allIncluded.push({ label: "SubSegmentId", source: "SYSTEM", entityName: "System" });
      allIncluded.push({ label: "SubSegmentName", source: "SYSTEM", entityName: "System" });
    }
    // Regular attributes
    attrs.forEach(function(a) { allIncluded.push(a); });
    // Contact point fields (e.g. Email Address)
    cps.forEach(function(cp) {
      if (cp.fieldConfig && cp.fieldConfig.contactPointFields) {
        cp.fieldConfig.contactPointFields.forEach(function(f) {
          var alreadyInAttrs = attrs.some(function(a) { return a.name === f.name; });
          if (!alreadyInAttrs) allIncluded.push({ label: f.label || f.name, name: f.name, source: "CONTACT_POINT", entityName: cp.contactPointEntityName || "" });
        });
      }
    });

    tab1Sidebar += "<div style='border-top:1px solid #e5e7eb;padding-top:12px;'><div style='font:700 12px system-ui;color:#374151;margin-bottom:8px;'>Attributes Included (" + allIncluded.length + ")</div><div style='max-height:350px;overflow-y:auto;'>";
    allIncluded.forEach(function(a, idx) {
      var srcStyle = a.source === "DIRECT" ? "background:#dcfce7;color:#166534;" : a.source === "RELATED" ? "background:#fef3c7;color:#92400e;" : a.source === "CONTACT_POINT" ? "background:#dbeafe;color:#1e40af;" : a.source === "SYSTEM" ? "background:#f3f4f6;color:#374151;" : "background:#fae8ff;color:#86198f;";
      tab1Sidebar += "<div style='padding:4px 0;border-bottom:1px dashed #eee;font-size:11px;'><div style='display:flex;justify-content:space-between;align-items:center;'><b>" + (idx+1) + ". " + esc(a.label || a.name || "") + "</b><span style='font-size:9px;padding:1px 5px;border-radius:3px;" + srcStyle + "'>" + esc(a.source || a.type || "") + "</span></div><div style='font-size:10px;color:#0369a1;font-family:monospace;'>" + esc(a.name || "") + "</div><div style='font-size:10px;color:#64748b;'>From: <code style='font-size:9px;'>" + esc((a.entityName || "").replace(/__dlm$|__cio$/g,"")) + "</code></div></div>";
    });
    tab1Sidebar += "</div></div>";

    // Combine: main + sidebar layout
    var tab1 = "<div style='display:flex;gap:16px;align-items:flex-start;'><div style='flex:1;min-width:0;'>" + tab1Main + "</div><div style='width:320px;flex-shrink:0;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:16px;position:sticky;top:0;'>" + tab1Sidebar + "</div></div>";

    // TAB 2: Filters
    var tab2 = "";
    var hasAnyFilters = false;

    // 1. Related DMO Filters
    tab2 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin-bottom:14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Related DMO Filters</h3></div>";
    if (filters.length > 0) {
      hasAnyFilters = true;
      filters.forEach(function(f, idx) {
        var ef = f.entityFilter || {};
        var cond = ef.condition || {};
        var subj = cond.subject || {};
        var limit = f.filterLimit || {};
        tab2 += "<div style='background:#f0f7fc;border-left:4px solid #0176d3;border-radius:0 6px 6px 0;padding:14px;margin-bottom:12px;'>";
        tab2 += "<div style='font:600 13px system-ui;color:#0176d3;margin-bottom:6px;'>Filter #" + (idx+1) + ": " + esc(f.entityName || "") + "</div>";
        tab2 += "<div style='font-size:12px;color:#1e293b;'><b>Condition:</b> <code>" + esc(subj.fieldName || "") + "</code> <b>" + esc(cond.operator || "") + "</b> " + (cond.firstBoundValue != null ? "<b>" + esc(cond.firstBoundValue) + "</b> – <b>" + esc(cond.secondBoundValue) + "</b>" : "") + "</div>";
        tab2 += "<div style='font-size:11px;color:#475569;margin-top:4px;'><b>Limit:</b> Max " + esc(limit.maxNumberOfValues || "") + " values, sort <code>" + esc(limit.attributeName || "") + "</code> " + esc(limit.order || "") + "</div>";
        if (f.queryPathConfigForActivateOnToContainer && f.queryPathConfigForActivateOnToContainer.configs) {
          tab2 += "<div style='margin-top:6px;font-size:10px;font-weight:600;color:#475569;'>Resolution Path:</div>" + renderPath(f.queryPathConfigForActivateOnToContainer.configs);
        }
        tab2 += "</div>";
      });
    } else {
      tab2 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>No related DMO filters configured</div>";
    }

    // 2. Contact Point Filters
    tab2 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin:20px 0 14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Contact Point Filters</h3></div>";
    var cpFilterCount = 0;
    if (cps.length > 0) {
      cps.forEach(function(cp, cpIdx) {
        if (cp.filterExpression && cp.filterExpression.contactPointDmoFilters && cp.filterExpression.contactPointDmoFilters.length > 0) {
          hasAnyFilters = true;
          cpFilterCount++;
          var cpFilters = cp.filterExpression.contactPointDmoFilters;
          tab2 += "<div style='background:#fef3c7;border-left:4px solid #f59e0b;border-radius:0 6px 6px 0;padding:14px;margin-bottom:12px;'>";
          tab2 += "<div style='font:600 13px system-ui;color:#d97706;margin-bottom:8px;'>Contact Point: " + esc(cp.type || "Unknown") + " – " + esc(cp.contactPointEntityName || "") + "</div>";

          cpFilters.forEach(function(f, idx) {
            var ef = f.entityFilter || {};
            var cond = ef.condition || {};
            var subj = cond.subject || {};
            var limit = f.filterLimit || {};
            tab2 += "<div style='background:#fffbeb;border:1px solid #fbbf24;border-radius:4px;padding:10px;margin-bottom:8px;'>";
            tab2 += "<div style='font:600 12px system-ui;color:#92400e;margin-bottom:4px;'>Filter #" + (idx+1) + ": " + esc(f.entityName || "") + "</div>";
            tab2 += "<div style='font-size:11px;color:#1e293b;'><b>Condition:</b> <code>" + esc(subj.fieldName || "") + "</code> <b>" + esc(cond.operator || "") + "</b>";
            if (cond.firstBoundValue != null) {
              tab2 += " <b>" + esc(cond.firstBoundValue) + "</b> – <b>" + esc(cond.secondBoundValue) + "</b>";
            } else if (cond.values && cond.values.length > 0) {
              tab2 += " <b>" + esc(cond.values.join(", ")) + "</b>";
            }
            tab2 += "</div>";
            if (limit && limit.maxNumberOfValues) {
              tab2 += "<div style='font-size:10px;color:#475569;margin-top:3px;'><b>Limit:</b> Max " + esc(limit.maxNumberOfValues) + " values";
              if (limit.attributeName) tab2 += ", sort <code>" + esc(limit.attributeName) + "</code> " + esc(limit.order || "");
              tab2 += "</div>";
            }
            if (f.queryPathConfigForActivateOnToContainer && f.queryPathConfigForActivateOnToContainer.configs) {
              tab2 += "<div style='margin-top:6px;font-size:10px;font-weight:600;color:#475569;'>Resolution Path:</div>" + renderPath(f.queryPathConfigForActivateOnToContainer.configs);
            }
            tab2 += "</div>";
          });
          tab2 += "</div>";
        }
      });
    }
    if (cpFilterCount === 0) {
      tab2 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>No contact point filters configured</div>";
    }

    // 3. Direct DMO Filters
    tab2 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin:20px 0 14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Direct DMO Filters</h3></div>";
    var directFilters = (data.directDmoFiltersConfig && data.directDmoFiltersConfig.filters) || [];
    if (directFilters.length > 0) {
      hasAnyFilters = true;
      tab2 += "<div style='background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:12px;'>";
      tab2 += "<pre style='margin:0;font-size:11px;color:#1e293b;overflow-x:auto;'>" + esc(JSON.stringify(directFilters, null, 2)) + "</pre>";
      tab2 += "</div>";
    } else {
      tab2 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>No direct DMO filters configured</div>";
    }

    if (!hasAnyFilters) {
      tab2 = "<div style='color:#94a3b8;padding:40px 20px;text-align:center;font-size:14px;'>No filters configured for this activation</div>";
    }

    // TAB 3: Schema & Paths
    var tab3 = "";

    // 1. Activation Record Schema
    tab3 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin-bottom:14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Activation Record Schema</h3></div>";
    if (data.activationRecordSchema) {
      try {
        var schemaStr = data.activationRecordSchema;
        // Decode HTML entities if present
        if (typeof schemaStr === "string" && schemaStr.indexOf("&quot;") !== -1) {
          schemaStr = schemaStr.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        }
        var schema = typeof schemaStr === "string" ? JSON.parse(schemaStr) : schemaStr;

        // Schema is an object where keys are field names (except "type" which is the root type)
        var schemaKeys = Object.keys(schema).filter(function(k) { return k !== "type"; });
        if (schemaKeys.length > 0) {
          tab3 += "<div style='overflow-x:auto;'><table style='width:100%;border-collapse:collapse;font-size:11px;margin-bottom:20px;'>";
          tab3 += "<thead><tr style='background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;'><th style='padding:8px;border:1px solid #cbd5e1;'>#</th><th style='padding:8px;border:1px solid #cbd5e1;'>Payload Key</th><th style='padding:8px;border:1px solid #cbd5e1;'>Label</th><th style='padding:8px;border:1px solid #cbd5e1;'>Field API</th><th style='padding:8px;border:1px solid #cbd5e1;'>Source Object</th><th style='padding:8px;border:1px solid #cbd5e1;'>Type</th><th style='padding:8px;border:1px solid #cbd5e1;'>DC Type</th><th style='padding:8px;border:1px solid #cbd5e1;text-align:center;'>Nullable</th></tr></thead><tbody>";
          var rowNum = 0;
          schemaKeys.forEach(function(key) {
            var field = schema[key];
            if (!field || typeof field !== "object") return;
            rowNum++;
            if (field.type === "array" && field.items) {
              // Array type — show parent row + nested child fields
              tab3 += "<tr style='background:#eff6ff;'><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#1e40af;font-weight:700;text-align:center;'>" + rowNum + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-weight:700;color:#1e40af;'>" + esc(key) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#1e40af;'>" + esc(field.items.label || key) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;'>—</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-size:10px;color:#059669;'>" + esc((field.items.objectApiName || "").replace(/__dlm$|__cio$/g,"")) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#1e40af;'>array</td><td style='padding:6px 8px;border:1px solid #e2e8f0;'>—</td><td style='padding:6px 8px;border:1px solid #e2e8f0;text-align:center;'>—</td></tr>";
              // Nested fields
              Object.keys(field.items).forEach(function(childKey) {
                if (childKey === "type" || childKey === "objectApiName" || childKey === "label") return;
                var childField = field.items[childKey];
                if (!childField || typeof childField !== "object") return;
                rowNum++;
                tab3 += "<tr style='background:#f8fafc;'><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#64748b;text-align:center;font-size:10px;'>" + rowNum + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-family:monospace;font-size:10px;color:#475569;padding-left:24px;'>↳ " + esc(childKey) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;'>" + esc(childField.label || childKey) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-family:monospace;font-size:10px;color:#0369a1;'>" + esc(childField.fieldApiName || "") + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-size:10px;color:#059669;'>" + esc((childField.objectApiName || "").replace(/__dlm$|__cio$/g,"")) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;'>" + esc(childField.type || "") + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#6b21a8;'>" + esc(childField.dataCloudDataType || "") + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;text-align:center;'>" + (childField.nullable ? "<span style='color:#059669;'>Yes</span>" : "<span style='color:#dc2626;font-weight:600;'>Required</span>") + "</td></tr>";
              });
            } else {
              // Regular field
              tab3 += "<tr><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#64748b;text-align:center;'>" + rowNum + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-family:monospace;color:#1e293b;font-weight:600;'>" + esc(key) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;'>" + esc(field.label || key) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-family:monospace;font-size:10px;color:#0369a1;'>" + esc(field.fieldApiName || "—") + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;font-size:10px;color:#059669;'>" + esc((field.objectApiName || "—").replace(/__dlm$|__cio$/g,"")) + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;'>" + esc(field.type || "") + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;color:#6b21a8;'>" + esc(field.dataCloudDataType || "") + "</td><td style='padding:6px 8px;border:1px solid #e2e8f0;text-align:center;'>" + (field.nullable ? "<span style='color:#059669;'>Yes</span>" : "<span style='color:#dc2626;font-weight:600;'>Required</span>") + "</td></tr>";
            }
          });
          tab3 += "</tbody></table></div>";
        } else {
          tab3 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>Schema has no field definitions</div>";
        }
      } catch (e) {
        tab3 += "<div style='background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px;margin-bottom:20px;'>";
        tab3 += "<div style='font:600 11px system-ui;color:#991b1b;margin-bottom:6px;'>Failed to parse schema JSON: " + esc(e.message) + "</div>";
        tab3 += "<pre style='margin:0;font-size:10px;color:#7f1d1d;overflow-x:auto;'>" + esc(String(data.activationRecordSchema).substring(0, 500)) + "...</pre>";
        tab3 += "</div>";
      }
    } else {
      tab3 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;margin-bottom:20px;'>No activation record schema available</div>";
    }

    // 2. Contact Point Query Paths (multi-hop joins)
    tab3 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin:20px 0 14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Contact Point Query Paths</h3></div>";
    var cpPathCount = 0;
    if (cps.length > 0) {
      cps.forEach(function(cp) {
        if (cp.queryPathConfig && cp.queryPathConfig.configs && cp.queryPathConfig.configs.length > 0) {
          var hasValidPath = false;
          cp.queryPathConfig.configs.forEach(function(cfg) {
            if (cfg.queryPath && cfg.queryPath.length > 0) hasValidPath = true;
          });
          if (hasValidPath) {
            cpPathCount++;
            tab3 += "<div style='border:1px solid #bae6fd;border-radius:6px;padding:12px;margin-bottom:12px;background:#f0f9ff;'>";
            tab3 += "<div style='font:600 12px system-ui;color:#0369a1;margin-bottom:8px;'>Channel: " + esc(cp.type || "Unknown") + " – " + esc(cp.contactPointEntityName || "") + "</div>";
            tab3 += renderPath(cp.queryPathConfig.configs);
            tab3 += "</div>";
          }
        }
      });
    }
    if (cpPathCount === 0) {
      tab3 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>No contact point query paths configured</div>";
    }

    // 3. Attribute Query Paths (related attributes)
    tab3 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin:20px 0 14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Attribute Query Paths</h3></div>";
    var attrPathCount = 0;
    attrs.forEach(function(a) {
      if (a.queryPathConfig && a.queryPathConfig.configs && a.queryPathConfig.configs.length > 0 && a.queryPathConfig.configs[0].queryPath && a.queryPathConfig.configs[0].queryPath.length > 0) {
        attrPathCount++;
        tab3 += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:10px 14px;margin-bottom:10px;'>";
        tab3 += "<div style='font:600 11px system-ui;color:#1e293b;margin-bottom:4px;'>" + esc(a.label || a.name) + " <span style='color:#64748b;font-weight:400;'>(" + esc(a.entityName || "") + ")</span></div>";
        tab3 += renderPath(a.queryPathConfig.configs);
        tab3 += "</div>";
      }
    });
    if (attrPathCount === 0) {
      tab3 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>No attribute query paths (all attributes are DIRECT)</div>";
    }

    // 4. Filter Resolution Paths
    tab3 += "<div style='border-bottom:2px solid #e2e8f0;padding-bottom:10px;margin:20px 0 14px;'><h3 style='font:700 14px system-ui;color:#1e293b;margin:0;'>Filter Resolution Paths</h3></div>";
    var filterPathCount = 0;

    // Check related DMO filters
    if (filters.length > 0) {
      filters.forEach(function(f, idx) {
        if (f.queryPathConfigForActivateOnToContainer && f.queryPathConfigForActivateOnToContainer.configs && f.queryPathConfigForActivateOnToContainer.configs.length > 0) {
          filterPathCount++;
          tab3 += "<div style='border:1px solid #ddd6fe;border-radius:6px;padding:10px 14px;margin-bottom:10px;background:#faf5ff;'>";
          tab3 += "<div style='font:600 11px system-ui;color:#6b21a8;margin-bottom:4px;'>Related Filter #" + (idx+1) + ": " + esc(f.entityName || "") + "</div>";
          tab3 += renderPath(f.queryPathConfigForActivateOnToContainer.configs);
          tab3 += "</div>";
        }
      });
    }

    // Check contact point filters
    if (cps.length > 0) {
      cps.forEach(function(cp) {
        if (cp.filterExpression && cp.filterExpression.contactPointDmoFilters && cp.filterExpression.contactPointDmoFilters.length > 0) {
          cp.filterExpression.contactPointDmoFilters.forEach(function(f, idx) {
            if (f.queryPathConfigForActivateOnToContainer && f.queryPathConfigForActivateOnToContainer.configs && f.queryPathConfigForActivateOnToContainer.configs.length > 0) {
              filterPathCount++;
              tab3 += "<div style='border:1px solid #fde68a;border-radius:6px;padding:10px 14px;margin-bottom:10px;background:#fefce8;'>";
              tab3 += "<div style='font:600 11px system-ui;color:#92400e;margin-bottom:4px;'>Contact Point Filter #" + (idx+1) + " (" + esc(cp.type || "") + "): " + esc(f.entityName || "") + "</div>";
              tab3 += renderPath(f.queryPathConfigForActivateOnToContainer.configs);
              tab3 += "</div>";
            }
          });
        }
      });
    }

    if (filterPathCount === 0) {
      tab3 += "<div style='color:#94a3b8;padding:12px 0;font-size:12px;'>No filter resolution paths configured</div>";
    }

    // TAB 4: Audit + Catch-All (ALL remaining fields)
    var tab4 = "";

    // Known fields rendered in structured tabs
    var renderedKeys = ["activationTarget","activationTargetId","activationTargetName","activationTargetSubjectConfig","activationType","attributesConfig","contactPointsConfig","staticDataConfig","relatedDmoFiltersConfig","directDmoFiltersConfig","dataSourcesConfig","activationRecordSchema","waterfallSelectedChildSegmentsConfig"];

    // System & audit fields
    tab4 += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:14px 16px;margin-bottom:16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:10px;'>System Identifiers & Audit</div>";
    tab4 += "<div style='display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;padding:12px;background:#fafafa;border:1px solid #eee;border-radius:4px;'>";
    var auditFields = [["Activation ID", data.id],["Definition ID", data.activationDefinitionId],["Developer Name", data.developerName],["Name", data.name],["Segment ID", data.segmentId || data.marketSegmentId],["Segment API", data.segmentApiName],["Target ID", data.activationTargetId],["Platform Type", (data.activationTarget && data.activationTarget.platformType)],["Created By", data.createdBy && data.createdBy.id],["Created Date", data.createdDate],["Modified By", data.lastModifiedBy && data.lastModifiedBy.id],["Modified Date", data.lastModifiedDate],["Last Publish Date", data.lastPublishDate],["Last Publish Status", data.lastPublishStatus],["History Audience DMO", data.historyAudienceDmoApiName],["History Audience Label", data.historyAudienceDmoLabel],["Latest Audience DMO", data.latestAudienceDmoApiName],["Latest Audience Label", data.latestAudienceDmoLabel],["Last Run Timestamp", data.latestAudienceDmoLastRunTimestamp],["Enabled", data.enabled],["Is Enabled", data.isEnabled],["Exclude Deletes", data.shouldExcludeDeletes],["Exclude Updates", data.shouldExcludeUpdates],["Processing Type", data.processingType],["Refresh Type", data.refreshType],["Status", data.status],["Data Space", data.dataSpaceName],["Membership Name", data.membershipName],["Market Segment ID", data.marketSegmentId]];
    auditFields.forEach(function(f) { if (f[1] != null && f[1] !== "") tab4 += "<div><div style='font:700 9px system-ui;color:#64748b;text-transform:uppercase;'>" + f[0] + "</div><div style='font:500 11px system-ui;color:#1e293b;margin-top:2px;word-break:break-all;'>" + esc(String(f[1])) + "</div></div>"; });
    tab4 += "</div></div>";

    // Catch-all: render any API keys NOT already handled
    var handledKeys = ["id","activationDefinitionId","developerName","name","segmentId","segmentApiName","activationTargetId","createdBy","createdDate","lastModifiedBy","lastModifiedDate","lastPublishDate","lastPublishStatus","historyAudienceDmoApiName","historyAudienceDmoLabel","latestAudienceDmoApiName","latestAudienceDmoLabel","latestAudienceDmoLastRunTimestamp","enabled","isEnabled","shouldExcludeDeletes","shouldExcludeUpdates","processingType","refreshType","status","dataSpaceName","membershipName","marketSegmentId","curatedEntity","queryPathConfig"];
    var allHandled = renderedKeys.concat(handledKeys);
    var remainingKeys = Object.keys(data).filter(function(k) { return allHandled.indexOf(k) < 0; });

    if (remainingKeys.length > 0) {
      tab4 += "<div style='border:1px solid #fcd34d;border-radius:6px;padding:14px 16px;margin-bottom:16px;background:#fffbeb;'><div style='font:700 13px system-ui;color:#92400e;margin-bottom:10px;'>Additional Fields (" + remainingKeys.length + " not shown elsewhere)</div>";
      tab4 += "<table style='width:100%;border-collapse:collapse;font-size:11px;'><thead><tr style='background:#fef3c7;'><th style='padding:6px 10px;border:1px solid #fcd34d;text-align:left;'>Key</th><th style='padding:6px 10px;border:1px solid #fcd34d;text-align:left;'>Value</th></tr></thead><tbody>";
      remainingKeys.forEach(function(k) {
        var v = data[k];
        var display = "";
        if (v === null || v === undefined) display = "<span style='color:#94a3b8;'>null</span>";
        else if (typeof v === "object") display = "<pre style='margin:0;font-size:10px;max-height:100px;overflow:auto;background:#fff;padding:4px;border-radius:3px;'>" + esc(JSON.stringify(v, null, 2)) + "</pre>";
        else display = esc(String(v));
        tab4 += "<tr><td style='padding:6px 10px;border:1px solid #fcd34d;font-weight:600;font-family:monospace;color:#92400e;vertical-align:top;width:200px;'>" + esc(k) + "</td><td style='padding:6px 10px;border:1px solid #fcd34d;'>" + display + "</td></tr>";
      });
      tab4 += "</tbody></table></div>";
    }

    // Empty object fields (curatedEntity, queryPathConfig etc.)
    tab4 += "<div style='border:1px solid #e2e8f0;border-radius:6px;padding:14px 16px;'><div style='font:700 13px system-ui;color:#1e293b;margin-bottom:10px;'>Empty/Null Configurations</div><div style='font-size:11px;color:#64748b;'>";
    if (data.curatedEntity && Object.keys(data.curatedEntity).length === 0) tab4 += "<div style='padding:2px 0;'>curatedEntity: <span style='color:#94a3b8;'>{} (empty)</span></div>";
    if (data.queryPathConfig && data.queryPathConfig.configs && data.queryPathConfig.configs.length === 0) tab4 += "<div style='padding:2px 0;'>queryPathConfig: <span style='color:#94a3b8;'>no configs</span></div>";
    if (data.dataSourcesConfig && data.dataSourcesConfig.dataSources && data.dataSourcesConfig.dataSources.length === 0) tab4 += "<div style='padding:2px 0;'>dataSourcesConfig: <span style='color:#94a3b8;'>no data sources</span></div>";
    if (data.directDmoFiltersConfig && data.directDmoFiltersConfig.filters && data.directDmoFiltersConfig.filters.length === 0) tab4 += "<div style='padding:2px 0;'>directDmoFiltersConfig: <span style='color:#94a3b8;'>no filters</span></div>";
    tab4 += "</div></div>";

    // Build modal
    var modal = document.createElement("div");
    modal.id = "dc-activation-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;border-radius:12px;width:95vw;max-width:1400px;height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.3);resize:both;overflow:hidden;min-width:600px;min-height:400px;";

    // Header
    var hdr = document.createElement("div");
    hdr.style.cssText = "padding:14px 20px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;display:flex;align-items:center;gap:12px;cursor:grab;flex-shrink:0;";
    hdr.innerHTML = "<div style='flex:1;'><div style='font:700 16px system-ui;'>" + esc(targetName) + "</div><div style='font:400 11px system-ui;opacity:0.8;'>Activation Studio Inspector</div></div>";
    // Buttons
    var dlHtmlBtn = document.createElement("button");
    dlHtmlBtn.textContent = "⬇ HTML"; dlHtmlBtn.title = "Download this export as a formatted HTML file you can open in a browser or share."; dlHtmlBtn.style.cssText = "border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.15);color:#fff;border-radius:5px;padding:5px 10px;cursor:pointer;font:600 10px system-ui;";
    dlHtmlBtn.onclick = function() { var b = new Blob([generateRichDashboardHTML(data, targetName)], {type:"text/html"}); var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "activation-" + targetName.replace(/[^a-zA-Z0-9]/g,"-") + ".html"; a.click(); };
    var dlExcelBtn = document.createElement("button");
    dlExcelBtn.textContent = "⬇ Excel"; dlExcelBtn.title = "Download this export as an Excel (.xlsx) spreadsheet for filtering/sharing in Sheets or Excel."; dlExcelBtn.style.cssText = "border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.15);color:#fff;border-radius:5px;padding:5px 10px;cursor:pointer;font:600 10px system-ui;";
    dlExcelBtn.onclick = function() {
      var _MiniXLSX = (typeof SEGX !== "undefined" && SEGX && SEGX.MiniXLSX) ? SEGX.MiniXLSX : (typeof MiniXLSX !== "undefined" ? MiniXLSX : null);
      if (!_MiniXLSX) { alert("Excel builder not available — use the full extension build"); return; }
      var wb = new _MiniXLSX.Workbook();
      var hdrFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF667eea" } };
      var hdrFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      var boldFont = { bold: true, size: 11 };

      // Sheet 1: Overview
      var ws1 = wb.addWorksheet("Overview");
      ws1.getColumn(1).width = 22; ws1.getColumn(2).width = 45;
      ws1.getCell(1,1).value = "ACTIVATION: " + (targetName || ""); ws1.getCell(1,1).font = { bold: true, size: 14, color: { argb: "FF667eea" } };
      ws1.getRow(1).height = 22;
      var ovRows = [["Name",data.name],["Status",data.status],["Platform",target.platformName],["Target",data.activationTargetName],["Type",data.activationType],["Data Space",data.dataSpaceName],["Segment",data.segmentApiName],["Refresh Type",data.refreshType],["Processing",data.processingType],["Subject Entity",sub.masterLabel || sub.developerName],["Developer Name",data.developerName],["Created",data.createdDate],["Last Modified",data.lastModifiedDate],["Last Publish",data.lastPublishDate],["Publish Status",data.lastPublishStatus],["Activation ID",data.id]];
      var r1 = 3;
      ovRows.forEach(function(row) {
        if (!row[1]) return;
        ws1.getCell(r1,1).value = row[0]; ws1.getCell(r1,1).font = boldFont;
        ws1.getCell(r1,2).value = String(row[1]);
        r1++;
      });

      // Sheet 2: Attributes
      var ws2 = wb.addWorksheet("Attributes");
      ws2.getColumn(1).width = 5; ws2.getColumn(2).width = 25; ws2.getColumn(3).width = 22; ws2.getColumn(4).width = 30; ws2.getColumn(5).width = 35; ws2.getColumn(6).width = 10; ws2.getColumn(7).width = 14;
      var attrHeaders = ["#","Label","Preferred Name","API Name","Source Entity","Type","Source"];
      attrHeaders.forEach(function(h,i) { ws2.getCell(1,i+1).value = h; ws2.getCell(1,i+1).font = hdrFont; ws2.getCell(1,i+1).fill = hdrFill; });
      attrs.forEach(function(a,i) {
        var r = i + 2;
        ws2.getCell(r,1).value = i+1;
        ws2.getCell(r,2).value = a.label || a.name || "";
        ws2.getCell(r,3).value = a.preferredName || "";
        ws2.getCell(r,4).value = a.name || "";
        ws2.getCell(r,5).value = a.entityName || "";
        ws2.getCell(r,6).value = a.dataSourceType || "";
        ws2.getCell(r,7).value = a.source || a.type || "";
      });

      // Sheet 3: Contact Points
      var ws3 = wb.addWorksheet("Contact Points");
      ws3.getColumn(1).width = 10; ws3.getColumn(2).width = 35; ws3.getColumn(3).width = 20; ws3.getColumn(4).width = 25; ws3.getColumn(5).width = 50;
      ["Type","Entity","Field Label","Field API","Path"].forEach(function(h,i) { ws3.getCell(1,i+1).value = h; ws3.getCell(1,i+1).font = hdrFont; ws3.getCell(1,i+1).fill = hdrFill; });
      var r3 = 2;
      cps.forEach(function(cp) {
        var fields = (cp.fieldConfig && cp.fieldConfig.contactPointFields) || [];
        var pathStr = "";
        if (cp.queryPathConfig && cp.queryPathConfig.configs) {
          pathStr = cp.queryPathConfig.configs.map(function(cfg) { return (cfg.queryPath || []).map(function(s) { return (s.objectLabel || s.objectName || "").replace(/__dlm$/,"") + "." + (s.fieldLabel || s.fieldName || ""); }).join(" → "); }).join(" | ");
        }
        fields.forEach(function(f) {
          ws3.getCell(r3,1).value = cp.type || "";
          ws3.getCell(r3,2).value = cp.contactPointEntityName || "";
          ws3.getCell(r3,3).value = f.label || "";
          ws3.getCell(r3,4).value = f.name || "";
          ws3.getCell(r3,5).value = pathStr;
          r3++;
        });
        if (fields.length === 0) { ws3.getCell(r3,1).value = cp.type || ""; ws3.getCell(r3,2).value = cp.contactPointEntityName || ""; ws3.getCell(r3,5).value = pathStr; r3++; }
      });

      // Sheet 4: Campaign Data
      var ws4 = wb.addWorksheet("Campaign Data");
      ws4.getColumn(1).width = 25; ws4.getColumn(2).width = 50;
      ["Name","Value"].forEach(function(h,i) { ws4.getCell(1,i+1).value = h; ws4.getCell(1,i+1).font = hdrFont; ws4.getCell(1,i+1).fill = hdrFill; });
      staticData.forEach(function(sd,i) { ws4.getCell(i+2,1).value = sd.name; ws4.getCell(i+2,2).value = sd.value; });

      // Sheet 5: Filters
      var ws5 = wb.addWorksheet("Filters");
      ws5.getColumn(1).width = 30; ws5.getColumn(2).width = 22; ws5.getColumn(3).width = 12; ws5.getColumn(4).width = 15; ws5.getColumn(5).width = 12; ws5.getColumn(6).width = 20;
      ["Entity","Field","Operator","Value","Max Records","Sort"].forEach(function(h,i) { ws5.getCell(1,i+1).value = h; ws5.getCell(1,i+1).font = hdrFont; ws5.getCell(1,i+1).fill = hdrFill; });
      filters.forEach(function(f,i) {
        var c = (f.entityFilter && f.entityFilter.condition) || {}; var s = c.subject || {}; var lim = f.filterLimit || {};
        ws5.getCell(i+2,1).value = f.entityName || "";
        ws5.getCell(i+2,2).value = s.fieldName || "";
        ws5.getCell(i+2,3).value = c.operator || "";
        ws5.getCell(i+2,4).value = c.firstBoundValue != null ? c.firstBoundValue + " – " + c.secondBoundValue : "";
        ws5.getCell(i+2,5).value = lim.maxNumberOfValues || "";
        ws5.getCell(i+2,6).value = (lim.attributeName || "") + " " + (lim.order || "");
      });

      // Build and download
      wb.xlsx.writeBuffer().then(function(buf) {
        var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "activation-" + targetName.replace(/[^a-zA-Z0-9]/g,"-") + ".xlsx"; a.click();
      });
    };
    var closeX = document.createElement("button");
    closeX.textContent = "✕"; closeX.title = "Close this export view"; closeX.style.cssText = "border:none;background:none;color:#fff;font-size:20px;cursor:pointer;padding:4px 8px;";
    closeX.onclick = function() { modal.remove(); };
    var jsonBtn = document.createElement("button");
    jsonBtn.textContent = "{ } JSON"; jsonBtn.title = "Show the raw JSON behind this export (toggle) — useful for debugging or copying the exact structure."; jsonBtn.style.cssText = "border:1px solid rgba(255,255,255,.4);background:rgba(255,255,255,.15);color:#fff;border-radius:5px;padding:5px 10px;cursor:pointer;font:600 10px system-ui;";
    var jsonShowing = false;
    jsonBtn.onclick = function() {
      if (jsonShowing) {
        contentWrap.style.display = "";
        tabBar.style.display = "";
        var ov = box.querySelector("#dc-json-overlay"); if (ov) ov.remove();
        jsonBtn.textContent = "{ } JSON"; jsonShowing = false;
      } else {
        contentWrap.style.display = "none";
        tabBar.style.display = "none";
        var overlay = document.createElement("div");
        overlay.id = "dc-json-overlay";
        overlay.style.cssText = "flex:1;overflow:auto;display:flex;flex-direction:column;";
        overlay.innerHTML = "<div style='padding:10px 16px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;'><b style='font-size:13px;'>Raw JSON Response</b><button id='dc-json-copy' style='border:1px solid #0176d3;background:#fff;color:#0176d3;border-radius:5px;padding:4px 12px;cursor:pointer;font:600 11px system-ui;'>Copy JSON</button></div><pre style='flex:1;overflow:auto;padding:16px;margin:0;font:11px/1.5 SF Mono,Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:#1e293b;background:#f8fafc;'>" + esc(JSON.stringify(data, null, 2)) + "</pre>";
        box.appendChild(overlay);
        overlay.querySelector("#dc-json-copy").onclick = function() {
          var ta = document.createElement("textarea"); ta.value = JSON.stringify(data, null, 2); document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
          this.textContent = "Copied!"; var self = this; setTimeout(function() { self.textContent = "Copy JSON"; }, 1500);
        };
        jsonBtn.textContent = "✕ Close JSON"; jsonShowing = true;
      }
    };
    hdr.appendChild(jsonBtn); hdr.appendChild(dlHtmlBtn); hdr.appendChild(dlExcelBtn); hdr.appendChild(closeX);

    // Tabs
    var tabBar = document.createElement("div");
    tabBar.style.cssText = "display:flex;border-bottom:2px solid #e5e7eb;background:#f9fafb;flex-shrink:0;";
    var tabs = [["studio","Studio UI View"],["filters","Filters & Rules"],["schema","Schema & Paths"],["audit","Audit & Metadata"]];
    var tabTips = { studio: "See the activation laid out like the Salesforce Studio UI", filters: "View the activation's filters and rules", schema: "View the attribute schema and field paths (with API names)", audit: "View audit info and metadata (created/modified, IDs)" };
    tabs.forEach(function(t, i) {
      var tb = document.createElement("div");
      tb.setAttribute("data-actab", t[0]);
      tb.textContent = t[1];
      tb.title = tabTips[t[0]] || ("Show " + t[1]);
      tb.style.cssText = "padding:12px 20px;cursor:pointer;font:600 12px system-ui;color:" + (i === 0 ? "#667eea" : "#6b7280") + ";border-bottom:3px solid " + (i === 0 ? "#667eea" : "transparent") + ";transition:all .15s;";
      tabBar.appendChild(tb);
    });

    // Content
    var contentWrap = document.createElement("div");
    contentWrap.style.cssText = "flex:1;overflow-y:auto;padding:20px;";
    contentWrap.innerHTML = tab1;

    // Tab switching via event delegation
    var tabContents = { studio: tab1, filters: tab2, schema: tab3, audit: tab4 };
    tabBar.addEventListener("click", function(e) {
      var t = e.target; if (!t.getAttribute("data-actab")) return;
      var key = t.getAttribute("data-actab");
      tabBar.querySelectorAll("[data-actab]").forEach(function(tb) { tb.style.color = "#6b7280"; tb.style.borderBottomColor = "transparent"; });
      t.style.color = "#667eea"; t.style.borderBottomColor = "#667eea";
      contentWrap.innerHTML = tabContents[key] || "";
    });

    // Draggable
    var isDragging = false, dragX = 0, dragY = 0;
    hdr.addEventListener("mousedown", function(e) { if (e.target === closeX || e.target === dlHtmlBtn) return; isDragging = true; dragX = e.clientX - box.offsetLeft; dragY = e.clientY - box.offsetTop; hdr.style.cursor = "grabbing"; box.style.position = "absolute"; box.style.margin = "0"; });
    document.addEventListener("mousemove", function(e) { if (!isDragging) return; box.style.left = (e.clientX - dragX) + "px"; box.style.top = (e.clientY - dragY) + "px"; });
    document.addEventListener("mouseup", function() { isDragging = false; hdr.style.cursor = "grab"; });

    box.appendChild(hdr);
    box.appendChild(tabBar);
    box.appendChild(contentWrap);
    modal.appendChild(box);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }

  // Create the activation launcher button (extension-only)
  function ensureActivationLauncher() {
    // Extension-only feature
    if (!extBridgePresent()) return;
    if (document.getElementById("dc-activation-bar")) return;

    var wrap = document.createElement("div");
    wrap.id = "dc-activation-bar";
    wrap.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:2147483646;";

    var btn = document.createElement("button");
    btn.textContent = "📋 Export Activation";
    btn.title = "Export this activation's target, attributes and field mappings (with API names) to HTML / Sheets so you can review or share the configuration.";
    btn.style.cssText = "border:none;border-radius:20px;padding:10px 18px;cursor:pointer;font:600 12px -apple-system,sans-serif;color:#fff;background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 3px 12px rgba(16,185,129,.3);transition:transform .1s,box-shadow .1s;";
    btn.onmouseenter = function () {
      btn.style.transform = "scale(1.03)";
      btn.style.boxShadow = "0 4px 16px rgba(16,185,129,.4)";
    };
    btn.onmouseleave = function () {
      btn.style.transform = "scale(1)";
      btn.style.boxShadow = "0 3px 12px rgba(16,185,129,.3)";
    };

    var note = document.createElement("div");
    note.style.cssText = "margin-top:8px;font-size:11px;color:#dc2626;background:#fff;border:1px solid #fecaca;border-radius:6px;padding:6px 10px;display:none;max-width:280px;box-shadow:0 2px 8px rgba(0,0,0,.1);";

    btn.onclick = function () {
      var activationId = getActivationIdFromUrl();
      if (!activationId) {
        note.textContent = "Couldn't find the activation ID in the URL.";
        note.style.display = "block";
        return;
      }

      btn.disabled = true;
      btn.textContent = "Reading…";
      note.style.display = "none";

      fetchActivationViaBridge(activationId).then(function (data) {
        btn.disabled = false;
        btn.textContent = "📋 Export Activation";
        showActivationModal(data);
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = "📋 Export Activation";
        note.textContent = String(err && err.message || err);
        note.style.display = "block";
      });
    };

    wrap.appendChild(btn);
    wrap.appendChild(note);
    document.body.appendChild(wrap);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ERD Diagram feature for Data Model page
  // ═══════════════════════════════════════════════════════════════════════════════

  var _dataModelCache = { graphData: null, dataModels: null };

  function isDataModelPage() {
    // Only match the Data Model GRAPH view page
    return /standard-DataModel/i.test(window.location.href) && /displayType=graph|c__displayType=graph/i.test(window.location.href) && !/\/r\/DataModelObject\//i.test(window.location.href);
  }

  function ensureDataModelLauncher() {
    if (document.getElementById("dc-erd-bar")) return;

    // Install XHR interceptor to capture Data Model responses
    try {
      var originalXHRSend = XMLHttpRequest.prototype.send;
      var originalXHROpen = XMLHttpRequest.prototype.open;

      XMLHttpRequest.prototype.open = function(method, url) {
        this.__derdUrl = url;
        return originalXHROpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        var xhr = this;
        xhr._dcBody = body;
        var originalOnLoad = xhr.onload;

        xhr.addEventListener("load", function() {
          try {
            var url = xhr.__derdUrl || "";
            if (/DataModeling\.getDataModelGraph/i.test(url)) {
              try {
                var resp = JSON.parse(xhr.responseText);
                if (resp && resp.actions && resp.actions[0] && resp.actions[0].returnValue) {
                  _dataModelCache.graphData = resp.actions[0].returnValue.data;
                  // Capture dataspace from the Aura action params in the request body
                  try {
                    var bodyStr = String(xhr._dcBody || "");
                    var decodedBody = decodeURIComponent(bodyStr.replace(/\+/g, " "));
                    var dsMatch = decodedBody.match(/"dataSpaceName"\s*:\s*"([^"]+)"/i) || decodedBody.match(/"dataspace"\s*:\s*"([^"]+)"/i);
                    if (dsMatch) _dataModelCache.capturedDataspace = dsMatch[1];
                  } catch(e2) {}
                }
              } catch (e) {}
            } else if (/DataModeling\.getDataModels/i.test(url)) {
              try {
                var resp = JSON.parse(xhr.responseText);
                if (resp && resp.actions && resp.actions[0] && resp.actions[0].returnValue) {
                  _dataModelCache.dataModels = resp.actions[0].returnValue;
                }
              } catch (e) {}
            }
          } catch (e) {}
        });

        return originalXHRSend.apply(this, arguments);
      };
    } catch (e) {
    }

    // Create launcher button
    var wrap = document.createElement("div");
    wrap.id = "dc-erd-bar";
    wrap.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:2147483646;";

    var btn = document.createElement("button");
    btn.textContent = "📊 ERD Diagram";
    btn.title = "Build an entity-relationship diagram of the Data Model — DMOs and how they relate — from the graph on this page. Downloadable as HTML.";
    btn.style.cssText = "border:none;border-radius:20px;padding:10px 18px;cursor:pointer;font:600 12px -apple-system,sans-serif;color:#fff;background:linear-gradient(135deg,#8b5cf6,#7c3aed);box-shadow:0 3px 12px rgba(139,92,246,.3);transition:transform .1s,box-shadow .1s;";
    btn.onmouseenter = function() { btn.style.transform = "scale(1.03)"; btn.style.boxShadow = "0 4px 16px rgba(139,92,246,.4)"; };
    btn.onmouseleave = function() { btn.style.transform = "scale(1)"; btn.style.boxShadow = "0 3px 12px rgba(139,92,246,.3)"; };
    btn.onclick = function() { showERDModal(); };

    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  // System fields to hide (not useful for architecture diagrams)
  var _systemFields = ["DataSource__c","DataSourceObject__c","DataSourceId__c","DataSourceObjectId__c","InternalOrganization__c","InternalOrganizationId__c","ssot__DataSourceId__c","ssot__DataSourceObjectId__c","ssot__InternalOrganizationId__c","cdp_sys_SourceVersion__c"];

  function parseEdgesFromDOT(dotString) {
    var edges = [];
    var edgeRegex = /(\d+)\s*->\s*(\d+)\s*(?:\[\s*label="([^"]*)"\s*\])?/g;
    var m;
    while ((m = edgeRegex.exec(dotString)) !== null) {
      edges.push({ from: m[1], to: m[2], label: m[3] || "" });
    }
    return edges;
  }

  // Node attributes come back with dataType=null in some orgs, but the graph's EDGES
  // carry populated sourceAttributeKey/targetAttributeKey blobs that DO include
  // dataType/businessType/dataRequired for the relationship fields. Build a lookup
  // keyed by "<entityDeveloperName>::<fieldDeveloperName>" so nodes can borrow it.
  function buildEdgeAttrTypeMap(dotString) {
    var map = {};
    if (!dotString) return map;
    var keyRegex = /(?:source|target)AttributeKey="((?:[^"\\]|\\.)*)"/g;
    var m;
    while ((m = keyRegex.exec(dotString)) !== null) {
      try {
        var obj = JSON.parse(m[1].replace(/\\"/g, '"').replace(/\\n/g, '').replace(/\\\\/g, '\\'));
        var ent = obj && obj.entityDeveloperName;
        var fld = obj && obj.developerName;
        if (!ent || !fld) continue;
        var dt = obj.dataType || obj.businessType || "";
        if (!dt && obj.dataRequired == null) continue;
        var k = ent + "::" + fld;
        if (!map[k]) map[k] = { dataType: dt, dataRequired: !!obj.dataRequired };
        else if (!map[k].dataType && dt) map[k].dataType = dt;
      } catch (e) {}
    }
    return map;
  }

  // Verify if a relationship between two entities is real based on KQ fields
  // Returns: { verified: boolean, fkField: string, fkSide: "from"|"to", cardinality: string } or null
  function verifyRelationship(fromEnt, toEnt) {
    if (!fromEnt || !toEnt || fromEnt.masterLabel === toEnt.masterLabel) return null;

    // Get non-Id KQ fields from both sides (these are potential FKs)
    var fromFKs = fromEnt.attributes.filter(function(a) {
      return a.isForeignKey;
    });
    var toFKs = toEnt.attributes.filter(function(a) {
      return a.isForeignKey;
    });

    // Get all identifiers from both entities (for matching)
    var fromIdentifiers = fromEnt.attributes.filter(function(a) { return a.isPrimaryKey; }).map(function(a) {
      return a.developerName.replace(/^KQ_/, "").replace(/__c$/, "");
    });
    var toIdentifiers = toEnt.attributes.filter(function(a) { return a.isPrimaryKey; }).map(function(a) {
      return a.developerName.replace(/^KQ_/, "").replace(/__c$/, "");
    });

    // Check if FROM has a KQ field that matches TO's identifier
    for (var i = 0; i < fromFKs.length; i++) {
      var fkName = fromFKs[i].developerName.replace(/^KQ_/, "").replace(/__c$/, "");
      // Check if this FK field name matches any of TO's identifiers
      for (var j = 0; j < toIdentifiers.length; j++) {
        if (fkName.toLowerCase() === toIdentifiers[j].toLowerCase() ||
            toIdentifiers[j].toLowerCase().indexOf(fkName.toLowerCase()) >= 0 ||
            fkName.toLowerCase().indexOf(toIdentifiers[j].toLowerCase()) >= 0) {
          // FROM has FK to TO → FROM is "many" side
          var card;
          if (/Latest|_SM_/i.test(fromEnt.masterLabel) || /Latest|_SM_/i.test(toEnt.masterLabel)) {
            card = "||--||";
          } else if (/Unified.*Link|Link/i.test(fromEnt.masterLabel) || /Unified.*Link|Link/i.test(toEnt.masterLabel)) {
            card = "}o--o{";
          } else {
            card = "}o--||"; // Many FROM to One TO
          }
          return { verified: true, fkField: fkName, kqField: fromFKs[i].developerName, fkSide: "from", cardinality: card };
        }
      }
    }

    // Check if TO has a KQ field that matches FROM's identifier
    for (var k = 0; k < toFKs.length; k++) {
      var fkName2 = toFKs[k].developerName.replace(/^KQ_/, "").replace(/__c$/, "");
      for (var l = 0; l < fromIdentifiers.length; l++) {
        if (fkName2.toLowerCase() === fromIdentifiers[l].toLowerCase() ||
            fromIdentifiers[l].toLowerCase().indexOf(fkName2.toLowerCase()) >= 0 ||
            fkName2.toLowerCase().indexOf(fromIdentifiers[l].toLowerCase()) >= 0) {
          // TO has FK to FROM → TO is "many" side
          var card2;
          if (/Latest|_SM_/i.test(fromEnt.masterLabel) || /Latest|_SM_/i.test(toEnt.masterLabel)) {
            card2 = "||--||";
          } else if (/Unified.*Link|Link/i.test(fromEnt.masterLabel) || /Unified.*Link|Link/i.test(toEnt.masterLabel)) {
            card2 = "}o--o{";
          } else {
            card2 = "||--o{"; // One FROM to Many TO
          }
          return { verified: true, fkField: fkName2, kqField: toFKs[k].developerName, fkSide: "to", cardinality: card2 };
        }
      }
    }

    return null; // No verified relationship found
  }

  function generateMermaidERD(entities, relationships) {
    var lines = ["erDiagram"];
    var cleanName = function(n) { return n.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, ""); };

    // Build entity lookup by label
    var entityByLabel = {};
    entities.forEach(function(ent) { entityByLabel[ent.masterLabel] = ent; });

    // Deduplicate relationships
    var seen = {};
    var dedupedRels = [];
    relationships.forEach(function(rel) {
      var key = [rel.from, rel.to].sort().join("|||");
      if (seen[key]) return;
      seen[key] = true;
      dedupedRels.push(rel);
    });

    // Use DOT graph edges directly (source of truth from SF's own graph view)
    dedupedRels.forEach(function(rel) {
      var fromEnt = entityByLabel[rel.from];
      var toEnt = entityByLabel[rel.to];
      if (!fromEnt || !toEnt || rel.from === rel.to) return;

      var fromClean = cleanName(rel.from);
      var toClean = cleanName(rel.to);

      // Try to find FK field from KQ fields
      var fkField = "FK";
      var cardinality = "||--o{";
      var verified = verifyRelationship(fromEnt, toEnt);
      if (verified && verified.verified) {
        fkField = verified.fkField;
        cardinality = verified.cardinality;
      } else {
        // Fallback: use first non-Id KQ from either side as label
        var fromFKs = fromEnt.attributes.filter(function(a) { return a.isForeignKey; });
        var toFKs = toEnt.attributes.filter(function(a) { return a.isForeignKey; });
        if (fromFKs.length > 0) { fkField = fromFKs[0].developerName.replace(/^KQ_/, "").replace(/__c$/, ""); cardinality = "}o--||"; }
        else if (toFKs.length > 0) { fkField = toFKs[0].developerName.replace(/^KQ_/, "").replace(/__c$/, ""); cardinality = "||--o{"; }
        if (/Latest|_SM_/i.test(rel.from) || /Latest|_SM_/i.test(rel.to)) cardinality = "||--||";
        if (/Link/i.test(rel.from) || /Link/i.test(rel.to)) cardinality = "}o--o{";
      }
      lines.push("    " + fromClean + " " + cardinality + " " + toClean + " : \"" + fkField + "\"");
    });

    // Add entity definitions with key fields
    entities.forEach(function(entity) {
      var name = cleanName(entity.masterLabel);
      var pks = entity.attributes.filter(function(a) { return a.isPrimaryKey; });
      var fks = entity.attributes.filter(function(a) { return a.isForeignKey; });
      var bizFields = entity.attributes.filter(function(a) { return !a.isPrimaryKey && !a.isForeignKey && _systemFields.indexOf(a.developerName) < 0; }).slice(0, 5);
      if (pks.length > 0 || fks.length > 0 || bizFields.length > 0) {
        lines.push("    " + name + " {");
        pks.forEach(function(pk) { lines.push("        string " + cleanName(pk.developerName) + " PK"); });
        fks.forEach(function(fk) { lines.push("        string " + cleanName(fk.developerName) + " FK"); });
        bizFields.forEach(function(f) { lines.push("        " + (f.dataType || "string").toLowerCase() + " " + cleanName(f.developerName)); });
        lines.push("    }");
      }
    });
    return lines.join("\n");
  }

  function showDMOSelector(allEntities, allRelationships, sourceMap, bodyContainer, titleElement) {
    // Create overlay with checkbox list
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:10;";

    var panel = document.createElement("div");
    panel.style.cssText = "background:#fff;border-radius:12px;width:600px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.5);";

    var panelHeader = document.createElement("div");
    panelHeader.style.cssText = "padding:16px 20px;border-bottom:2px solid #e2e8f0;background:#f8f9fa;display:flex;justify-content:space-between;align-items:center;";
    var panelTitle = document.createElement("div");
    panelTitle.textContent = "Select DMOs to Include in ERD";
    panelTitle.style.cssText = "font:700 15px -apple-system,sans-serif;color:#1e293b;";
    var panelClose = document.createElement("button");
    panelClose.textContent = "×";
    panelClose.title = "Close this DMO selector";
    panelClose.style.cssText = "border:none;background:none;cursor:pointer;font-size:24px;color:#64748b;padding:0;";
    panelClose.onclick = function() { overlay.remove(); };
    panelHeader.appendChild(panelTitle);
    panelHeader.appendChild(panelClose);

    var controls = document.createElement("div");
    controls.style.cssText = "padding:12px 20px;border-bottom:1px solid #e2e8f0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
    var searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search DMOs...";
    searchInput.title = "Type to filter the DMO list below by name";
    searchInput.style.cssText = "flex:1;min-width:180px;padding:7px 12px;border:1px solid #d1d5db;border-radius:6px;font:13px -apple-system,sans-serif;outline:none;";
    searchInput.addEventListener("input", function() {
      var q = searchInput.value.toLowerCase();
      var items = listWrap.querySelectorAll("[data-dmo-item]");
      items.forEach(function(item) {
        var name = item.getAttribute("data-dmo-item").toLowerCase();
        item.style.display = (!q || name.indexOf(q) >= 0) ? "flex" : "none";
      });
    });
    var selectAllBtn = document.createElement("button");
    selectAllBtn.textContent = "Select All";
    selectAllBtn.style.cssText = "border:1px solid #3b82f6;background:#3b82f6;color:#fff;border-radius:4px;padding:6px 12px;cursor:pointer;font:600 11px system-ui;white-space:nowrap;";
    selectAllBtn.title = "Check all entities";
    var deselectAllBtn = document.createElement("button");
    deselectAllBtn.textContent = "Deselect All";
    deselectAllBtn.style.cssText = "border:1px solid #94a3b8;background:#fff;color:#475569;border-radius:4px;padding:6px 12px;cursor:pointer;font:600 11px system-ui;white-space:nowrap;";
    deselectAllBtn.title = "Uncheck all entities";
    controls.appendChild(searchInput);
    controls.appendChild(selectAllBtn);
    controls.appendChild(deselectAllBtn);

    // Smart presets section
    var presetsWrap = document.createElement("div");
    presetsWrap.style.cssText = "padding:10px 20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;";
    var presetsLabel = document.createElement("div");
    presetsLabel.textContent = "Smart Presets";
    presetsLabel.style.cssText = "font:600 10px system-ui;color:#64748b;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.5px;";
    var presetsRow = document.createElement("div");
    presetsRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

    var createPresetBtn = function(label, color, onClick) {
      var btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = "border:1px solid " + color + ";background:#fff;color:" + color + ";border-radius:4px;padding:4px 10px;cursor:pointer;font:600 10px system-ui;white-space:nowrap;transition:all .15s;";
      btn.onmouseenter = function() { btn.style.background = color; btn.style.color = "#fff"; };
      btn.onmouseleave = function() { btn.style.background = "#fff"; btn.style.color = color; };
      btn.onclick = onClick;
      return btn;
    };

    // Build relationship graph for hop selector
    var relGraph = {};
    allRelationships.forEach(function(rel) {
      if (!relGraph[rel.from]) relGraph[rel.from] = [];
      if (!relGraph[rel.to]) relGraph[rel.to] = [];
      relGraph[rel.from].push(rel.to);
      relGraph[rel.to].push(rel.from);
    });

    var updateCheckboxes = function() {
      var checkboxes = listWrap.querySelectorAll("input[type=checkbox]");
      checkboxes.forEach(function(cb, idx) {
        var ent = allEntities[idx];
        if (ent) {
          cb.checked = selectedSet[ent.developerName] || false;
        }
      });
    };

    // Preset: Profile only
    var profileBtn = createPresetBtn("Profile only", "#10b981", function() {
      selectedSet = {};
      allEntities.forEach(function(ent) {
        if (ent.category === "PROFILE") selectedSet[ent.developerName] = true;
      });
      updateCheckboxes();
    });
    profileBtn.title = "Select only Profile category entities (Individual, Contact Points)";

    // Preset: Engagement only
    var engagementBtn = createPresetBtn("Engagement only", "#f59e0b", function() {
      selectedSet = {};
      allEntities.forEach(function(ent) {
        if (ent.category === "ENGAGEMENT") selectedSet[ent.developerName] = true;
      });
      updateCheckboxes();
    });
    engagementBtn.title = "Select only Engagement category entities (Sales Order, Insurance)";

    // Preset: Individual + connections
    var individualBtn = createPresetBtn("Individual + connections", "#8b5cf6", function() {
      selectedSet = {};
      var individualEnt = allEntities.find(function(e) { return e.masterLabel === "Individual"; });
      if (individualEnt) {
        selectedSet[individualEnt.developerName] = true;
        var connected = relGraph[individualEnt.masterLabel] || [];
        connected.forEach(function(connLabel) {
          var connEnt = allEntities.find(function(e) { return e.masterLabel === connLabel; });
          if (connEnt) selectedSet[connEnt.developerName] = true;
        });
      }
      updateCheckboxes();
    });
    individualBtn.title = "Select Individual and all entities directly connected to it";

    // Preset: Exclude Unified/Latest
    var excludeBtn = createPresetBtn("Exclude Unified/Latest", "#6366f1", function() {
      selectedSet = {};
      allEntities.forEach(function(ent) {
        if (!/Unified|Latest/i.test(ent.masterLabel)) {
          selectedSet[ent.developerName] = true;
        }
      });
      updateCheckboxes();
    });
    excludeBtn.title = "Select all except Unified and Latest snapshot entities (reduces clutter)";

    presetsRow.appendChild(profileBtn);
    presetsRow.appendChild(engagementBtn);
    presetsRow.appendChild(individualBtn);
    presetsRow.appendChild(excludeBtn);
    presetsWrap.appendChild(presetsLabel);
    presetsWrap.appendChild(presetsRow);

    // Hop selector section
    var hopWrap = document.createElement("div");
    hopWrap.style.cssText = "padding:10px 20px;border-bottom:1px solid #e2e8f0;background:#fffbeb;";
    var hopLabel = document.createElement("div");
    hopLabel.textContent = "Quick Focus";
    hopLabel.style.cssText = "font:600 10px system-ui;color:#92400e;text-transform:uppercase;margin-bottom:6px;letter-spacing:0.5px;";
    var hopRow = document.createElement("div");
    hopRow.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";

    var hopLabelText = document.createElement("span");
    hopLabelText.textContent = "Focus on:";
    hopLabelText.style.cssText = "font:500 11px system-ui;color:#78716c;";

    var centerSelect = document.createElement("select");
    centerSelect.style.cssText = "padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;font:12px -apple-system,sans-serif;outline:none;cursor:pointer;";
    centerSelect.title = "Pick a center entity to focus the diagram around";
    var defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "— Choose entity —";
    centerSelect.appendChild(defaultOpt);
    allEntities.forEach(function(ent) {
      var opt = document.createElement("option");
      opt.value = ent.masterLabel;
      opt.textContent = ent.masterLabel + " (" + ent.category + ")";
      centerSelect.appendChild(opt);
    });

    var withinText = document.createElement("span");
    withinText.textContent = "within";
    withinText.style.cssText = "font:500 11px system-ui;color:#78716c;";

    var hop1Btn = document.createElement("button");
    hop1Btn.textContent = "1 hop";
    hop1Btn.style.cssText = "border:1px solid #f59e0b;background:#fff;color:#f59e0b;border-radius:4px;padding:4px 12px;cursor:pointer;font:600 10px system-ui;transition:all .15s;";
    hop1Btn.title = "Show only entities directly connected to the center entity";
    hop1Btn.onmouseenter = function() { hop1Btn.style.background = "#f59e0b"; hop1Btn.style.color = "#fff"; };
    hop1Btn.onmouseleave = function() { hop1Btn.style.background = "#fff"; hop1Btn.style.color = "#f59e0b"; };

    var hop2Btn = document.createElement("button");
    hop2Btn.textContent = "2 hops";
    hop2Btn.style.cssText = "border:1px solid #f59e0b;background:#fff;color:#f59e0b;border-radius:4px;padding:4px 12px;cursor:pointer;font:600 10px system-ui;transition:all .15s;";
    hop2Btn.title = "Show entities within 2 connections of the center entity";
    hop2Btn.onmouseenter = function() { hop2Btn.style.background = "#f59e0b"; hop2Btn.style.color = "#fff"; };
    hop2Btn.onmouseleave = function() { hop2Btn.style.background = "#fff"; hop2Btn.style.color = "#f59e0b"; };

    var performHopSelection = function(hops) {
      var centerLabel = centerSelect.value;
      if (!centerLabel) {
        alert("Please select a center entity first");
        return;
      }

      selectedSet = {};
      var visited = {};
      var queue = [{ label: centerLabel, depth: 0 }];
      visited[centerLabel] = true;

      while (queue.length > 0) {
        var current = queue.shift();
        var ent = allEntities.find(function(e) { return e.masterLabel === current.label; });
        if (ent) selectedSet[ent.developerName] = true;

        if (current.depth < hops) {
          var neighbors = relGraph[current.label] || [];
          neighbors.forEach(function(neighborLabel) {
            if (!visited[neighborLabel]) {
              visited[neighborLabel] = true;
              queue.push({ label: neighborLabel, depth: current.depth + 1 });
            }
          });
        }
      }

      updateCheckboxes();
    };

    hop1Btn.onclick = function() { performHopSelection(1); };
    hop2Btn.onclick = function() { performHopSelection(2); };

    hopRow.appendChild(hopLabelText);
    hopRow.appendChild(centerSelect);
    hopRow.appendChild(withinText);
    hopRow.appendChild(hop1Btn);
    hopRow.appendChild(hop2Btn);
    hopWrap.appendChild(hopLabel);
    hopWrap.appendChild(hopRow);

    var listWrap = document.createElement("div");
    listWrap.style.cssText = "flex:1;overflow:auto;padding:16px 20px;";

    var selectedSet = {};
    allEntities.forEach(function(ent) { selectedSet[ent.developerName] = true; });

    allEntities.forEach(function(ent) {
      var item = document.createElement("label");
      item.setAttribute("data-dmo-item", ent.masterLabel + " " + ent.developerName + " " + ent.category);
      item.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;transition:background .1s;";
      item.onmouseenter = function() { item.style.background = "#f8fafc"; };
      item.onmouseleave = function() { item.style.background = "transparent"; };

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.style.cssText = "width:18px;height:18px;cursor:pointer;";
      checkbox.onchange = function() {
        if (checkbox.checked) {
          selectedSet[ent.developerName] = true;
        } else {
          delete selectedSet[ent.developerName];
        }
      };

      var labelText = document.createElement("div");
      labelText.style.cssText = "flex:1;";
      var mainLabel = document.createElement("div");
      mainLabel.textContent = ent.masterLabel;
      mainLabel.style.cssText = "font:600 13px -apple-system,sans-serif;color:#1e293b;";
      var apiLabel = document.createElement("div");
      apiLabel.textContent = ent.developerName;
      apiLabel.style.cssText = "font:500 11px SF Mono,Consolas,monospace;color:#64748b;";
      labelText.appendChild(mainLabel);
      labelText.appendChild(apiLabel);

      var categoryBadge = document.createElement("span");
      categoryBadge.textContent = ent.category;
      categoryBadge.style.cssText = "font:600 9px system-ui;text-transform:uppercase;padding:3px 8px;border-radius:4px;background:" + (ent.category === "PROFILE" ? "#d1fae5" : ent.category === "ENGAGEMENT" ? "#fed7aa" : "#e5e7eb") + ";color:" + (ent.category === "PROFILE" ? "#065f46" : ent.category === "ENGAGEMENT" ? "#92400e" : "#374151") + ";";

      item.appendChild(checkbox);
      item.appendChild(labelText);
      item.appendChild(categoryBadge);
      listWrap.appendChild(item);
    });

    selectAllBtn.onclick = function() {
      listWrap.querySelectorAll("input[type=checkbox]").forEach(function(cb) {
        cb.checked = true;
        var devName = allEntities[Array.from(listWrap.children).indexOf(cb.parentElement)].developerName;
        selectedSet[devName] = true;
      });
    };

    deselectAllBtn.onclick = function() {
      listWrap.querySelectorAll("input[type=checkbox]").forEach(function(cb) {
        cb.checked = false;
      });
      selectedSet = {};
    };

    var footer = document.createElement("div");
    footer.style.cssText = "padding:14px 20px;border-top:2px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px;background:#f8f9fa;";
    var cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.title = "Close without changing the diagram";
    cancelBtn.style.cssText = "border:1px solid #94a3b8;background:#fff;color:#475569;border-radius:6px;padding:8px 16px;cursor:pointer;font:600 11px system-ui;";
    cancelBtn.onclick = function() { overlay.remove(); };
    var applyBtn = document.createElement("button");
    applyBtn.textContent = "Generate ERD";
    applyBtn.style.cssText = "border:1px solid #8b5cf6;background:#8b5cf6;color:#fff;border-radius:6px;padding:8px 16px;cursor:pointer;font:600 11px system-ui;";
    applyBtn.title = "Generate the diagram with selected entities";
    applyBtn.onclick = function() {
      var selectedKeys = Object.keys(selectedSet);
      if (selectedKeys.length === 0) {
        alert("Please select at least one DMO.");
        return;
      }

      // Find related unselected DMOs using DOT graph edges (source of truth)
      var selectedLabels = {};
      allEntities.forEach(function(e) { if (selectedSet[e.developerName]) selectedLabels[e.masterLabel] = true; });
      var relatedUnselected = {};
      allRelationships.forEach(function(rel) {
        if (selectedLabels[rel.from] && !selectedLabels[rel.to]) {
          var ent = allEntities.find(function(e) { return e.masterLabel === rel.to; });
          if (ent) relatedUnselected[ent.developerName] = ent;
        }
        if (selectedLabels[rel.to] && !selectedLabels[rel.from]) {
          var ent2 = allEntities.find(function(e) { return e.masterLabel === rel.from; });
          if (ent2) relatedUnselected[ent2.developerName] = ent2;
        }
      });

      var relatedList = Object.keys(relatedUnselected);
      if (relatedList.length > 0) {
        // Show suggestion dialog with CHECKBOXES
        var suggestOverlay = document.createElement("div");
        suggestOverlay.style.cssText = "position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:11;";

        var suggestPanel = document.createElement("div");
        suggestPanel.style.cssText = "background:#fff;border-radius:10px;padding:20px;max-width:550px;width:90%;max-height:70vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3);";

        var suggestTitle = document.createElement("div");
        suggestTitle.textContent = "Related DMOs Found";
        suggestTitle.style.cssText = "font:700 15px -apple-system,sans-serif;color:#1e293b;margin-bottom:6px;";

        var suggestMsg = document.createElement("div");
        suggestMsg.textContent = "Your selected DMOs have connections to " + relatedList.length + " other DMO" + (relatedList.length > 1 ? "s" : "") + ". Select which ones to include:";
        suggestMsg.style.cssText = "font:13px -apple-system,sans-serif;color:#475569;margin-bottom:12px;";

        // Select All / Deselect All
        var suggestControls = document.createElement("div");
        suggestControls.style.cssText = "display:flex;gap:8px;margin-bottom:8px;";
        var selAllSuggest = document.createElement("button");
        selAllSuggest.textContent = "Select All";
        selAllSuggest.title = "Select all suggested related entities";
        selAllSuggest.style.cssText = "border:1px solid #3b82f6;background:#3b82f6;color:#fff;border-radius:4px;padding:4px 10px;cursor:pointer;font:600 10px system-ui;";
        var deselAllSuggest = document.createElement("button");
        deselAllSuggest.textContent = "Deselect All";
        deselAllSuggest.title = "Clear the suggested-entity selection";
        deselAllSuggest.style.cssText = "border:1px solid #94a3b8;background:#fff;color:#475569;border-radius:4px;padding:4px 10px;cursor:pointer;font:600 10px system-ui;";
        suggestControls.appendChild(selAllSuggest);
        suggestControls.appendChild(deselAllSuggest);

        var suggestListDiv = document.createElement("div");
        suggestListDiv.style.cssText = "flex:1;overflow:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;margin-bottom:16px;";
        var suggestChecks = [];
        relatedList.forEach(function(devName) {
          var ent = relatedUnselected[devName];
          var item = document.createElement("label");
          item.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font:12px -apple-system,sans-serif;border-bottom:1px solid #f1f5f9;";
          var cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = true;
          cb.style.cssText = "width:16px;height:16px;cursor:pointer;";
          suggestChecks.push({ cb: cb, devName: devName });
          var label = document.createElement("span");
          label.textContent = ent.masterLabel + " (" + ent.developerName.replace(/__dlm$/,"") + ")";
          label.style.cssText = "color:#1e293b;";
          item.appendChild(cb); item.appendChild(label);
          suggestListDiv.appendChild(item);
        });

        selAllSuggest.onclick = function() { suggestChecks.forEach(function(sc) { sc.cb.checked = true; }); };
        deselAllSuggest.onclick = function() { suggestChecks.forEach(function(sc) { sc.cb.checked = false; }); };

        var suggestFooter = document.createElement("div");
        suggestFooter.style.cssText = "display:flex;justify-content:flex-end;gap:10px;";

        var skipBtn = document.createElement("button");
        skipBtn.textContent = "Skip — use my selection only";
        skipBtn.title = "Generate the diagram with only the entities you picked, ignoring the suggestions";
        skipBtn.style.cssText = "border:1px solid #94a3b8;background:#fff;color:#475569;border-radius:6px;padding:7px 14px;cursor:pointer;font:600 11px system-ui;";
        skipBtn.onclick = function() {
          suggestOverlay.remove();
          var filteredEntities = allEntities.filter(function(e) { return selectedSet[e.developerName]; });
          var filteredRelationships = allRelationships.filter(function(r) {
            var fromEnt = allEntities.find(function(e) { return e.masterLabel === r.from; });
            var toEnt = allEntities.find(function(e) { return e.masterLabel === r.to; });
            return fromEnt && toEnt && selectedSet[fromEnt.developerName] && selectedSet[toEnt.developerName];
          });
          bodyContainer.innerHTML = renderERDCards(filteredEntities, filteredRelationships, sourceMap);
          titleElement.textContent = "Data Model ERD — " + filteredEntities.length + " entities, " + filteredRelationships.length + " relationships (filtered)";
          overlay.remove();
        };

        var addBtn = document.createElement("button");
        addBtn.textContent = "Add Selected & Generate";
        addBtn.title = "Add the checked suggested entities to your selection and generate the diagram";
        addBtn.style.cssText = "border:1px solid #8b5cf6;background:#8b5cf6;color:#fff;border-radius:6px;padding:7px 14px;cursor:pointer;font:600 11px system-ui;";
        addBtn.onclick = function() {
          // Add only CHECKED related DMOs
          suggestChecks.forEach(function(sc) { if (sc.cb.checked) selectedSet[sc.devName] = true; });
          suggestOverlay.remove();
          var allCheckboxes = listWrap.querySelectorAll("input[type=checkbox]");
          allCheckboxes.forEach(function(cb2, idx) {
            var ent = allEntities[idx];
            if (ent && selectedSet[ent.developerName]) cb2.checked = true;
          });
          var filteredEntities = allEntities.filter(function(e) { return selectedSet[e.developerName]; });
          var filteredRelationships = allRelationships.filter(function(r) {
            var fromEnt = allEntities.find(function(e) { return e.masterLabel === r.from; });
            var toEnt = allEntities.find(function(e) { return e.masterLabel === r.to; });
            return fromEnt && toEnt && selectedSet[fromEnt.developerName] && selectedSet[toEnt.developerName];
          });
          bodyContainer.innerHTML = renderERDCards(filteredEntities, filteredRelationships, sourceMap);
          titleElement.textContent = "Data Model ERD — " + filteredEntities.length + " entities, " + filteredRelationships.length + " relationships (filtered)";
          overlay.remove();
        };

        suggestFooter.appendChild(skipBtn);
        suggestFooter.appendChild(addBtn);

        suggestPanel.appendChild(suggestTitle);
        suggestPanel.appendChild(suggestMsg);
        suggestPanel.appendChild(suggestListDiv);
        suggestPanel.appendChild(suggestFooter);
        suggestOverlay.appendChild(suggestPanel);
        panel.appendChild(suggestOverlay);
      } else {
        // No related DMOs, proceed directly
        var filteredEntities = allEntities.filter(function(e) { return selectedSet[e.developerName]; });
        var filteredRelationships = allRelationships.filter(function(r) {
          var fromEnt = allEntities.find(function(e) { return e.masterLabel === r.from; });
          var toEnt = allEntities.find(function(e) { return e.masterLabel === r.to; });
          return fromEnt && toEnt && selectedSet[fromEnt.developerName] && selectedSet[toEnt.developerName];
        });
        bodyContainer.innerHTML = renderERDCards(filteredEntities, filteredRelationships, sourceMap);
        titleElement.textContent = "Data Model ERD — " + filteredEntities.length + " entities, " + filteredRelationships.length + " relationships (filtered)";
        overlay.remove();
      }
    };
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);

    panel.appendChild(panelHeader);
    panel.appendChild(controls);
    panel.appendChild(presetsWrap);
    panel.appendChild(hopWrap);
    panel.appendChild(listWrap);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    bodyContainer.parentElement.appendChild(overlay);
    try { installErdTooltips(overlay); } catch (e) {}

    overlay.addEventListener("click", function(e) {
      if (e.target === overlay) overlay.remove();
    });
  }

  // ERD / Data Model INSTANT tooltips — self-contained for this feature only.
  var _erdTipEl = null;
  function installErdTooltips(container) {
    if (!container || container.__erdTipWired) return;
    container.__erdTipWired = true;
    if (!_erdTipEl) {
      _erdTipEl = document.createElement("div");
      _erdTipEl.style.cssText = "position:fixed;display:none;z-index:2147483647;max-width:280px;background:#1e293b;color:#fff;font:500 11px/1.45 -apple-system,sans-serif;padding:7px 10px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none;";
      document.body.appendChild(_erdTipEl);
    }
    var show = function (el) {
      var tip = el.getAttribute("data-tip") || el.getAttribute("title"); if (!tip) return;
      if (el.hasAttribute("title")) { el.setAttribute("data-tip", tip); el.removeAttribute("title"); }
      _erdTipEl.textContent = tip; _erdTipEl.style.display = "block";
      var r = el.getBoundingClientRect(); var top = r.top - _erdTipEl.offsetHeight - 8; if (top < 6) top = r.bottom + 8;
      var left = Math.min(Math.max(6, r.left), window.innerWidth - _erdTipEl.offsetWidth - 6);
      _erdTipEl.style.top = top + "px"; _erdTipEl.style.left = left + "px";
    };
    var hide = function () { if (_erdTipEl) _erdTipEl.style.display = "none"; };
    container.addEventListener("mouseover", function (e) { var el = e.target && e.target.closest ? e.target.closest("[title],[data-tip]") : null; if (!el || !container.contains(el)) return; var tag = (el.tagName || "").toLowerCase(); if (tag === "td" || tag === "th") return; if (tag !== "button" && tag !== "select" && tag !== "label" && tag !== "a" && !el.hasAttribute("data-tab")) return; show(el); }, true);
    container.addEventListener("mouseout", hide, true);
    container.addEventListener("click", hide, true);
  }

  function showERDModal() {
    if (!_dataModelCache.graphData) {
      // Simple: show a non-blocking message near the button. No auto-clicking.
      var existing = document.getElementById("dc-erd-msg");
      if (existing) existing.remove();
      var msg = document.createElement("div");
      msg.id = "dc-erd-msg";
      msg.style.cssText = "position:fixed;bottom:60px;left:20px;background:#fff;border:1px solid #f59e0b;color:#92400e;padding:14px 18px;border-radius:8px;font:13px/1.5 -apple-system,sans-serif;z-index:2147483646;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.15);";
      msg.innerHTML = "<b>No graph data yet</b><br>Switch to a different Data Space from the dropdown to load the graph. Then click ERD again.";
      document.body.appendChild(msg);
      setTimeout(function() { if (msg.parentElement) msg.remove(); }, 10000);
      return;
    }

    var entities = parseDOTGraph(_dataModelCache.graphData);
    if (!entities || entities.length === 0) {
      var msg3 = document.createElement("div"); msg3.style.cssText = "position:fixed;bottom:80px;left:20px;background:#fee2e2;border:1px solid #ef4444;color:#991b1b;padding:12px 16px;border-radius:8px;font:12px system-ui;z-index:2147483646;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,.15);"; msg3.textContent = "Failed to parse graph data. Try changing the Data Space dropdown or refreshing."; document.body.appendChild(msg3); setTimeout(function() { msg3.remove(); }, 8000);
      return;
    }

    // Parse edges (relationships between entities)
    var edges = parseEdgesFromDOT(_dataModelCache.graphData);
    var entityById = {};
    entities.forEach(function(e) { entityById[e.id] = e; });

    // Enrich with source lineage from getDataModels
    var sourceMap = {};
    if (_dataModelCache.dataModels && _dataModelCache.dataModels.dataModels) {
      _dataModelCache.dataModels.dataModels.forEach(function(dm) {
        sourceMap[dm.name] = {
          dataStream: (dm.dataStream || []).map(function(ds) { return ds.label; }),
          dataLakeObject: (dm.dataLakeObject || []).map(function(dlo) { return dlo.label; }),
          type: dm.type,
          category: dm.category
        };
      });
    }

    // Build relationships list
    var relationships = edges.map(function(edge) {
      var fromEntity = entityById[edge.from];
      var toEntity = entityById[edge.to];
      if (!fromEntity || !toEntity) return null;
      return { from: fromEntity.masterLabel, to: toEntity.masterLabel, label: edge.label, fromDev: fromEntity.developerName, toDev: toEntity.developerName };
    }).filter(Boolean);

    // Create modal
    var modal = document.createElement("div");
    modal.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;";

    var content = document.createElement("div");
    content.style.cssText = "width:95vw;height:95vh;background:#fff;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;";

    // Header
    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:2px solid #e2e8f0;background:linear-gradient(135deg,#f8f9fa,#e9ecef);flex-wrap:wrap;";

    var title = document.createElement("div");
    title.style.cssText = "flex:1;font:700 16px -apple-system,sans-serif;color:#1e293b;";
    // Dataspace priority: the LIVE dropdown selection wins (what the user currently has
    // chosen), THEN the value captured at XHR time, THEN cached data. Previously the
    // captured value won — so after the first load the label stayed stuck on that
    // dataspace (e.g. "TDI") even after switching the dropdown to "default".
    var dsName = "";
    (function findDs(root, depth) {
      if (depth > 8 || dsName) return;
      // Find the label "*Data Space" first, then find the combobox near it
      root.querySelectorAll("label, span").forEach(function(lbl) {
        if (dsName) return;
        if (/^\*?Data Space$/i.test((lbl.textContent || "").trim())) {
          var container = lbl.parentElement;
          for (var i = 0; i < 4 && container; i++) {
            var btn = container.querySelector("button.slds-combobox__input, button[class*='combobox__input']");
            if (btn) {
              var span = btn.querySelector("span.slds-truncate");
              var v = span ? span.textContent.trim() : btn.textContent.trim();
              if (v && !/^select\b/i.test(v)) dsName = v;   // ignore "Select an Option" placeholder
              break;
            }
            container = container.parentElement;
          }
        }
      });
      root.querySelectorAll("*").forEach(function(el) { if (el.shadowRoot && !dsName) findDs(el.shadowRoot, depth + 1); });
    })(document, 0);
    // Fall back to the value captured from the last getDataModelGraph request.
    if (!dsName) dsName = _dataModelCache.capturedDataspace || "";
    if (!dsName && _dataModelCache.dataModels && _dataModelCache.dataModels.dataModels && _dataModelCache.dataModels.dataModels[0]) {
      // Fallback to cached data — but use the most common dataspace, not the first
      var dsCounts = {};
      _dataModelCache.dataModels.dataModels.forEach(function(dm) { var ds = dm.dataSpaceName || "default"; dsCounts[ds] = (dsCounts[ds] || 0) + 1; });
      var maxDs = ""; var maxCount = 0;
      Object.keys(dsCounts).forEach(function(k) { if (dsCounts[k] > maxCount) { maxCount = dsCounts[k]; maxDs = k; } });
      dsName = maxDs;
    }
    if (!dsName && entities.length > 0 && entities[0].categoryId) {
      dsName = entities[0].dataSpaceName || "";
    }
    title.textContent = "Data Model ERD" + (dsName ? " | Dataspace: " + dsName : "") + " — " + entities.length + " entities, " + relationships.length + " relationships";

    var selectBtn = document.createElement("button");
    selectBtn.textContent = "🎯 Select DMOs";
    selectBtn.style.cssText = "border:1px solid #8b5cf6;background:#fff;color:#8b5cf6;border-radius:6px;padding:8px 16px;cursor:pointer;font:600 11px system-ui;";
    selectBtn.onclick = function() { showDMOSelector(entities, relationships, sourceMap, body, title); };

    var downloadBtn = document.createElement("button");
    downloadBtn.textContent = "⬇ Download HTML";
    downloadBtn.style.cssText = "border:1px solid #0d6efd;background:#0d6efd;color:#fff;border-radius:6px;padding:8px 16px;cursor:pointer;font:600 11px system-ui;";
    downloadBtn.onclick = function() { downloadERDAsHTML(entities, relationships, sourceMap); };

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.title = "Close the ERD diagram";
    closeBtn.style.cssText = "border:none;background:none;cursor:pointer;font-size:24px;color:#64748b;padding:0 8px;";
    closeBtn.onclick = function() { modal.remove(); };

    selectBtn.title = "Choose which Data Model Objects to include in the diagram";
    downloadBtn.title = "Download the ERD as a standalone HTML file";

    header.appendChild(title);
    header.appendChild(selectBtn);
    header.appendChild(downloadBtn);
    header.appendChild(closeBtn);

    // Collapsible help guide
    var helpContainer = document.createElement("div");
    helpContainer.style.cssText = "border-bottom:1px solid #e2e8f0;background:#f8fafc;";

    var helpToggle = document.createElement("div");
    helpToggle.title = "Show/hide a short guide on how to use the ERD tool";
    helpToggle.style.cssText = "padding:10px 18px;cursor:pointer;display:flex;align-items:center;gap:8px;font:600 12px -apple-system,sans-serif;color:#3b82f6;";
    helpToggle.textContent = "ℹ How to use";

    var helpContent = document.createElement("div");
    helpContent.style.cssText = "display:none;padding:0 18px 12px 18px;font:13px/1.6 -apple-system,sans-serif;color:#475569;";
    helpContent.innerHTML =
      "<div style='background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:12px 14px;'>" +
      "<div style='font:600 13px -apple-system,sans-serif;color:#1e293b;margin-bottom:8px;'>How to use this ERD tool:</div>" +
      "<ul style='margin:0;padding-left:20px;'>" +
      "<li>The diagram shows your Data Model Objects and how they connect to each other</li>" +
      "<li>Click \"Select DMOs\" to choose which objects to include (fewer = cleaner diagram)</li>" +
      "<li>Use presets for quick selections:<ul style='margin:4px 0;'>" +
      "<li>\"Profile only\" — core customer entities</li>" +
      "<li>\"Individual + connections\" — one entity and its neighbors</li></ul></li>" +
      "<li>Use \"Quick Focus\" to pick one entity and see 1 or 2 levels of connections</li>" +
      "<li>Copy the diagram code and paste into Lucidchart or draw.io to get a visual diagram</li>" +
      "<li><b>Tip:</b> Select 3-8 entities for the cleanest, most readable output</li>" +
      "</ul></div>";

    helpToggle.addEventListener("click", function() {
      if (helpContent.style.display === "none") {
        helpContent.style.display = "block";
        helpToggle.textContent = "ℹ Hide help";
      } else {
        helpContent.style.display = "none";
        helpToggle.textContent = "ℹ How to use";
      }
    });

    helpContainer.appendChild(helpToggle);
    helpContainer.appendChild(helpContent);

    // Body (scrollable container)
    var body = document.createElement("div");
    body.style.cssText = "flex:1;overflow:auto;padding:20px;background:#f8fafc;";
    body.innerHTML = renderERDCards(entities, relationships, sourceMap);

    // Live search — filter cards by label / API name (data-erd-search).
    body.addEventListener("input", function(e) {
      if (!e.target || e.target.id !== "dc-erd-search") return;
      var q = e.target.value.trim().toLowerCase();
      var cards = body.querySelectorAll(".dc-erd-card");
      var shown = 0;
      cards.forEach(function(card) {
        var key = card.getAttribute("data-erd-search") || "";
        var match = !q || key.indexOf(q) >= 0;
        card.style.display = match ? "" : "none";
        if (match) shown++;
      });
      var countEl = body.querySelector("#dc-erd-search-count");
      if (countEl) countEl.textContent = q ? (shown + " of " + cards.length + " cards") : "";
    });

    // Event delegation for copy and toggle buttons (CSP-safe)
    body.addEventListener("click", function(e) {
      var target = e.target;

      // Handle copy buttons
      if (target.getAttribute("data-copy-id")) {
        var sourceId = target.getAttribute("data-copy-id");
        var sourceEl = body.querySelector("#" + sourceId);
        if (sourceEl) {
          var ta = document.createElement("textarea");
          ta.value = sourceEl.textContent;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          var originalText = target.textContent;
          var copyLabel = target.getAttribute("data-copy-label") || "Copy";
          target.textContent = "Copied!";
          setTimeout(function() { target.textContent = copyLabel; }, 1500);
        }
      }

      // Handle toggle buttons
      if (target.getAttribute("data-toggle-id")) {
        var toggleId = target.getAttribute("data-toggle-id");
        var panel = body.querySelector("#" + toggleId);
        var count = target.getAttribute("data-count");
        if (panel) {
          if (panel.style.display === "none") {
            panel.style.display = "block";
            target.textContent = "Hide Connections (" + count + ")";
          } else {
            panel.style.display = "none";
            target.textContent = "View Connections (" + count + ")";
          }
        }
      }
    });

    content.appendChild(header);
    content.appendChild(helpContainer);
    content.appendChild(body);
    modal.appendChild(content);
    document.body.appendChild(modal);
    try { installErdTooltips(modal); } catch (e) {}

    modal.addEventListener("click", function(e) {
      if (e.target === modal) modal.remove();
    });
  }

  function parseDOTGraph(dotString) {
    var entities = [];
    var entityMap = {}; // id -> entity
    var edgeTypeMap = buildEdgeAttrTypeMap(dotString); // "<entityDevName>::<fieldDevName>" -> {dataType,dataRequired}


    // The DOT format has nodes like: 1 [ label="Name__dlm" entity="{...escaped JSON...}" ]
    // The entity JSON uses \" for quotes inside. We find each node by matching the pattern.
    var nodeRegex = /(\d+)\s*\[\s*label="([^"]+)"\s+entity="((?:[^"\\]|\\.)*)"\s*\]/g;
    var match;

    // If regex doesn't find anything, try alternative parsing
    if (!nodeRegex.test(dotString)) {
      nodeRegex.lastIndex = 0;
      // Alternative: split by lines and extract manually
      var lines = dotString.split("\n");
      lines.forEach(function(line) {
        var labelMatch = line.match(/(\d+)\s*\[\s*label="([^"]+)"/);
        var entityMatch = line.match(/entity="((?:[^"\\]|\\.)*)"/);
        if (labelMatch && entityMatch) {
          var nodeId = labelMatch[1];
          var devName = labelMatch[2];
          var entityJsonStr = entityMatch[1];
          try {
            var unescaped = entityJsonStr.replace(/\\"/g, '"').replace(/\\n/g, '').replace(/\\\\/g, '\\');
            var entityData = JSON.parse(unescaped);
            var _pkSet = {}; (entityData.primaryKeys || []).forEach(function(pk){ if (pk && pk.developerName) _pkSet[pk.developerName] = true; });
            var _entDev = entityData.developerName || devName;
            var entity = {
              id: nodeId,
              developerName: _entDev,
              masterLabel: entityData.masterLabel || devName,
              category: getCategoryName(entityData.dataEntityCategoryId),
              categoryId: entityData.dataEntityCategoryId,
              attributes: (entityData.attributes || []).map(function(attr) {
                var dn = attr.developerName || "";
                var _et = edgeTypeMap[_entDev + "::" + dn] || null; // type borrowed from edges when node's is null
                return {
                  masterLabel: attr.masterLabel || dn || "",
                  developerName: dn,
                  dataType: attr.dataType || attr.businessType || (_et && _et.dataType) || "",
                  // PK: authoritative primaryKeys[] only. No KQ_ heuristics — KQ_ fields
                  // are key qualifiers (lookup aids), not PKs unless explicitly listed.
                  isPrimaryKey: !!_pkSet[dn],
                  // FK: KQ_ field that is NOT a PK (not in primaryKeys[]).
                  isForeignKey: dn.indexOf("KQ_") === 0 && !_pkSet[dn],
                  foreignKey: attr.referenceModelEntityAttributeDeveloperName || null,
                  isRequired: attr.dataRequired || (_et && _et.dataRequired) || false
                };
              })
            };
            entities.push(entity);
            entityMap[nodeId] = entity;
          } catch (e) {
          }
        }
      });
      return entities;
    }
    nodeRegex.lastIndex = 0;

    while ((match = nodeRegex.exec(dotString)) !== null) {
      var nodeId = match[1];
      var devName = match[2];
      var entityJsonStr = match[3];

      try {
        // Unescape the JSON (backslash-escaped quotes, newlines, backslashes)
        var unescaped = entityJsonStr.replace(/\\"/g, '"').replace(/\\n/g, '').replace(/\\\\/g, '\\');
        var entityData = JSON.parse(unescaped);

        // Authoritative PK set from entity.primaryKeys (verified via probe: attribute-level
        // primaryIndexOrder comes back null, but primaryKeys[] is populated, e.g.
        // [{index:1, developerName:"Id__c", masterLabel:"Quote Id"}]).
        var _pkSet = {}; (entityData.primaryKeys || []).forEach(function(pk){ if (pk && pk.developerName) _pkSet[pk.developerName] = true; });
        var _entDev = entityData.developerName || devName;
        var entity = {
          id: nodeId,
          developerName: _entDev,
          masterLabel: entityData.masterLabel || devName,
          category: getCategoryName(entityData.dataEntityCategoryId),
          categoryId: entityData.dataEntityCategoryId,
          attributes: (entityData.attributes || []).map(function(attr) {
            var dn = attr.developerName || "";
            // Node attr dataType is null in some orgs; borrow it from the edge blob when so.
            var _et = edgeTypeMap[_entDev + "::" + dn] || null;
            return {
              masterLabel: attr.masterLabel || dn || "",
              developerName: dn,
              dataType: attr.dataType || attr.businessType || (_et && _et.dataType) || "",
              isPrimaryKey: !!_pkSet[dn],
              isForeignKey: dn.indexOf("KQ_") === 0 && !_pkSet[dn],
              foreignKey: attr.referenceModelEntityAttributeDeveloperName || null,
              isRequired: attr.dataRequired || (_et && _et.dataRequired) || false
            };
          })
        };

        entities.push(entity);
        entityMap[nodeId] = entity;
      } catch (e) {
      }
    }

    return entities;
  }

  function getCategoryName(categoryId) {
    if (!categoryId) return "OTHER";
    var upper = String(categoryId).toUpperCase();
    if (upper === "PROFILE" || upper === "1") return "PROFILE";
    if (upper === "ENGAGEMENT" || upper === "2") return "ENGAGEMENT";
    return "OTHER";
  }

  function renderERDCards(entities, relationships, sourceMap) {
    var esc = function(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function(c) { return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); };
    var html = "";

    // ── Mermaid ERD Diagram (copyable) ──
    var mermaidCode = generateMermaidERD(entities, relationships);
    html += "<div style='background:#1e293b;border-radius:10px;padding:16px 20px;margin-bottom:12px;position:relative;'>";
    html += "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;'>";
    html += "<span style='font:700 13px -apple-system,sans-serif;color:#94a3b8;'>Diagram Code (Lucidchart, draw.io, GitHub — Confluence needs Mermaid plugin)</span>";
    html += "<button data-copy-id='dc-mermaid-main' title='Copy diagram code to clipboard' style='border:1px solid #475569;background:#334155;color:#e2e8f0;border-radius:5px;padding:4px 12px;cursor:pointer;font:600 11px system-ui;'>Copy</button>";
    html += "</div>";
    html += "<pre id='dc-mermaid-main' style='font:11px/1.6 SF Mono,Consolas,monospace;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto;margin:0;'>" + esc(mermaidCode) + "</pre>";
    html += "</div>";

    // ── Cardinality Legend ──
    html += "<div style='background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px 16px;margin-bottom:24px;'>";
    html += "<div style='font:600 11px -apple-system,sans-serif;color:#64748b;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;'>Relationship Symbols</div>";
    html += "<div style='display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font:11px SF Mono,Consolas,monospace;color:#475569;'>";
    html += "<code style='color:#0369a1;'>||--o{</code><span>One to Many (parent has one, child has many)</span>";
    html += "<code style='color:#0369a1;'>}o--||</code><span>Many to One (this entity has FK to the other)</span>";
    html += "<code style='color:#0369a1;'>||--||</code><span>One to One (e.g., Latest snapshot)</span>";
    html += "<code style='color:#0369a1;'>}o--o{</code><span>Many to Many (link/junction table)</span>";
    html += "</div></div>";

    // Build entity lookup for relationship table
    var entityByLabel = {};
    entities.forEach(function(ent) { entityByLabel[ent.masterLabel] = ent; });

    // ── Relationship Table (all DOT graph edges — source of truth from SF graph view) ──
    html += "<div style='border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:24px;'>";
    html += "<div style='background:#f8fafc;padding:10px 16px;border-bottom:1px solid #e2e8f0;font:600 13px -apple-system,sans-serif;color:#1e293b;'>Relationships (" + relationships.length + " connections from Graph View)</div>";
    html += "<div style='overflow-x:auto;padding:12px;'><table style='width:100%;border-collapse:collapse;font-size:11px;'><thead><tr style='background:#f1f5f9;'><th style='padding:6px 10px;border:1px solid #e2e8f0;'>From</th><th style='padding:6px 10px;border:1px solid #e2e8f0;'>Category</th><th style='padding:6px 10px;border:1px solid #e2e8f0;'>FK Field</th><th style='padding:6px 10px;border:1px solid #e2e8f0;'>Cardinality</th><th style='padding:6px 10px;border:1px solid #e2e8f0;'>To</th><th style='padding:6px 10px;border:1px solid #e2e8f0;'>Category</th></tr></thead><tbody>";
    var relTableSeen = {};
    relationships.forEach(function(rel) {
      var key = [rel.from, rel.to].sort().join("|||");
      if (relTableSeen[key]) return;
      relTableSeen[key] = true;
      var fromEnt = entityByLabel[rel.from];
      var toEnt = entityByLabel[rel.to];
      if (!fromEnt || !toEnt || rel.from === rel.to) return;

      // Try to get FK info from verifyRelationship — if it fails, show "—" for FK field
      var fkField = "—";
      var cardName = "Related";
      var verified = verifyRelationship(fromEnt, toEnt);
      if (verified && verified.verified) {
        fkField = verified.fkField;
        cardName = verified.cardinality === "||--o{" ? "OneToMany" : verified.cardinality === "}o--||" ? "ManyToOne" : verified.cardinality === "||--||" ? "OneToOne" : "ManyToMany";
      } else {
        // Don't guess FK field — keep it as "—"
        // Guess cardinality based on entity type
        if (/Latest|_SM_/i.test(rel.from) || /Latest|_SM_/i.test(rel.to)) cardName = "OneToOne";
        else if (/Link/i.test(rel.from) || /Link/i.test(rel.to)) cardName = "ManyToMany";
        else cardName = "Connected";
      }
      var cardColor = cardName === "ManyToOne" ? "#fef3c7" : cardName === "OneToOne" || cardName === "OneToMany" ? "#dcfce7" : cardName === "ManyToMany" ? "#e0f2fe" : "#f3f4f6";
      var cardTextColor = cardName === "ManyToOne" ? "#92400e" : cardName === "OneToOne" || cardName === "OneToMany" ? "#166534" : cardName === "ManyToMany" ? "#0369a1" : "#374151";

      // Category badges
      var fromCatColor = fromEnt.category === "PROFILE" ? "#d1fae5" : fromEnt.category === "ENGAGEMENT" ? "#fed7aa" : "#e5e7eb";
      var fromCatText = fromEnt.category === "PROFILE" ? "#065f46" : fromEnt.category === "ENGAGEMENT" ? "#92400e" : "#374151";
      var toCatColor = toEnt.category === "PROFILE" ? "#d1fae5" : toEnt.category === "ENGAGEMENT" ? "#fed7aa" : "#e5e7eb";
      var toCatText = toEnt.category === "PROFILE" ? "#065f46" : toEnt.category === "ENGAGEMENT" ? "#92400e" : "#374151";

      html += "<tr>";
      html += "<td style='padding:5px 10px;border:1px solid #e2e8f0;font-weight:600;'>" + esc(rel.from) + "</td>";
      html += "<td style='padding:5px 10px;border:1px solid #e2e8f0;text-align:center;'><span style='background:" + fromCatColor + ";color:" + fromCatText + ";padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;text-transform:uppercase;'>" + fromEnt.category + "</span></td>";
      html += "<td style='padding:5px 10px;border:1px solid #e2e8f0;font-family:monospace;color:" + (fkField === "—" ? "#94a3b8" : "#0369a1") + ";font-size:10px;'>" + esc(fkField) + "</td>";
      html += "<td style='padding:5px 10px;border:1px solid #e2e8f0;text-align:center;'><span style='background:" + cardColor + ";color:" + cardTextColor + ";padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;'>" + cardName + "</span></td>";
      html += "<td style='padding:5px 10px;border:1px solid #e2e8f0;font-weight:600;'>" + esc(rel.to) + "</td>";
      html += "<td style='padding:5px 10px;border:1px solid #e2e8f0;text-align:center;'><span style='background:" + toCatColor + ";color:" + toCatText + ";padding:2px 6px;border-radius:3px;font-size:9px;font-weight:600;text-transform:uppercase;'>" + toEnt.category + "</span></td>";
      html += "</tr>";
    });
    html += "</tbody></table></div></div>";

    // Build per-entity relationship lookup
    var relsByEntity = {};
    relationships.forEach(function(rel) {
      if (!relsByEntity[rel.from]) relsByEntity[rel.from] = [];
      relsByEntity[rel.from].push({ target: rel.to, label: rel.label, direction: "out" });
      if (!relsByEntity[rel.to]) relsByEntity[rel.to] = [];
      relsByEntity[rel.to].push({ target: rel.from, label: rel.label, direction: "in" });
    });

    // ── Entity cards ──
    // Search bar — filters cards by label / API name (wired in body's 'input' handler).
    html += "<div style='display:flex;align-items:center;gap:8px;margin-bottom:16px;'>";
    html += "<input id='dc-erd-search' type='text' placeholder='Search cards by name or API name…' title='Type to filter the cards below' style='flex:1;max-width:420px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font:13px -apple-system,sans-serif;outline:none;'>";
    html += "<span id='dc-erd-search-count' style='font:600 11px system-ui;color:#64748b;'></span>";
    html += "</div>";
    html += "<div id='dc-erd-grid' style='display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:20px;'>";

    entities.forEach(function(entity) {
      var categoryColor = entity.category === "PROFILE" ? "#10b981"
        : entity.category === "ENGAGEMENT" ? "#f59e0b"
        : "#6b7280";

      // Count mapped (non-system) fields shown on this card, for the header badge.
      var _cardFieldCount = entity.attributes.filter(function(a) {
        return _systemFields.indexOf(a.developerName) < 0;
      }).length;
      // data-erd-search lets the search bar show/hide whole cards by label/api name.
      var _searchKey = (esc(entity.masterLabel) + " " + esc(entity.developerName)).toLowerCase();
      html += "<div class='dc-erd-card' data-erd-search=\"" + _searchKey + "\" style='background:#fff;border:2px solid " + categoryColor + ";border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);'>";

      // Card header — title links to the DMO detail (verified URL: the standard-DataModel
      // nav item with c__objectApiName=<developerName>). Opens in a new tab.
      var _detailUrl = "/lightning/n/standard-DataModel?c__objectApiName=" + encodeURIComponent(entity.developerName);
      html += "<div style='background:" + categoryColor + ";color:#fff;padding:12px 14px;'>";
      html += "<div style='display:flex;justify-content:space-between;align-items:flex-start;gap:8px;'>";
      html += "<a href='" + _detailUrl + "' target='_blank' rel='noopener' title='Open this DMO’s detail page in a new tab' style='font:700 14px -apple-system,sans-serif;color:#fff;text-decoration:none;border-bottom:1px dotted rgba(255,255,255,.6);'>" + esc(entity.masterLabel) + " <span style='font-size:10px;opacity:.8;'>↗</span></a>";
      html += "<span title='Mapped fields shown on this card' style='background:rgba(255,255,255,.25);color:#fff;font:600 10px system-ui;padding:2px 8px;border-radius:10px;white-space:nowrap;'>" + _cardFieldCount + " fields</span>";
      html += "</div>";
      html += "<div style='font:600 10px SF Mono,Consolas,monospace;opacity:0.9;margin-top:2px'>" + esc(entity.developerName) + "</div>";
      html += "<div style='display:flex;gap:8px;margin-top:4px;align-items:center;'>";
      html += "<span style='font:600 9px system-ui;opacity:0.8;text-transform:uppercase;letter-spacing:0.5px'>" + esc(entity.category) + "</span>";
      html += "</div>";
      html += "</div>";

      // Source lineage (Data Stream → DLO)
      var src = sourceMap[entity.developerName];
      if (src && (src.dataStream.length > 0 || src.dataLakeObject.length > 0)) {
        html += "<div style='padding:8px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font:11px -apple-system,sans-serif;color:#475569;'>";
        if (src.dataStream.length > 0) html += "<div><b style='color:#64748b;'>Source:</b> " + src.dataStream.map(esc).join(", ") + "</div>";
        if (src.dataLakeObject.length > 0) html += "<div><b style='color:#64748b;'>DLO:</b> " + src.dataLakeObject.map(esc).join(", ") + "</div>";
        html += "</div>";
      }

      // Relationships for this entity — show as readable list with verified relationships only
      var entityRels = relsByEntity[entity.masterLabel] || [];
      var uniqueTargets = {};
      entityRels.forEach(function(r) { if (!uniqueTargets[r.target]) uniqueTargets[r.target] = r; });
      var uniqueRelList = Object.keys(uniqueTargets).map(function(k) { return uniqueTargets[k]; });

      // Show ALL relationships from DOT graph (source of truth)
      var displayRels = [];
      uniqueRelList.forEach(function(r) {
        var targetEnt = entityByLabel[r.target];
        if (!targetEnt) return;
        var fkField = "FK";
        var cardType = "Related";
        // Try verification for FK field + cardinality info
        var verified = verifyRelationship(entity, targetEnt);
        if (verified && verified.verified) {
          fkField = verified.fkField;
          if (verified.cardinality === "||--o{") cardType = "1:Many";
          else if (verified.cardinality === "}o--||") cardType = "Many:1";
          else if (verified.cardinality === "||--||") cardType = "1:1";
          else if (verified.cardinality === "}o--o{") cardType = "Many:Many";
        } else {
          // Don't guess FK field — just show cardinality based on entity type
          fkField = "";
          if (/Latest|_SM_/i.test(r.target)) cardType = "1:1";
          else if (/Link/i.test(r.target) || /Link/i.test(entity.masterLabel)) cardType = "Many:Many";
          else cardType = "Connected";
        }
        displayRels.push({ target: r.target, fkField: fkField, cardType: cardType, direction: r.direction });
      });

      if (displayRels.length > 0) {
        var toggleId = "dc-rels-toggle-" + entity.id;
        html += "<div style='padding:6px 14px;background:#f0f9ff;border-bottom:1px solid #bfdbfe;display:flex;align-items:center;gap:8px;'>";
        html += "<button data-toggle-id='" + toggleId + "' data-count='" + displayRels.length + "' title='Show which other entities this DMO is connected to' style='border:1px solid #3b82f6;background:#fff;color:#2563eb;border-radius:4px;padding:3px 10px;cursor:pointer;font:600 10px system-ui;'>View Connections (" + displayRels.length + ")</button>";
        html += "</div>";
        html += "<div id='" + toggleId + "' style='display:none;padding:10px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;'>";
        html += "<div style='font:600 10px -apple-system,sans-serif;color:#64748b;margin-bottom:6px;text-transform:uppercase;'>Connected To</div>";
        displayRels.forEach(function(rel) {
          html += "<div style='font:12px -apple-system,sans-serif;color:#1e293b;padding:4px 0;border-bottom:1px dashed #e2e8f0;'>";
          html += "<span style='font-weight:600;'>" + esc(rel.target) + "</span>";
          if (rel.fkField) html += " <span style='color:#64748b;font-size:10px;'>via " + esc(rel.fkField) + "</span>";
          if (rel.cardType && rel.cardType !== "Connected") html += " <span style='background:#f1f5f9;color:#475569;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;'>" + rel.cardType + "</span>";
          html += "</div>";
        });
        html += "</div>";
      }

      // Split fields into three groups:
      //   sysFields  — standard system columns (always at the bottom with a heading)
      //   keyFields  — PKs + FKs that are NOT system fields (shown highlighted at top)
      //   bizFields  — everything else (no key, not system)
      // System fields that happen to be PK/FK (e.g. DataSourceId__c is a PK on Unified
      // Link) still go to the bottom group — they are plumbing, not meaningful keys for
      // a user reading the model. Their PK/FK badge is preserved in the footer note.
      var sysFields = entity.attributes.filter(function(a) {
        return _systemFields.indexOf(a.developerName) >= 0;
      });
      var keyFields = entity.attributes.filter(function(a) {
        if (_systemFields.indexOf(a.developerName) >= 0) return false;
        return a.isPrimaryKey || a.isForeignKey;
      });
      var bizFields = entity.attributes.filter(function(a) {
        if (_systemFields.indexOf(a.developerName) >= 0) return false;
        if (a.isPrimaryKey || a.isForeignKey) return false;
        return true;
      });

      // Fields table
      if (keyFields.length > 0 || bizFields.length > 0) {
        var _shownCount = keyFields.length + bizFields.length;
        html += "<div style='overflow-x:auto;'>";
        html += "<div style='font:500 9px system-ui;color:#94a3b8;padding:4px 10px;'>" + _shownCount + " mapped field" + (_shownCount === 1 ? "" : "s") + " (Is Mapped = True; system fields hidden)</div>";
        html += "<table style='width:100%;border-collapse:collapse;font:11px -apple-system,sans-serif;'>";
        html += "<thead><tr style='background:#f8fafc;border-bottom:1px solid #e2e8f0;'>";
        html += "<th style='text-align:center;padding:6px 4px;font:600 9px system-ui;color:#64748b;'>#</th>";
        html += "<th style='text-align:left;padding:6px 10px;font:600 9px system-ui;color:#64748b;text-transform:uppercase'>Field</th>";
        html += "<th style='text-align:left;padding:6px 10px;font:600 9px system-ui;color:#64748b;text-transform:uppercase'>API Name</th>";
        html += "<th style='text-align:left;padding:6px 10px;font:600 9px system-ui;color:#64748b;text-transform:uppercase'>Type</th>";
        html += "<th style='text-align:center;padding:6px 4px;font:600 9px system-ui;color:#64748b;text-transform:uppercase'>Key</th>";
        html += "</tr></thead><tbody>";

        var _rowNo = 0; // continuous serial across key + business fields
        // PKs first (highlighted)
        keyFields.forEach(function(attr) {
          _rowNo++;
          html += "<tr style='background:#f0fdf4;border-bottom:1px solid #dcfce7;'>";
          html += "<td style='padding:6px 4px;text-align:center;color:#94a3b8;font-size:10px'>" + _rowNo + "</td>";
          html += "<td style='padding:6px 10px;color:#166534;font-weight:600'>" + esc(attr.masterLabel) + "</td>";
          html += "<td style='padding:6px 10px;font:600 10px SF Mono,Consolas,monospace;color:#166534'>" + esc(attr.developerName) + "</td>";
          html += "<td style='padding:6px 10px;color:#64748b;font-size:10px'>" + esc(attr.dataType) + "</td>";
          html += "<td style='padding:6px 4px;text-align:center;font:600 10px system-ui;'>" + (attr.isPrimaryKey ? "<span style='color:#10b981'>PK</span>" : "") + (attr.isForeignKey ? "<span style='color:#f59e0b'>FK</span>" : "") + "</td>";
          html += "</tr>";
        });

        // Business fields
        bizFields.forEach(function(attr, idx) {
          _rowNo++;
          var rowBg = idx % 2 === 0 ? "#fff" : "#f9fafb";
          html += "<tr style='background:" + rowBg + ";border-bottom:1px solid #f1f5f9;'>";
          html += "<td style='padding:6px 4px;text-align:center;color:#94a3b8;font-size:10px'>" + _rowNo + "</td>";
          html += "<td style='padding:6px 10px;color:#1e293b'>" + esc(attr.masterLabel) + "</td>";
          html += "<td style='padding:6px 10px;font:500 10px SF Mono,Consolas,monospace;color:#475569'>" + esc(attr.developerName) + "</td>";
          html += "<td style='padding:6px 10px;color:#64748b;font-size:10px'>" + esc(attr.dataType) + "</td>";
          html += "<td style='padding:6px 4px;text-align:center'></td>";
          html += "</tr>";
        });

        html += "</tbody></table></div>";
        // System fields section — always at the bottom with a clear heading so users know
        // they exist but are separated from the meaningful model fields. Show PK/FK badge
        // if applicable (e.g. DataSourceId__c is a real PK on some Unified Link entities).
        if (sysFields.length > 0) {
          html += "<div style='padding:4px 14px 2px;font:600 9px system-ui;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;'>System Fields (" + sysFields.length + ")</div>";
          html += "<div style='padding:2px 14px 8px;font:10px -apple-system,sans-serif;color:#94a3b8;'>";
          html += sysFields.map(function(f) {
            var badge = f.isPrimaryKey ? " <span style='color:#10b981;font-weight:700;font-size:9px;'>PK</span>"
                      : f.isForeignKey ? " <span style='color:#f59e0b;font-weight:700;font-size:9px;'>FK</span>"
                      : "";
            return esc(f.masterLabel || f.developerName) + badge;
          }).join(", ");
          html += "</div>";
        }
      } else {
        html += "<div style='padding:16px;color:#94a3b8;text-align:center;font:12px system-ui'>No business attributes</div>";
      }

      html += "</div>";
    });

    html += "</div>";
    return html;
  }

  function downloadERDAsHTML(entities, relationships, sourceMap) {
    var esc = function(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function(c) { return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); };

    var html = "<!DOCTYPE html>\n<html>\n<head>\n";
    html += "<meta charset='UTF-8'>\n";
    html += "<title>Data Model ERD</title>\n";
    html += "<style>\n";
    html += "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f8fafc; }\n";
    html += "h1 { color: #1e293b; margin-bottom: 4px; }\n";
    html += ".subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }\n";
    html += ".rel-section { background: #fff; border: 2px solid #3b82f6; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }\n";
    html += ".rel-title { font-weight: 700; font-size: 14px; color: #1e40af; margin-bottom: 12px; }\n";
    html += ".rel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap: 8px; }\n";
    html += ".rel-item { padding: 6px 10px; background: #eff6ff; border-radius: 6px; font-size: 12px; }\n";
    html += ".grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 20px; }\n";
    html += ".card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); }\n";
    html += ".card-header { color: #fff; padding: 12px 14px; }\n";
    html += ".card-title { font-weight: 700; font-size: 14px; }\n";
    html += ".card-api { font: 600 10px 'SF Mono', Consolas, monospace; opacity: 0.9; margin-top: 2px; }\n";
    html += ".card-source { padding: 8px 14px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; font-size: 11px; color: #475569; }\n";
    html += "table { width: 100%; border-collapse: collapse; font-size: 11px; }\n";
    html += "thead { background: #f8fafc; border-bottom: 1px solid #e2e8f0; }\n";
    html += "th { text-align: left; padding: 6px 10px; font: 600 9px system-ui; color: #64748b; text-transform: uppercase; }\n";
    html += ".pk-row { background: #f0fdf4 !important; border-bottom: 1px solid #dcfce7; }\n";
    html += ".pk-row td { color: #166534; font-weight: 600; }\n";
    html += "tbody tr:nth-child(even) { background: #f9fafb; }\n";
    html += "tbody tr { border-bottom: 1px solid #f1f5f9; }\n";
    html += "td { padding: 6px 10px; color: #1e293b; }\n";
    html += "td.api { font: 500 10px 'SF Mono', Consolas, monospace; color: #475569; }\n";
    html += ".profile { border: 2px solid #10b981; } .profile .card-header { background: #10b981; }\n";
    html += ".engagement { border: 2px solid #f59e0b; } .engagement .card-header { background: #f59e0b; }\n";
    html += ".other { border: 2px solid #6b7280; } .other .card-header { background: #6b7280; }\n";
    html += "@media print { body { background: #fff; } .card { break-inside: avoid; } }\n";
    html += "</style>\n";
    html += "</head>\n<body>\n";
    html += "<h1>Data Model ERD</h1>\n";
    html += "<div class='subtitle'>" + entities.length + " entities &bull; " + relationships.length + " relationships &bull; Generated " + new Date().toISOString().slice(0, 10) + "</div>\n";

    // Build per-entity relationship lookup for download
    var relsByEntity2 = {};
    relationships.forEach(function(rel) {
      if (!relsByEntity2[rel.from]) relsByEntity2[rel.from] = [];
      relsByEntity2[rel.from].push(rel.to);
      if (!relsByEntity2[rel.to]) relsByEntity2[rel.to] = [];
      relsByEntity2[rel.to].push(rel.from);
    });

    // Mermaid ERD block
    var mermaidCode2 = generateMermaidERD(entities, relationships);
    html += "<div style='background:#1e293b;border-radius:10px;padding:16px 20px;margin-bottom:24px;'>\n";
    html += "<div style='font:700 13px -apple-system,sans-serif;color:#94a3b8;margin-bottom:10px;'>Diagram Code (Lucidchart, draw.io, GitHub — Confluence needs Mermaid plugin)</div>\n";
    html += "<pre style='font:11px/1.6 monospace;color:#e2e8f0;white-space:pre-wrap;word-break:break-word;margin:0;'>" + esc(mermaidCode2) + "</pre>\n";
    html += "</div>\n";

    html += "<div class='grid'>\n";

    entities.forEach(function(entity) {
      var categoryClass = entity.category === "PROFILE" ? "profile"
        : entity.category === "ENGAGEMENT" ? "engagement"
        : "other";

      html += "<div class='card " + categoryClass + "'>\n";
      html += "<div class='card-header'>\n";
      html += "<div class='card-title'>" + esc(entity.masterLabel) + "</div>\n";
      html += "<div class='card-api'>" + esc(entity.developerName) + "</div>\n";
      html += "</div>\n";

      // Source lineage
      var src = sourceMap[entity.developerName];
      if (src && (src.dataStream.length > 0 || src.dataLakeObject.length > 0)) {
        html += "<div class='card-source'>";
        if (src.dataStream.length > 0) html += "<div><b>Source:</b> " + src.dataStream.map(esc).join(", ") + "</div>";
        if (src.dataLakeObject.length > 0) html += "<div><b>DLO:</b> " + src.dataLakeObject.map(esc).join(", ") + "</div>";
        html += "</div>\n";
      }

      // Related entities
      var entityRels2 = relsByEntity2[entity.masterLabel] || [];
      var uniqueRels2 = entityRels2.filter(function(v, i, a) { return a.indexOf(v) === i; });
      if (uniqueRels2.length > 0) {
        html += "<div class='card-source' style='background:#eff6ff;border-color:#bfdbfe;'><b style='color:#1e40af;'>Related to:</b> " + uniqueRels2.map(esc).join(", ") + "</div>\n";
      }

      var sysFields2 = entity.attributes.filter(function(a) { return _systemFields.indexOf(a.developerName) >= 0; });
      var keyFields = entity.attributes.filter(function(a) {
        if (_systemFields.indexOf(a.developerName) >= 0) return false;
        return a.isPrimaryKey || a.isForeignKey;
      });
      var bizFields = entity.attributes.filter(function(a) {
        if (_systemFields.indexOf(a.developerName) >= 0) return false;
        if (a.isPrimaryKey || a.isForeignKey) return false;
        return true;
      });

      if (keyFields.length > 0 || bizFields.length > 0) {
        html += "<table>\n<thead><tr><th>Field</th><th>API Name</th><th>Type</th><th>Key</th></tr></thead>\n<tbody>\n";
        keyFields.forEach(function(attr) {
          html += "<tr class='pk-row'><td>" + esc(attr.masterLabel) + "</td><td class='api'>" + esc(attr.developerName) + "</td><td>" + esc(attr.dataType) + "</td><td>" + (attr.isPrimaryKey ? "PK" : "") + (attr.isForeignKey ? "FK" : "") + "</td></tr>\n";
        });
        bizFields.forEach(function(attr) {
          html += "<tr><td>" + esc(attr.masterLabel) + "</td><td class='api'>" + esc(attr.developerName) + "</td><td>" + esc(attr.dataType) + "</td><td></td></tr>\n";
        });
        html += "</tbody>\n</table>\n";
      }
      if (sysFields2.length > 0) {
        html += "<div class='card-source' style='font-size:10px;color:#94a3b8;'><b>System Fields:</b> " + sysFields2.map(function(f) { return esc(f.masterLabel || f.developerName) + (f.isPrimaryKey ? " (PK)" : f.isForeignKey ? " (FK)" : ""); }).join(", ") + "</div>\n";
      }

      html += "</div>\n";
    });

    html += "</div>\n</body>\n</html>";

    // Download
    var blob = new Blob([html], { type: "text/html" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "data-model-erd-" + new Date().toISOString().slice(0, 10) + ".html";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ═══════════════════════════════════════════════════════════════════════════════

  // In the public build the Data Explorer / Segment code is stripped, so guard the
  // calls with typeof. detectDetailPageType() never returns "Segment" there either.
  // PRIORITY: Segment before DataExplore (segment pages may contain record-list components).
  const onTransformPage = (typeof isTransformPage === "function") && isTransformPage();
  const onQueryEditorPage = (typeof isQueryEditorPage === "function") && isQueryEditorPage();
  const onDataModelPage = (typeof isDataModelPage === "function") && isDataModelPage();
  const onActivationPage = (typeof isActivationPage === "function") && isActivationPage();
  const onSegmentPage = detectDetailPageType() === "Segment";
  const detailPageType = onTransformPage ? "Transform"
    : onQueryEditorPage ? "QueryEditor"
    : onDataModelPage ? "DataModel"
    : onActivationPage ? "Activation"
    : onSegmentPage ? "Segment"
    : ((typeof isDataExplorePage === "function" && isDataExplorePage()) ? "DataExplore" : detectDetailPageType());
  // Every launcher path calls watchNavigation() so that when the user navigates away in
  // the SAME tab (Lightning SPA), the FAB tears down and its scope ends — a fresh bookmark
  // click then re-detects purely from the new URL. (Transform/DataModel/Activation were
  // previously missing this, so their FABs lingered after in-tab navigation.)
  if (detailPageType === "Transform" && typeof ensureTransformLauncher === "function") {
    ensureTransformLauncher();
    watchNavigation();
  } else if (detailPageType === "QueryEditor" && typeof ensureQueryEditorLauncher === "function") {
    ensureQueryEditorLauncher();
    watchNavigation();
  } else if (detailPageType === "DataModel" && typeof ensureDataModelLauncher === "function") {
    ensureDataModelLauncher();
    watchNavigation();
  } else if (detailPageType === "Activation" && typeof ensureActivationLauncher === "function") {
    ensureActivationLauncher();
    watchNavigation();
  } else if (detailPageType === "DataExplore" && typeof ensureExploreLauncher === "function") {
    ensureExploreLauncher();
    watchNavigation();
  }

  // Query Editor RETRY — the Query Editor page (/r/DataQueryWorkspace/<id>/view) is a
  // Lightning SPA: when the tool injects, the URL/route may not be final yet, so the
  // one-shot detection above can miss and no FAB appears. Re-check a few times and
  // launch as soon as it resolves to a Query Editor page (idempotent: bails if the FAB
  // already exists). Cheap, bounded, and only runs when no launcher fired at load.
  if (!document.getElementById("dc-bar") && typeof ensureQueryEditorLauncher === "function" && typeof isQueryEditorPage === "function") {
    var _qeTries = 0;
    var _qeRetry = setInterval(function () {
      _qeTries++;
      if (document.getElementById("dc-bar")) { clearInterval(_qeRetry); return; }   // some launcher appeared
      if (isQueryEditorPage()) {
        clearInterval(_qeRetry);
        try { ensureQueryEditorLauncher(); watchNavigation(); } catch (e) {}
      } else if (_qeTries >= 8) {
        clearInterval(_qeRetry);   // ~8s of tries; give up quietly
      }
    }, 1000);
  }

  // Segment page: show API names on hover (per-DMO tracking) — SEPARATE from if/else chain
  if (detailPageType === "Segment") {
    (function() {
      var fieldsByDmo = {};   // "Individual" → { "contact type": "TDI_Contact_Type__c", ... }
      var fetchingDmos = {};  // track in-flight requests
      var currentDmo = "";    // currently displayed DMO label
      var labelToDevName = {}; // "Individual Additional Information" → "TDI_TDI_GI_Individual_Additional__dlm"
      var dmoListLoaded = false;

      // Step 1: Fetch ALL DMO names (label→devName map) — one API call
      function loadDmoList(callback) {
        if (dmoListLoaded) { callback(); return; }
        var reqId = "dclist-" + Math.random().toString(36).slice(2, 8);
        function onList(ev) {
          if (!ev.data || ev.data.__dcRes !== "dc-dmo-list" || ev.data.id !== reqId) return;
          window.removeEventListener("message", onList);
          if (ev.data.ok && ev.data.resp) {
            // Response could be array of DMOs or object with array
            var dmos = Array.isArray(ev.data.resp) ? ev.data.resp : (ev.data.resp.dataModelObject || ev.data.resp.dataModelObjects || ev.data.resp.objects || []);
            dmos.forEach(function(d) {
              var label = d.label || d.masterLabel || "";
              var name = d.name || d.developerName || "";
              if (label && name) labelToDevName[label.toLowerCase()] = name;
            });
            dmoListLoaded = true;
          } else {
          }
          callback();
        }
        window.addEventListener("message", onList);
        window.postMessage({ __dcReq: "dc-dmo-list", id: reqId, dataspace: "TDI" }, "*");
        setTimeout(function() { window.removeEventListener("message", onList); callback(); }, 8000);
      }

      // Fetch DMO fields using exact dev name from lookup
      function fetchDmo(label, callback) {
        if (fieldsByDmo[label]) { callback(); return; }
        if (fetchingDmos[label]) return;
        fetchingDmos[label] = true;
        var devName = labelToDevName[label.toLowerCase()];
        if (!devName) {
          fetchingDmos[label] = false;
          return;
        }
        var reqId = "dcseg-" + Math.random().toString(36).slice(2, 8);
        var done = false;
        function handler(ev) {
          if (done || !ev.data || ev.data.__dcRes !== "dc-dmo-fields" || ev.data.id !== reqId) return;
          done = true; window.removeEventListener("message", handler);
          if (ev.data.ok && ev.data.resp && ev.data.resp.fields && ev.data.resp.fields.length > 0) {
            fieldsByDmo[label] = {};
            ev.data.resp.fields.forEach(function(f) { fieldsByDmo[label][f.label.toLowerCase()] = f.name; });
            fetchingDmos[label] = false;
            callback();
          } else {
            fetchingDmos[label] = false;
          }
        }
        window.addEventListener("message", handler);
        window.postMessage({ __dcReq: "dc-dmo-fields", id: reqId, dmoName: devName, dataspace: "TDI" }, "*");
        setTimeout(function() { if (!done) { done = true; window.removeEventListener("message", handler); fetchingDmos[label] = false; } }, 5000);
      }

      // Apply tooltips using ONLY the current DMO's field map
      function applyTooltips() {
        var map = fieldsByDmo[currentDmo];
        if (!map) return;
        function walk(root, depth) {
          if (depth > 12) return;
          var rows = root.querySelectorAll("[data-tid]");
          for (var i = 0; i < rows.length; i++) {
            if (rows[i].getAttribute("data-tid") !== "attr-row") continue;
            var nameDiv = rows[i].querySelector(".name");
            if (!nameDiv) continue;
            var label = nameDiv.textContent.trim();
            var api = map[label.toLowerCase()];
            if (api) {
              nameDiv.title = api;
              nameDiv.style.cursor = "help";
            } else {
              nameDiv.title = "";
              nameDiv.style.cursor = "";
            }
          }
          var els = root.querySelectorAll("*");
          for (var j = 0; j < els.length; j++) { if (els[j].shadowRoot) walk(els[j].shadowRoot, depth + 1); }
        }
        walk(document, 0);
      }

      // Detect which DMO is currently shown from "Attributes in X" heading
      function detectCurrentDmo() {
        var found = "";
        function walk(root, depth) {
          if (depth > 8 || found) return;
          root.querySelectorAll("*").forEach(function(el) {
            if (found) return;
            var txt = (el.textContent || "").trim();
            if (/^Attributes in /i.test(txt) && txt.length < 60) {
              found = txt.replace(/^Attributes in\s*/i, "").trim();
            }
          });
          root.querySelectorAll("*").forEach(function(el) { if (el.shadowRoot && !found) walk(el.shadowRoot, depth + 1); });
        }
        walk(document, 0);
        return found;
      }

      // Main check: detect DMO, fetch if needed, apply tooltips
      function checkAndAnnotate() {
        var dmo = detectCurrentDmo();
        if (!dmo) {
          // Fallback: try "Segment On" text for initial load
          function findSegOn(root, depth) {
            if (depth > 8 || dmo) return;
            root.querySelectorAll("*").forEach(function(el) {
              if (dmo) return;
              var txt = (el.textContent || "").trim();
              if (/Segment On/i.test(txt) && txt.length < 80 && el.children.length < 5) {
                var m = txt.match(/Segment On\s*[:\s]*(.+)/i);
                if (m) dmo = m[1].trim();
              }
            });
            root.querySelectorAll("*").forEach(function(el) { if (el.shadowRoot && !dmo) findSegOn(el.shadowRoot, depth + 1); });
          }
          findSegOn(document, 0);
        }
        if (!dmo) return;

        if (dmo !== currentDmo) {
          currentDmo = dmo;
          // Clear old tooltips (they belong to previous DMO)
          function clearTitles(root, depth) {
            if (depth > 12) return;
            var rows = root.querySelectorAll("[data-tid]");
            for (var i = 0; i < rows.length; i++) {
              if (rows[i].getAttribute("data-tid") !== "attr-row") continue;
              var nd = rows[i].querySelector(".name");
              if (nd) { nd.title = ""; nd.style.cursor = ""; }
            }
            var els = root.querySelectorAll("*");
            for (var j = 0; j < els.length; j++) { if (els[j].shadowRoot) clearTitles(els[j].shadowRoot, depth + 1); }
          }
          clearTitles(document, 0);
        }

        fetchDmo(currentDmo, applyTooltips);
      }

      // Run on initial load — first get ALL DMO names, then annotate
      setTimeout(function() { loadDmoList(checkAndAnnotate); }, 3000);

      // Watch for DOM changes (user navigates between DMOs)
      var debounceTimer = null;
      new MutationObserver(function() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkAndAnnotate, 500);
      }).observe(document.body, { childList: true, subtree: true });
    })();
  }

  if (detailPageType && detailPageType !== "DataExplore" && detailPageType !== "Transform" && detailPageType !== "QueryEditor" && detailPageType !== "DataModel" && detailPageType !== "Activation" && !/displayType=graph|marketSegmentActivation|\/r\/MarketSegmentActivation/i.test(window.location.href)) {
    function ensureDetailLauncher() {
      if (document.getElementById("dc-bar") || document.getElementById("dc-erd-bar") || /displayType=graph/i.test(window.location.href)) return;
      const wrap = document.createElement("div");
      wrap.id = "dc-bar";
      wrap.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none";

      const menu = document.createElement("div");
      menu.id = "dc-fab-menu";
      menu.style.cssText = "position:relative;width:220px;background:#111827;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08);overflow:hidden;padding:8px;pointer-events:none;transition:opacity .2s cubic-bezier(.34,1.56,.64,1),transform .2s cubic-bezier(.34,1.56,.64,1);opacity:0;transform:translateY(12px) scale(.95);";
      menu.setAttribute("aria-hidden", "true");

      const exportIconSvg = "<svg width='14' height='14' viewBox='0 0 16 16' fill='white'><path d='M8 1v9M4 6l4 4 4-4'/><rect x='2' y='13' width='12' height='2' rx='1'/></svg>";
      const segIconSvg    = "<svg width='14' height='14' viewBox='0 0 16 16' fill='white'><rect x='1' y='1' width='6' height='6' rx='1'/><rect x='9' y='1' width='6' height='6' rx='1'/><rect x='1' y='9' width='6' height='6' rx='1'/><path d='M9 12h6M12 9v6'/></svg>";

      const mkBtn = (id, label, title, iconGrad, iconSvg, subtitle) => {
        const b = document.createElement("button");
        b.id = id;
        b.title = title;
        b.style.cssText = "display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:10px;cursor:pointer;border:none;background:#111827;color:#fff;text-align:left;transition:background .12s;";
        b.onmouseenter = () => { b.style.background = "rgba(255,255,255,.07)"; };
        b.onmouseleave = () => { b.style.background = "#111827"; };
        const iconBox = "<div style='flex-shrink:0;width:32px;height:32px;border-radius:10px;background:" + iconGrad + ";display:flex;align-items:center;justify-content:center;'>" + iconSvg + "</div>";
        const textCol = "<div style='display:flex;flex-direction:column;gap:1px;'><span style='font:600 13px/1.2 -apple-system,sans-serif;color:#fff;'>" + label + "</span><span style='font:400 11px/1.3 -apple-system,sans-serif;color:#94a3b8;'>" + subtitle + "</span></div>";
        b.innerHTML = iconBox + textCol;
        return b;
      };

      const isSegment = detailPageType === "Segment";
      const btnIconSvg   = isSegment ? segIconSvg : exportIconSvg;
      const btnGrad      = isSegment ? "linear-gradient(135deg,#8b5cf6,#7c3aed)" : "linear-gradient(135deg,#f59e0b,#d97706)";
      const btnLabel     = isSegment ? "Export Rules" : "Export Fields";
      const btnSubtitle  = isSegment ? "All segment conditions" : "All fields with types";

      const dl = mkBtn("dc-detail-btn", btnLabel, btnLabel, btnGrad, btnIconSvg, btnSubtitle);
      dl.onclick = (e) => { e.stopPropagation(); if (detailPageType === "DataStream") openDsExport(); else if (detailPageType === "DLO") openDloExport(); else if (detailPageType === "Segment" && typeof openSegmentExport === "function") openSegmentExport(); else openDmoExport(); };

      const separator = document.createElement("div");
      separator.style.cssText = "height:1px;background:rgba(255,255,255,.08);margin:4px 0;";

      const dismissRow = document.createElement("button");
      dismissRow.title = "Remove Data 360 Inspector";
      dismissRow.innerHTML = "<span style='font:500 12px/1 -apple-system,sans-serif;color:#ef4444;display:flex;align-items:center;gap:6px;padding:2px 0;'><span style='font-size:14px;line-height:1;'>×</span>Remove</span>";
      dismissRow.style.cssText = "display:flex;align-items:center;width:100%;padding:8px 10px;border-radius:10px;cursor:pointer;border:none;background:#111827;transition:background .12s;";
      dismissRow.onmouseenter = () => (dismissRow.style.background = "rgba(239,68,68,.08)");
      dismissRow.onmouseleave = () => (dismissRow.style.background = "#111827");
      dismissRow.onclick = (e) => { e.stopPropagation(); teardown(); };

      menu.appendChild(dl);
      menu.appendChild(separator);
      menu.appendChild(dismissRow);

      const fab = document.createElement("button");
      fab.id = "dc-fab";
      fab.title = "Data 360 Inspector";
      fab.innerHTML = "<svg width='22' height='22' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'><circle cx='12' cy='12' r='10' stroke='#fff' stroke-width='1.5'/><circle cx='12' cy='4' r='1.2' fill='#fff'/><circle cx='17.7' cy='6.3' r='1.2' fill='#fff'/><circle cx='20' cy='12' r='1.2' fill='#fff'/><circle cx='17.7' cy='17.7' r='1.2' fill='#fff'/><circle cx='12' cy='20' r='1.2' fill='#fff'/><circle cx='6.3' cy='17.7' r='1.2' fill='#fff'/><circle cx='4' cy='12' r='1.2' fill='#fff'/><circle cx='6.3' cy='6.3' r='1.2' fill='#fff'/><circle cx='12' cy='9.5' r='2.5' fill='#fff'/><path d='M8 16.5c0-2.2 1.8-4 4-4s4 1.8 4 4' stroke='#fff' stroke-width='1.5' stroke-linecap='round'/></svg>";
      fab.style.cssText = "width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;pointer-events:auto;background:linear-gradient(135deg,#2d2b55 0%,#5b4f9e 100%);box-shadow:0 4px 18px rgba(91,79,158,.5);display:flex;align-items:center;justify-content:center;transition:box-shadow .15s,transform .12s;flex-shrink:0;";
      fab.onmouseenter = () => { fab.style.boxShadow = "0 6px 24px rgba(91,79,158,.65)"; fab.style.transform = "scale(1.07)"; };
      fab.onmouseleave = () => { fab.style.boxShadow = "0 4px 18px rgba(91,79,158,.5)"; fab.style.transform = "scale(1)"; };

      let menuOpen = false;
      const openMenu = () => {
        menuOpen = true;
        menu.style.opacity = "1";
        menu.style.transform = "translateY(0) scale(1)";
        menu.setAttribute("aria-hidden", "false");
        menu.style.pointerEvents = "auto";
      };
      const closeMenu = () => {
        menuOpen = false;
        menu.style.opacity = "0";
        menu.style.transform = "translateY(12px) scale(.95)";
        menu.setAttribute("aria-hidden", "true");
        menu.style.pointerEvents = "none";
      };
      fab.onclick = (e) => { e.stopPropagation(); menuOpen ? closeMenu() : openMenu(); };
      document.addEventListener("pointerdown", (e) => {
        if (menuOpen && !wrap.contains(e.target)) closeMenu();
      }, true);

      let fabDragMoved = false;
      fab.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        fabDragMoved = false;
        const r0 = wrap.getBoundingClientRect();
        let ox = r0.left, oy = r0.top;
        const mv = (ev) => {
          const dx = ev.clientX - startX, dy = ev.clientY - startY;
          if (!fabDragMoved && Math.sqrt(dx*dx+dy*dy) > 5) {
            fabDragMoved = true; fab.releasePointerCapture(e.pointerId);
            wrap.style.right = "auto"; wrap.style.bottom = "auto";
            wrap.style.left = ox + "px"; wrap.style.top = oy + "px";
          }
          if (!fabDragMoved) return;
          let nx = Math.max(4, Math.min(ox + dx, window.innerWidth  - 54));
          let ny = Math.max(4, Math.min(oy + dy, window.innerHeight - 54));
          wrap.style.left = nx + "px"; wrap.style.top = ny + "px";
        };
        const up = () => {
          window.removeEventListener("pointermove", mv, true);
          window.removeEventListener("pointerup",   up, true);
          if (fabDragMoved) { setTimeout(() => { fabDragMoved = false; }, 10); }
        };
        window.addEventListener("pointermove", mv, true);
        window.addEventListener("pointerup",   up, true);
      }, true);
      fab.addEventListener("click", (e) => { if (fabDragMoved) { e.stopImmediatePropagation(); fabDragMoved = false; } }, true);

      wrap.appendChild(menu);
      wrap.appendChild(fab);
      addFabResizeGuard(wrap);
      document.body.appendChild(wrap);
    }
    ensureDetailLauncher();
    watchNavigation();
  } else if (!/displayType=graph|marketSegmentActivation|\/r\/MarketSegmentActivation|segmentWizard/i.test(window.location.href) && !onQueryEditorPage && !onTransformPage && !onDataModelPage && !onActivationPage) {
    // Only show the mapping launcher/toast on pages where no launcher was already created.
    var hasMappingCanvas = findByTag(TAGGING_CMP).length > 0;
    if (hasMappingCanvas) {
      ensureLauncher();
      updateBadge();
      watchNavigation();
    } else {
      // Retry after 2s — SF lazy-loads LWC components; Data Explorer may not be in DOM yet
      setTimeout(function () {
        if (document.getElementById("dc-bar")) return;
        if ((typeof isDataExplorePage === "function" && isDataExplorePage())) {
          ensureExploreLauncher(); watchNavigation(); return;
        }
        var toast = document.createElement("div");
        toast.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#111827;color:#fff;font:500 13px/1.4 -apple-system,sans-serif;padding:14px 20px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.4);max-width:320px;opacity:0;transition:opacity .3s;";
        toast.innerHTML = "<div style='display:flex;align-items:flex-start;gap:10px;'>" +
          "<span style='font-size:18px;line-height:1;'>&#9432;</span>" +
          "<div><strong style='display:block;margin-bottom:4px;'>Data 360 Inspector</strong>" +
          "<span style='color:#94a3b8;font-size:12px;line-height:1.5;'>This page is not supported. Works on:<br>" +
          "• DLO → DMO Mapping canvas<br>" +
          "• Data Stream / DLO / DMO detail<br>" +
          "• Data Explorer<br>" +
          "• Query Editor<br>" +
          "• Segment builder</span></div></div>";
        document.body.appendChild(toast);
        requestAnimationFrame(function () { toast.style.opacity = "1"; });
        setTimeout(function () { toast.style.opacity = "0"; setTimeout(function () { try { toast.remove(); } catch (e) {} }, 400); }, 6000);
      }, 2000);
    }
  }

  // SAFETY NET: start the SPA navigation watcher unconditionally, regardless of which
  // launcher path ran (or if the FAB was created by a delayed retry/observer). The poll
  // tears the FAB down the instant the URL changes, ending its scope. Idempotent — the
  // `if (navPoll) return` guard makes this a no-op if a branch above already started it.
  // This is the backstop for cases like Data Explorer (#/one.app route) → Data Stream
  // (/lightning/r/…), where the Explorer FAB otherwise lingered because its branch's
  // watcher wasn't active.
  try { watchNavigation(); } catch (e) {}
})();
