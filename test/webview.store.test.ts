// Tests for the lightweight Zustand-like webview store at resources/webview/store.js

describe('webview store (resources/webview/store.js)', () => {
  let store: any;

  beforeEach(() => {
    // Ensure a clean module instance between tests
    try { delete require.cache[require.resolve('../resources/webview/store.js')]; } catch (e) {}
    // Provide a minimal window object so the module may attach window.store if it wants
    (global as any).window = (global as any).window || {};
    // Require the store module fresh
    // The module exports the store object directly
    // (CommonJS style)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    store = require('../resources/webview/store.js');
    // sanity: ensure we have the store API
    expect(store).toBeDefined();
    expect(typeof store.getState).toBe('function');
  });

  test('initial state is sane', () => {
    const s = store.getState();
    expect(s).toBeDefined();
    expect(s.fileTree).toEqual({});
    expect(Array.isArray(s.selectedPaths)).toBe(true);
    expect(Array.isArray(s.expandedPaths)).toBe(true);
    expect(s.paused).toBe(false);
    expect(s.pendingPersistedSelection).toBeNull();
    expect(s.ingestPreview).toBeNull();
    expect(s.previewDelta).toBeNull();
    expect(s.previewState).toBeNull();
    expect(Array.isArray(s.toasts)).toBe(true);
    expect(Array.isArray(s.errors)).toBe(true);
    expect(typeof s.loading).toBe('object');
  });

  test('setFileTree and selection APIs', () => {
    const tree = {
      a: { __isFile: true },
      dir: { b: { __isFile: true }, nested: { c: { __isFile: true } } }
    };
    store.setFileTree(tree, ['a']);
    let s = store.getState();
    expect(s.fileTree).toEqual(tree);
    expect(s.selectedPaths).toEqual(['a']);

    store.setSelection(['dir/b']);
    s = store.getState();
    expect(s.selectedPaths).toEqual(['dir/b']);

    store.clearSelection();
    s = store.getState();
    expect(s.selectedPaths).toEqual([]);

    // selectAllFiles should collect leaves (a, dir/b, dir/nested/c)
    store.selectAllFiles();
    s = store.getState();
    expect(Array.isArray(s.selectedPaths)).toBe(true);
    // sort for deterministic comparison
    const sorted = (s.selectedPaths || []).slice().sort();
    expect(sorted).toEqual(['a', 'dir/b', 'dir/nested/c'].sort());
  });

  test('pause toggle and expanded paths', () => {
    store.togglePause(true);
    let s = store.getState();
    expect(s.paused).toBe(true);
    store.togglePause(false);
    s = store.getState();
    expect(s.paused).toBe(false);
    // toggle with no arg flips
    store.togglePause();
    s = store.getState();
    expect(typeof s.paused).toBe('boolean');

    store.setExpandedPaths(['x', 'y']);
    s = store.getState();
    expect(s.expandedPaths).toEqual(['x', 'y']);
  });

  test('pending persisted selection and preview setters', () => {
    store.setPendingPersistedSelection(['one', 'two'], 3);
    let s = store.getState();
    expect(s.pendingPersistedSelection).toEqual(['one', 'two']);
    expect(s.pendingPersistedFocusIndex).toBe(3);

    store.setPreview({ foo: 'bar' });
    s = store.getState();
    expect(s.ingestPreview).toEqual({ foo: 'bar' });

    store.setPreviewDelta({ delta: 1 });
    s = store.getState();
    expect(s.previewDelta).toEqual({ delta: 1 });

    store.setPreviewState({ state: true });
    s = store.getState();
    expect(s.previewState).toEqual({ state: true });
  });

  test('toasts add/remove', () => {
    // start fresh
    store.setState({ toasts: [] });
    store.addToast({ title: 't1' });
    let s = store.getState();
    expect(Array.isArray(s.toasts)).toBe(true);
    expect(s.toasts.length).toBeGreaterThanOrEqual(1);
    const id = s.toasts[0].id;
    expect(id).toBeDefined();

    store.removeToast(id);
    s = store.getState();
    expect((s.toasts || []).find((t: any) => t.id === id)).toBeUndefined();
  });

  test('errors add and clear', () => {
    store.clearErrors();
    store.addError('boom');
    let s = store.getState();
    expect(Array.isArray(s.errors)).toBe(true);
    expect(s.errors).toContain('boom');
    store.clearErrors();
    s = store.getState();
    expect(s.errors).toEqual([]);
  });

  test('loading flags', () => {
    store.setLoading('op1', true);
    let s = store.getState();
    expect(s.loading && s.loading.op1).toBe(true);
    store.setLoading('op1', false);
    s = store.getState();
    expect(s.loading && s.loading.op1).toBe(false);
  });
});
