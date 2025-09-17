;(function () {
  'use strict';
  if (typeof window === 'undefined') { return; }

  /**
   * Handle `config` messages delivering workspace or folder settings.
   *
   * Expected message shape:
   * { type: 'config', folderPath?: string, workspaceFolder?: string, settings: Object }
   *
   * Side effects:
   * - updates `window.currentFolderPath` for context
   * - writes `settings` into `window.store` via `setState({ settings })`
   * - optionally calls UI helpers to populate settings and active preset UI
   *
   * @param {{type?:string, folderPath?:string, workspaceFolder?:string, settings?:Object}} msg
   */
  var configHandler = function (msg) {
    try {
      try { window.currentFolderPath = msg.folderPath || msg.workspaceFolder || window.currentFolderPath; } catch (e) {}
      // Push settings into store so subscribers can populate settings UI
      try { if (window.store && typeof window.store.setState === 'function') { window.store.setState({ settings: msg.settings || {} }); } } catch (e) { console.warn('configHandler: store.setState failed', e); }

      try { if (typeof populateSettings === 'function') { populateSettings(msg.settings); } } catch (e) {}
      try {
        const settings = msg.settings || {};
        let activeList = [];
        const asArray = (v) => { if (Array.isArray(v)) { return v.slice(); } if (typeof v === 'string' && v.trim()) { return v.split(',').map(s => s.trim()).filter(Boolean); } return []; };
        const fp = asArray(settings.filterPresets);
        if (fp.length > 0) { activeList = fp; } else { const legacy = asArray(settings.presets); if (legacy.length > 0) { activeList = legacy; } }
        const activePreset = (activeList.length > 0) ? String(activeList[0]) : null;
        try { if (typeof togglePresetSelectionUI === 'function') { togglePresetSelectionUI(activePreset); } } catch (e) {}
      } catch (e) {}
    } catch (e) { console.warn('configHandler error', e); }
  };

  var cmd = (window.COMMANDS && window.COMMANDS.config) ? window.COMMANDS.config : (window.__commandNames && window.__commandNames.config) ? window.__commandNames.config : 'config';
  if (typeof window.__registerHandler === 'function') { try { window.__registerHandler(cmd, configHandler); } catch (e) {} }
  try { if (!window.__registeredHandlers) { window.__registeredHandlers = {}; } window.__registeredHandlers[cmd] = configHandler; } catch (e) {}
  try { if (!window.__commandRegistry) { window.__commandRegistry = {}; } window.__commandRegistry[cmd] = configHandler; } catch (e) {}
})();