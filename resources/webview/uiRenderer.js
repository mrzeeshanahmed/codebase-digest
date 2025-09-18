;(function(){
  'use strict';
  // Ensure a shared lifecycle tracker is available so uiRenderer can register timers/observers
  try {
    if (typeof window !== 'undefined' && !window.__cbd_lifecycle) {
      (function lifecycleTracker(){
        try {
          const timers = new Set();
          const observers = new Set();
          const registerTimer = (t) => { try { if (t) { timers.add(t); } } catch (e) {} };
          const unregisterTimer = (t) => { try { if (t) { timers.delete(t); } } catch (e) {} };
          const registerObserver = (o) => { try { if (o) { observers.add(o); } } catch (e) {} };
          const unregisterObserver = (o) => { try { if (o) { observers.delete(o); } } catch (e) {} };
          const cleanup = () => {
            try { for (const t of Array.from(timers)) { try { clearTimeout(t); } catch (e) {} try { clearInterval(t); } catch (e) {} try { if (typeof t.unref === 'function') { t.unref(); } } catch (e) {} } } catch (e) {}
            try { for (const o of Array.from(observers)) { try { if (o && typeof o.disconnect === 'function') { o.disconnect(); } } catch (e) {} } } catch (e) {}
            try { timers.clear(); observers.clear(); } catch (e) {}
          };
          window.__cbd_lifecycle = Object.assign({}, { registerTimer, unregisterTimer, registerObserver, unregisterObserver, cleanup });
          try { window.addEventListener && window.addEventListener('unload', cleanup); } catch (e) {}
        } catch (e) {}
      })();
    }
  } catch (e) {}
  // Helpers to register/unregister timers and observers with the lifecycle tracker
  function _registerTimerHandle(t) {
    try {
      if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.registerTimer === 'function') {
        window.__cbd_lifecycle.registerTimer(t);
      }
    } catch (e) {}
  }
  function _unregisterTimerHandle(t) {
    try {
      if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.unregisterTimer === 'function') {
        window.__cbd_lifecycle.unregisterTimer(t);
      }
    } catch (e) {}
  }
  function _registerObserver(o) {
    try {
      if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.registerObserver === 'function') {
        window.__cbd_lifecycle.registerObserver(o);
      }
    } catch (e) {}
  }
  function _unregisterObserver(o) {
    try {
      if (typeof window !== 'undefined' && window.__cbd_lifecycle && typeof window.__cbd_lifecycle.unregisterObserver === 'function') {
        window.__cbd_lifecycle.unregisterObserver(o);
      }
    } catch (e) {}
  }
  // Minimal UI renderer: subscribes to the centralized store and performs DOM updates.
  // Designed to be safe in JSDOM (no throw when elements are missing) and to replace
  // small inline scripts formerly embedded directly in index.html.

  function safe(fn) { return function(){ try { return fn.apply(null, arguments); } catch (e) { console && console.warn && console.warn('uiRenderer error', e); } }; }

  function getNode(id) { try { return (typeof window !== 'undefined' && window.__CBD_NODES__ && typeof window.__CBD_NODES__.getById === 'function') ? window.__CBD_NODES__.getById(id) : (typeof document !== 'undefined' ? document.getElementById(id) : null); } catch (e) { return null; } }

  // Preset menu behaviour that used to be inline in index.html
  function wirePresetMenu() {
    const btn = getNode('preset-btn');
    const menu = getNode('preset-menu');
    if (!menu) { return; }
    // Normalize initial aria-hidden
    try { if (menu.hasAttribute('hidden')) { menu.setAttribute('aria-hidden','true'); } else { menu.setAttribute('aria-hidden','false'); } } catch (e) {}

    function togglePresetMenu() {
      try {
        if (menu.hasAttribute('hidden')) { menu.removeAttribute('hidden'); menu.setAttribute('aria-hidden','false'); btn && btn.setAttribute('aria-expanded','true'); }
        else { menu.setAttribute('hidden',''); menu.setAttribute('aria-hidden','true'); btn && btn.setAttribute('aria-expanded','false'); }
      } catch (e) {}
    }

    if (btn && !btn.__cbd_wired__) {
      btn.addEventListener('click', (e) => { try { e.preventDefault(); togglePresetMenu(); } catch (ex) {} });
      btn.__cbd_wired__ = true;
    }

    // Keep aria-hidden in sync if other code toggles hidden
    try {
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.attributeName === 'hidden') {
            try {
              if (menu.hasAttribute('hidden')) { if (menu.getAttribute('aria-hidden') !== 'true') { menu.setAttribute('aria-hidden','true'); } btn && btn.setAttribute('aria-expanded','false'); }
              else { if (menu.getAttribute('aria-hidden') !== 'false') { menu.setAttribute('aria-hidden','false'); } btn && btn.setAttribute('aria-expanded','true'); }
            } catch (e) {}
          }
        }
      });
      obs.observe(menu, { attributes: true, attributeFilter: ['hidden'] });
      _registerObserver(obs);
    } catch (e) {}

    // Close on escape and outside click
    document.addEventListener('keydown', (ev) => { try { if (ev.key === 'Escape' && !menu.hasAttribute('hidden')) { menu.setAttribute('hidden',''); menu.setAttribute('aria-hidden','true'); btn && btn.setAttribute('aria-expanded','false'); } } catch (e) {} });
    document.addEventListener('click', (ev) => { try { if (!menu.contains(ev.target) && ev.target !== btn && !menu.hasAttribute('hidden')) { menu.setAttribute('hidden',''); menu.setAttribute('aria-hidden','true'); btn && btn.setAttribute('aria-expanded','false'); } } catch (e) {} });
  }

  // Render functions for small UI pieces
  const renderPreview = safe((payload) => {
    const previewRoot = getNode('ingest-preview');
    const textEl = getNode('ingest-preview-text');
    const spinner = getNode('ingest-spinner');
    try {
      if (previewRoot) { previewRoot.classList.remove('loading'); }
      if (spinner) { spinner.hidden = true; spinner.setAttribute && spinner.setAttribute('aria-hidden','true'); }
      if (textEl) {
        const p = payload && payload.preview;
        if (p) { textEl.textContent = (p.summary || '') + '\n\n' + (p.tree || ''); }
        else if (payload && payload.output) { textEl.textContent = String(payload.output).slice(0, 2000); }
        else { textEl.textContent = 'No preview available'; }
      }
    } catch (e) { /* swallow */ }
  });

  const renderProgress = safe((loading) => {
    const container = getNode('progress-container');
    const bar = getNode('progress-bar');
    try {
      if (loading && Object.keys(loading).length > 0) { container && container.classList.remove('hidden'); }
      else { container && container.classList.add('hidden'); }
      // If any op has percent, show the first percent found
      if (bar && loading) {
        const keys = Object.keys(loading || {});
        if (keys.length > 0) { /* keep percent update to subscribers that set percent on loading.op */ }
      }
    } catch (e) {}
  });

  // Small helpers reused by renderers
  function formatBytes(n) {
    if (n === undefined || n === null) { return ''; }
    const num = Number(n) || 0;
    if (num < 1024) { return `${num} B`; }
    if (num < 1024 * 1024) { return `${(num / 1024).toFixed(1)} KB`; }
    if (num < 1024 * 1024 * 1024) { return `${(num / (1024 * 1024)).toFixed(1)} MB`; }
    return `${(num / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function encodeForDataAttribute(s) {
    if (s === null || s === undefined) { return ''; }
    try {
      const b = btoa(unescape(encodeURIComponent(String(s))));
      return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    } catch (e) {
      try { return encodeURIComponent(String(s)); } catch (ex) { return String(s); }
    }
  }

  function decodeFromDataAttribute(v) {
    if (!v) { return ''; }
    try {
      const pad = v.length % 4 === 0 ? '' : '='.repeat(4 - (v.length % 4));
      const b = (v || '').replace(/-/g, '+').replace(/_/g, '/') + pad;
      return decodeURIComponent(escape(atob(b)));
    } catch (e) {
      try { return decodeURIComponent(String(v)); } catch (ex) { return String(v); }
    }
  }

  // Render functions for small UI pieces
  const renderPreviewDelta = safe((delta) => {
    const statsTarget = getNode('stats');
    const chipsTarget = getNode('status-chips');
    if (statsTarget === null && chipsTarget === null) { return; }
    try {
      const fmtSize = formatBytes;
      const parts = [];
      if (delta && delta.selectedCount !== undefined && delta.selectedCount !== null) { parts.push(`${delta.selectedCount} selected`); }
      if (delta && delta.totalFiles !== undefined && delta.totalFiles !== null) { parts.push(`${delta.totalFiles} files`); }
      if (delta && delta.selectedSize !== undefined && delta.selectedSize !== null) { parts.push(fmtSize(delta.selectedSize)); }
      if (delta && delta.tokenEstimate !== undefined && delta.tokenEstimate !== null) { parts.push(`${Math.round(delta.tokenEstimate)} tokens`); }
      if (statsTarget !== null) { statsTarget.textContent = parts.join(' · '); }

      if (chipsTarget !== null) {
        const chips = [];
        if (delta && delta.selectedCount !== undefined && delta.selectedCount !== null) { chips.push({ label: 'Selected', value: String(delta.selectedCount) }); }
        if (delta && delta.totalFiles !== undefined && delta.totalFiles !== null) { chips.push({ label: 'Files', value: String(delta.totalFiles) }); }
        if (delta && delta.selectedSize !== undefined && delta.selectedSize !== null) { chips.push({ label: 'Size', value: fmtSize(delta.selectedSize) }); }
        if (delta && delta.tokenEstimate !== undefined && delta.tokenEstimate !== null) { chips.push({ label: 'Tokens', value: String(Math.round(delta.tokenEstimate)) }); }

        const overLimit = delta && delta.tokenEstimate !== undefined && delta.contextLimit !== undefined && delta.tokenEstimate > delta.contextLimit;
        while (chipsTarget.firstChild) { chipsTarget.removeChild(chipsTarget.firstChild); }
        for (let i = 0; i < chips.length; i++) {
          const c = chips[i];
          const chip = document.createElement('div');
          chip.className = 'status-chip' + (overLimit ? ' over-limit' : '');
          const lab = document.createElement('span'); lab.className = 'label'; lab.textContent = c.label;
          const val = document.createElement('span'); val.className = 'value'; val.textContent = c.value;
          chip.appendChild(lab); chip.appendChild(val);
          chipsTarget.appendChild(chip);
        }

        try {
          const bannerId = 'over-limit-banner';
          let banner = document.getElementById(bannerId);
          if (overLimit) {
            const message = 'Token estimate exceeds configured context limit — output may be truncated or incomplete.';
            if (!banner) {
              banner = document.createElement('div');
              banner.id = bannerId;
              banner.className = 'over-limit-banner';
              banner.setAttribute('role', 'status');
              banner.setAttribute('aria-live', 'assertive');
              banner.setAttribute('aria-atomic', 'true');
              const text = document.createElement('span'); text.className = 'over-limit-text'; banner.appendChild(text);
              try { if (chipsTarget && chipsTarget.parentNode) { chipsTarget.parentNode.insertBefore(banner, chipsTarget); } else { document.body.insertBefore(banner, document.body.firstChild); } } catch (e) {}
            } else {
              try { if (chipsTarget && chipsTarget.parentNode && banner.parentNode !== chipsTarget.parentNode) { if (banner.parentNode) { banner.parentNode.removeChild(banner); } chipsTarget.parentNode.insertBefore(banner, chipsTarget); } } catch (e) {}
            }
            try { const txt = banner.querySelector('.over-limit-text'); if (txt) { txt.textContent = message; } } catch (e) {}
          } else {
            try { if (banner && banner.parentNode) { banner.parentNode.removeChild(banner); } } catch (e) {}
          }
        } catch (e) { /* swallow */ }
      }
    } catch (e) { /* swallow DOM errors */ }
  });

  const showToast = safe((msg, kind='info', ttl=4000) => {
    try {
      const root = getNode('toast-root');
      if (!root) { return; }
      const t = document.createElement('div');
      t.className = `toast ${kind}`;
      const m = document.createElement('div'); m.className = 'msg'; m.textContent = msg; t.appendChild(m);
  root.appendChild(t);
  try { var __cbd_to1 = setTimeout(() => { try { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; } finally { _unregisterTimerHandle(__cbd_to1); } }, ttl - 300); _registerTimerHandle(__cbd_to1); if (__cbd_to1 && typeof __cbd_to1.unref === 'function') { try { __cbd_to1.unref(); } catch (e) {} } } catch (e) {}
  try { var __cbd_to2 = setTimeout(() => { try { t.remove(); } catch (e) {} finally { _unregisterTimerHandle(__cbd_to2); } }, ttl); _registerTimerHandle(__cbd_to2); if (__cbd_to2 && typeof __cbd_to2.unref === 'function') { try { __cbd_to2.unref(); } catch (e) {} } } catch (e) {}
    } catch (e) { /* swallow */ }
  });

  const updatePauseButton = safe((paused) => {
    try {
      const b = getNode('btn-pause-resume') || getNode('pause-btn') || document.getElementById('btn-pause-resume');
      if (!b) { return; }
      try {
        let label = b.querySelector('.pause-label');
        if (!label) {
          label = document.createElement('span');
          label.className = 'pause-label';
          b.appendChild(label);
        }
        label.textContent = paused ? 'Resume' : 'Pause';
        try { b.setAttribute('aria-label', paused ? 'Resume' : 'Pause'); } catch (e) {}
      } catch (e) { try { b.textContent = paused ? 'Resume' : 'Pause'; } catch (ex) {} }
      try { b.setAttribute('aria-pressed', String(!!paused)); } catch (e) {}
      try { b.classList.toggle('paused', !!paused); } catch (e) {}
    } catch (e) { /* swallow */ }
  });

  // Render the file tree and list. This mirrors the behavior in main.js but
  // keeps DOM mutations centralized here. Selection changes are applied to
  // the store optimistically and also emitted via a CustomEvent so the
  // host-posting logic in main.js can forward sanitized actions.
  const renderFileList = safe((state) => {
    try {
      if (!state) { try { state = window.store && window.store.getState ? window.store.getState() : { fileTree: {}, selectedPaths: [] }; } catch (e) { state = { fileTree: {}, selectedPaths: [] }; } }
      const fileListRoot = getNode('file-list');
      if (!fileListRoot) { return; }
      // Clear previous content safely
      while (fileListRoot.firstChild) { fileListRoot.removeChild(fileListRoot.firstChild); }
      const fileTree = state.fileTree || {};
      const selectedPaths = new Set(state.selectedPaths || []);
      if (Object.keys(fileTree).length === 0) {
        const msg = document.createElement('div');
        msg.className = 'file-row-message';
        msg.textContent = 'No files to display.';
        fileListRoot.appendChild(msg);
        return;
      }

      function dispatchSelection(relPaths) {
        try {
          // optimistic local update
          try { window.store && window.store.setSelection && window.store.setSelection(relPaths); } catch (e) {}
          // emit event for main.js to postAction => host
          try { window.dispatchEvent(new CustomEvent('cbd:setSelection', { detail: { relPaths } })); } catch (e) {}
        } catch (e) { /* swallow */ }
      }

      function updateAncestorStates(startLi) {
        try {
          let current = startLi;
          while (current) {
            const parentUl = current.parentElement;
            if (!parentUl) { break; }
            const parentLi = parentUl.closest('li.folder-item');
            if (!parentLi) { break; }
            const descendantCheckboxes = parentLi.querySelectorAll(':scope ul li.file-item .file-checkbox');
            let total = 0, checked = 0;
            descendantCheckboxes.forEach(cb => { total++; if (cb.checked) { checked++; } });
            const parentCb = parentLi.querySelector('input.file-checkbox');
            if (parentCb) {
              if (checked === 0) { parentCb.checked = false; parentCb.indeterminate = false; }
              else if (checked === total) { parentCb.checked = true; parentCb.indeterminate = false; }
              else { parentCb.checked = false; parentCb.indeterminate = true; }
            }
            current = parentLi;
          }
        } catch (e) { /* swallow */ }
      }

      function createTreeHtml(node, pathPrefix = '') {
        const ul = document.createElement('ul'); ul.className = 'file-tree-ul';
        const entries = Object.keys(node).sort((a, b) => {
          const aIsFile = node[a].__isFile; const bIsFile = node[b].__isFile;
          if (aIsFile && !bIsFile) { return 1; }
          if (!aIsFile && bIsFile) { return -1; }
          return a.localeCompare(b);
        });
        for (const key of entries) {
          const currentNode = node[key];
          const isFile = !!currentNode.__isFile;
          const relPath = currentNode.relPath || currentNode.path || `${pathPrefix}${key}`;
          const li = document.createElement('li');
          li.className = isFile ? 'file-tree-li file-item' : 'file-tree-li folder-item';
          li.setAttribute('data-path', encodeForDataAttribute(relPath));

          const label = document.createElement('label'); label.className = 'file-tree-label';
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'file-checkbox';
          checkbox.checked = selectedPaths.has(relPath);
          checkbox.setAttribute('data-path', encodeForDataAttribute(relPath));

          checkbox.addEventListener('change', () => {
            try {
              const isChecked = checkbox.checked;
              if (!isFile) {
                const descendantCheckboxes = li.querySelectorAll(':scope ul li.file-item .file-checkbox');
                descendantCheckboxes.forEach(descCb => { descCb.checked = isChecked; try { descCb.indeterminate = false; } catch (e) {} });
              }
              try { updateAncestorStates(li); } catch (e) {}
              // collect selected leaf file paths
              const cbs = fileListRoot.querySelectorAll('li.file-item .file-checkbox');
              const newSelected = [];
              cbs.forEach(cb => { if (cb.checked) { try { const a = cb.getAttribute && cb.getAttribute('data-path'); const p = a ? decodeFromDataAttribute(a) : null; if (p) { newSelected.push(p); } } catch (e) {} } });
              dispatchSelection(newSelected);
            } catch (e) { /* swallow */ }
          });

          const icon = document.createElement('span'); icon.className = 'file-tree-icon';
          const name = document.createElement('span'); name.className = 'file-tree-name'; name.textContent = key;

          if (!isFile) {
            // expanded state from store
            const expandedArr = (window.store && window.store.getState && Array.isArray(window.store.getState().expandedPaths)) ? window.store.getState().expandedPaths : [];
            const expanded = new Set(expandedArr).has(relPath);
            if (expanded) { li.classList.add('expanded'); } else { li.classList.remove('expanded'); }
            const toggleExpand = (e) => {
              try {
                const st = window.store && window.store.getState ? window.store.getState() : {};
                const curSet = new Set(Array.isArray(st.expandedPaths) ? st.expandedPaths : []);
                if (curSet.has(relPath)) { curSet.delete(relPath); li.classList.remove('expanded'); }
                else { curSet.add(relPath); li.classList.add('expanded'); }
                try { window.store && window.store.setExpandedPaths && window.store.setExpandedPaths(Array.from(curSet)); } catch (e) {}
                // re-render tree after update
                try { renderTree(window.store && window.store.getState ? window.store.getState() : null, curSet); } catch (e) {}
              } catch (err) { /* swallow */ }
            };
            try { icon.setAttribute('role','button'); icon.setAttribute('tabindex','0'); try { icon.setAttribute('aria-expanded', String(expanded)); } catch (e) {} } catch (e) {}
            label.addEventListener('click', (ev) => { try { if (ev && ev.target && (ev.target === icon || icon.contains(ev.target))) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} toggleExpand(); try { icon.setAttribute('aria-expanded', String((window.store && window.store.getState && Array.isArray(window.store.getState().expandedPaths)) ? new Set(window.store.getState().expandedPaths).has(relPath) : false)); } catch (e) {} } } catch (e) {} }, true);
            icon.addEventListener('keydown', (ev) => { try { if (ev.key === 'Enter' || ev.key === ' ') { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} toggleExpand(); try { icon.setAttribute('aria-expanded', String((window.store && window.store.getState && Array.isArray(window.store.getState().expandedPaths)) ? new Set(window.store.getState().expandedPaths).has(relPath) : false)); } catch (e) {} } } catch (e) {} });
          }

          label.appendChild(checkbox); label.appendChild(icon); label.appendChild(name); li.appendChild(label);
          if (!isFile) { li.appendChild(createTreeHtml(currentNode, `${relPath}/`)); }
          ul.appendChild(li);
        }
        return ul;
      }

      fileListRoot.appendChild(createTreeHtml(fileTree));
      // restore expanded state
      try {
        const st = window.store && window.store.getState ? window.store.getState() : {};
        const expandedSet = new Set(Array.isArray(st.expandedPaths) ? st.expandedPaths : []);
        if (expandedSet.size > 0) { expandedSet.forEach(p => { try { const li = fileListRoot.querySelector && fileListRoot.querySelector(`li[data-path="${encodeForDataAttribute(p)}"]`); if (li) { li.classList.add('expanded'); } } catch (e) {} }); }
      } catch (e) {}

      // folder tri-state
      try {
        const folderItems = fileListRoot.querySelectorAll('li.folder-item');
        folderItems.forEach(fi => {
          try {
            const descendantCheckboxes = fi.querySelectorAll(':scope ul li.file-item .file-checkbox');
            let total = 0, checked = 0;
            descendantCheckboxes.forEach(cb => { total++; if (cb.checked) { checked++; } });
            const parentCb = fi.querySelector('input.file-checkbox');
            if (parentCb) {
              if (checked === 0) { parentCb.checked = false; parentCb.indeterminate = false; }
              else if (checked === total) { parentCb.checked = true; parentCb.indeterminate = false; }
              else { parentCb.checked = false; parentCb.indeterminate = true; }
            }
          } catch (e) {}
        });
      } catch (e) {}
    } catch (e) { /* swallow top-level */ }
  });

  const renderTree = safe((state, newExpandedSet) => {
    try {
      if (newExpandedSet) {
        try {
          if (Array.isArray(newExpandedSet)) { try { window.store && window.store.setExpandedPaths && window.store.setExpandedPaths(Array.from(newExpandedSet)); } catch (e) {} }
          else if (newExpandedSet instanceof Set) { try { window.store && window.store.setExpandedPaths && window.store.setExpandedPaths(Array.from(newExpandedSet)); } catch (e) {} }
        } catch (e) {}
      }
      // immediate render for responsiveness
      renderFileList(state);
    } catch (e) { /* swallow */ }
  });

  // Top-level initialization: wire preset menu and subscribe to store
  function init() {
    try {
      if (typeof window === 'undefined') { return; }
  // Expose an API object so other modules can safely delegate DOM work to this renderer.
  // Keep backward compatibility: truthy value plus an object surface.
  window.__UI_RENDERER__ = window.__UI_RENDERER__ || {};
  Object.assign(window.__UI_RENDERER__, { renderPreview, renderProgress, renderPreviewDelta, showToast, updatePauseButton, renderFileList, renderTree });
  // Helper: applyPreset delegates to renderer-level logic: update visual selection and
  // compute aligned view via existing applyPreset function when available on window.
  const applyPreset = safe((preset) => {
    try {
      // update visual state
      try { if (preset) { window.__UI_RENDERER__ && window.__UI_RENDERER__.togglePresetSelectionUI && window.__UI_RENDERER__.togglePresetSelectionUI(preset); } else { window.__UI_RENDERER__ && window.__UI_RENDERER__.togglePresetSelectionUI && window.__UI_RENDERER__.togglePresetSelectionUI(null); } } catch (e) {}
      // If a global applyPreset transform exists (legacy), call it to compute aligned state
      if (typeof window.applyPreset === 'function') {
        try {
          const st = window.store && window.store.getState ? window.store.getState() : {};
          const files = st && st.fileTree ? st.fileTree : {};
          const aligned = window.applyPreset(preset, files);
          try { window.store && window.store.setState && window.store.setState({ aligned }); } catch (e) {}
          try { window.__UI_RENDERER__ && window.__UI_RENDERER__.renderTree && window.__UI_RENDERER__.renderTree(aligned, (window.store && window.store.getState ? new Set(window.store.getState().expandedPaths || []) : new Set())); } catch (e) {}
        } catch (e) { /* ignore transform errors */ }
      }
    } catch (e) { /* swallow */ }
  });

  // Update ingest preview UI (spinner/text)
  const setIngestPreviewState = safe(({ loading = false, text = null } = {}) => {
    try {
      const root = getNode('ingest-preview');
      const spinner = getNode('ingest-spinner');
      const textEl = getNode('ingest-preview-text');
      if (loading) {
        if (root) { root.classList.add('loading'); }
        if (spinner) { spinner.hidden = false; try { spinner.removeAttribute && spinner.removeAttribute('aria-hidden'); } catch (e) {} }
        if (textEl && typeof text === 'string') { textEl.textContent = text; textEl.classList.add('loading-placeholder'); }
      } else {
        if (root) { root.classList.remove('loading'); }
        if (spinner) { spinner.hidden = true; try { spinner.setAttribute && spinner.setAttribute('aria-hidden', 'true'); } catch (e) {} }
        if (textEl && typeof text === 'string') { textEl.textContent = text; textEl.classList.remove('loading-placeholder'); }
      }
    } catch (e) { /* swallow */ }
  });

  // Render scan stats into the small stats area
  const renderScanStats = safe((e) => {
    try {
      if (!e || e.op !== 'scan') { return; }
      const statsEl = getNode('stats');
      if (!statsEl) { return; }
      const parts = [];
      if (typeof e.totalFiles === 'number') { parts.push(`Scanned: ${e.totalFiles}`); }
      if (typeof e.totalSize === 'number') { parts.push(`Size: ${formatBytes(e.totalSize)}`); }
      statsEl.textContent = parts.join(' · ');
      const progressStats = document.querySelector('.progress-stats');
      if (progressStats) {
        const pParts = [];
        if (typeof e.totalFiles === 'number') { pParts.push(`${e.totalFiles} files`); }
        if (typeof e.totalSize === 'number') { pParts.push(formatBytes(e.totalSize)); }
        if (typeof e.tokenEstimate === 'number') { pParts.push(`~${Math.round(e.tokenEstimate)} tokens`); }
        progressStats.textContent = pParts.join(' · ');
      }
    } catch (err) { /* swallow */ }
  });

  // Select all / clear selection helpers operate on the store and emit selection events
  const selectAll = safe(() => {
    try {
      const st = window.store && window.store.getState ? window.store.getState() : null;
      if (st && st.fileTree) {
        const all = (function collect(node, prefix=''){
          const out = [];
          if (!node || typeof node !== 'object') { return out; }
          for (const k of Object.keys(node)) {
            const n = node[k];
            const full = n && n.path ? n.path : `${prefix}${k}`;
            if (n && n.__isFile) { out.push(full); }
            else { out.push(...collect(n, `${full}/`)); }
          }
          return out;
        })(st.fileTree);
        try { window.store && window.store.setSelection && window.store.setSelection(all); } catch (e) {}
        try { window.dispatchEvent(new CustomEvent('cbd:setSelection', { detail: { relPaths: all } })); } catch (e) {}
      }
    } catch (e) { /* swallow */ }
  });

  const clearSelection = safe(() => {
    try { window.store && window.store.clearSelection && window.store.clearSelection(); try { window.dispatchEvent(new CustomEvent('cbd:setSelection', { detail: { relPaths: [] } })); } catch (e) {} } catch (e) {}
  });

  // Expand / collapse helpers update store.expandedPaths
  const expandAll = safe(() => {
    try {
      const st = window.store && window.store.getState ? window.store.getState() : null;
      if (!st || !st.fileTree) { return; }
      const allFolders = [];
      (function walk(node, prefix=''){
        for (const k of Object.keys(node || {})) {
          const n = node[k];
          const rel = n && n.relPath ? n.relPath : (n && n.path ? n.path : `${prefix}${k}`);
          if (n && n.__isFile) { continue; }
          allFolders.push(rel);
          walk(n, `${rel}/`);
        }
      })(st.fileTree, '');
      try { allFolders.forEach(p => {}); window.store && window.store.setExpandedPaths && window.store.setExpandedPaths(allFolders); } catch (e) {}
    } catch (e) { /* swallow */ }
  });

  const collapseAll = safe(() => {
    try { window.store && window.store.setExpandedPaths && window.store.setExpandedPaths([]); } catch (e) {}
  });
  // Toggle visual selection state for preset buttons/menu items in the UI.
  const togglePresetSelectionUI = safe((presetName) => {
    try {
      const buttons = document.querySelectorAll('[data-action="applyPreset"], [role="option"][data-preset]');
      buttons.forEach(b => { try { b.classList.remove('selected'); b.removeAttribute('aria-pressed'); } catch (e) {} });
      if (!presetName) { return; }
      const selector = `[data-action="applyPreset"][data-preset="${presetName}"], [role="option"][data-preset="${presetName}"]`;
      const matches = document.querySelectorAll(selector);
      matches.forEach(m => { try { m.classList.add('selected'); m.setAttribute('aria-pressed', 'true'); } catch (e) {} });
    } catch (e) { /* swallow */ }
  });

  // Populate redaction-specific fields; separated so it can be called independently
  const populateRedactionFields = safe((settings) => {
    try {
      const form = getNode('settingsForm');
      if (!form) { return; }
      const getEl = (name) => form.querySelector(`[name="${name}"]`);
      const showRedactedEl = getEl('showRedacted');
      const redactionPatternsEl = getEl('redactionPatterns');
      const redactionPlaceholderEl = getEl('redactionPlaceholder');
      if (showRedactedEl) { showRedactedEl.checked = !!settings.showRedacted; }
      if (redactionPatternsEl) {
        if (Array.isArray(settings.redactionPatterns)) { redactionPatternsEl.value = settings.redactionPatterns.join('\n'); }
        else if (typeof settings.redactionPatterns === 'string') { redactionPatternsEl.value = settings.redactionPatterns; }
        else { redactionPatternsEl.value = ''; }
      }
      if (redactionPlaceholderEl) { redactionPlaceholderEl.value = settings.redactionPlaceholder || ''; }
    } catch (e) { /* swallow */ }
  });

  Object.assign(window.__UI_RENDERER__, { populateSettings, togglePresetSelectionUI, populateRedactionFields, applyPreset, setIngestPreviewState, renderScanStats, selectAll, clearSelection, expandAll, collapseAll });
  // Populate settings form fields (DOM writes only). Does not wire save/cancel handlers
  const populateSettings = safe((settings) => {
    try {
      const form = getNode('settingsForm');
      if (!form) { return; }
      const getEl = (name) => form.querySelector(`[name="${name}"]`);
      // gitignore/respectGitignore
      const gitignoreEl = getEl('gitignore');
      const respectGitignoreVal = (typeof settings.respectGitignore !== 'undefined') ? settings.respectGitignore : settings.gitignore;
      if (gitignoreEl) { gitignoreEl.checked = !!respectGitignoreVal; }
      const outEl = getEl('outputFormat'); if (outEl) { outEl.value = settings.outputFormat || 'text'; }
      const modelEl = getEl('tokenModel');
      if (modelEl) {
        try {
          const existingOptions = Array.from(modelEl.querySelectorAll('option')).map((opt, idx) => ({ value: opt.value, text: (opt.textContent || opt.innerText || opt.value), index: idx }));
          function parseContext(s) {
            if (!s) { return null; }
            try {
              const str = String(s);
              const m = str.match(/(\d+)([kKmM])?/);
              if (!m) { return null; }
              const n = Number(m[1]); if (Number.isNaN(n)) { return null; }
              const unit = m[2] ? m[2].toLowerCase() : '';
              const value = unit === 'k' ? n * 1000 : unit === 'm' ? n * 1000000 : n;
              const raw = unit ? `${m[1]}${unit}` : `${m[1]}`;
              return { raw, value };
            } catch (e) { return null; }
          }
          const enriched = existingOptions.map(o => {
            const metaValue = (o.value && MODEL_CONTEXT_MAP && MODEL_CONTEXT_MAP[o.value]) ? MODEL_CONTEXT_MAP[o.value] : null;
            if (metaValue) { return Object.assign({}, o, { contextRaw: String(metaValue), contextValue: Number(metaValue) }); }
            const byVal = parseContext(o.value);
            const byText = parseContext(o.text);
            const ctx = byVal || byText || null;
            return Object.assign({}, o, { contextRaw: ctx ? ctx.raw : null, contextValue: ctx ? ctx.value : 0 });
          });
          enriched.sort((a, b) => { if (a.contextValue !== b.contextValue) { return b.contextValue - a.contextValue; } return a.index - b.index; });
          while (modelEl.firstChild) { modelEl.removeChild(modelEl.firstChild); }
          enriched.forEach(o => { const opt = document.createElement('option'); opt.value = o.value; const modelName = o.text || o.value; opt.textContent = o.contextRaw ? `${o.contextRaw} — ${modelName}` : modelName; modelEl.appendChild(opt); });
          const desired = settings.tokenModel || 'chars-approx';
          const found = Array.from(modelEl.options).some(opt => opt.value === desired);
          modelEl.value = found ? desired : (modelEl.options[0] && modelEl.options[0].value) || desired;
        } catch (e) { try { modelEl.value = settings.tokenModel || 'chars-approx'; } catch (ex) {} }
      }
      const binEl = getEl('binaryPolicy'); const binaryFilePolicyVal = (settings.binaryFilePolicy !== undefined) ? settings.binaryFilePolicy : settings.binaryPolicy; if (binEl) { binEl.value = binaryFilePolicyVal || 'skip'; }
      const maxFilesNumber = getNode('maxFilesNumber');
      const maxFilesRange = getNode('maxFilesRange');
      const maxTotalSizeNumber = getNode('maxTotalSizeNumber');
      const maxTotalSizeRange = getNode('maxTotalSizeRange');
      const tokenLimitNumber = getNode('tokenLimitNumber');
      const tokenLimitRange = getNode('tokenLimitRange');
      const defaults = { maxFiles: 25000, maxTotalSizeBytes: 536870912, tokenLimit: 32000 };
      const cfgThresholds = settings.thresholds || {};
      const maxFilesVal = (typeof settings.maxFiles !== 'undefined') ? settings.maxFiles : (cfgThresholds.maxFiles || defaults.maxFiles);
      const maxTotalSizeVal = (typeof settings.maxTotalSizeBytes !== 'undefined') ? settings.maxTotalSizeBytes : (cfgThresholds.maxTotalSizeBytes || defaults.maxTotalSizeBytes);
      const tokenLimitVal = (typeof settings.tokenLimit !== 'undefined') ? settings.tokenLimit : (cfgThresholds.tokenLimit || defaults.tokenLimit);
      if (maxFilesNumber) { try { maxFilesNumber.value = String(maxFilesVal); } catch (e) {} }
      if (maxFilesRange) { try { maxFilesRange.value = String(Math.max(100, Math.min(50000, maxFilesVal))); } catch (e) {} }
      if (maxTotalSizeNumber) { try { maxTotalSizeNumber.value = String(Math.max(1, Math.round(maxTotalSizeVal / (1024 * 1024)))); } catch (e) {} }
      if (maxTotalSizeRange) { try { maxTotalSizeRange.value = String(Math.max(1, Math.min(4096, Math.round(maxTotalSizeVal / (1024 * 1024))))); } catch (e) {} }
      if (tokenLimitNumber) { try { tokenLimitNumber.value = String(tokenLimitVal); } catch (e) {} }
      if (tokenLimitRange) { try { tokenLimitRange.value = String(Math.max(256, Math.min(200000, tokenLimitVal))); } catch (e) {} }
      const presetsEl = getEl('presets'); if (presetsEl) { try { presetsEl.value = Array.isArray(settings.presets) ? settings.presets.join(',') : (settings.presets || ''); } catch (e) {} }
      // Populate redaction-specific fields
      try {
        const showRedactedEl = getEl('showRedacted'); const redactionPatternsEl = getEl('redactionPatterns'); const redactionPlaceholderEl = getEl('redactionPlaceholder');
        if (showRedactedEl) { showRedactedEl.checked = !!settings.showRedacted; }
        if (redactionPatternsEl) {
          if (Array.isArray(settings.redactionPatterns)) { redactionPatternsEl.value = settings.redactionPatterns.join('\n'); }
          else if (typeof settings.redactionPatterns === 'string') { redactionPatternsEl.value = settings.redactionPatterns; }
          else { redactionPatternsEl.value = ''; }
        }
        if (redactionPlaceholderEl) { redactionPlaceholderEl.value = settings.redactionPlaceholder || ''; }
      } catch (e) {}
      // Wire slider <-> number sync (DOM-only wiring, no save handler)
      function wireRangeNumber(rangeEl, numberEl, toNumber = (v)=>v, fromNumber = (v)=>v) {
        if (!rangeEl || !numberEl) { return; }
        try { rangeEl.addEventListener('input', () => { try { numberEl.value = String(fromNumber(Number(rangeEl.value))); } catch (e) {} }); } catch (e) {}
        try { numberEl.addEventListener('change', () => { try { const nv = Number(numberEl.value) || 0; rangeEl.value = String(toNumber(nv)); } catch (e) {} }); } catch (e) {}
      }
      try { wireRangeNumber(maxFilesRange, maxFilesNumber, v=>Math.max(100, Math.min(50000, v)), v=>Math.max(100, Math.min(50000, v))); } catch (e) {}
      try { wireRangeNumber(maxTotalSizeRange, maxTotalSizeNumber, v => Math.max(1, Math.min(4096, v)), v => Math.max(1, Math.min(4096, v))); } catch (e) {}
      try { wireRangeNumber(tokenLimitRange, tokenLimitNumber, v=>Math.max(256, Math.min(200000, v)), v=>Math.max(256, Math.min(200000, v))); } catch (e) {}
    } catch (e) { /* swallow */ }
  });
  Object.assign(window.__UI_RENDERER__, { populateSettings });
      wirePresetMenu();
      const s = window.store && typeof window.store.subscribe === 'function' ? window.store : null;
      if (!s) { return; }
      let last = Object.assign({}, s.getState());
      s.subscribe((st) => {
        try {
          if (st.preview !== last.preview) { renderPreview(st.preview); }
          if (st.loading !== last.loading) { renderProgress(st.loading || {}); }
          if (st.previewDelta !== last.previewDelta) { renderPreviewDelta(st.previewDelta || {}); }
          // toasts/errors are surfaced by subscribers.js normally; keep compatibility
          last = Object.assign({}, st);
        } catch (e) { console && console.warn && console.warn('uiRenderer subscriber failed', e); }
      });
    } catch (e) { console && console.warn && console.warn('uiRenderer init failed', e); }
  }

  // Auto-init on load
  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
  else { try { var __cbd_init_to = setTimeout(init, 0); _registerTimerHandle(__cbd_init_to); if (__cbd_init_to && typeof __cbd_init_to.unref === 'function') { try { __cbd_init_to.unref(); } catch (e) {} } try { /* ensure we unregister when it runs */ } catch (e) {} } catch (e) {} }
  }

})();
