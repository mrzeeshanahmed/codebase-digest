// Tests for the minimal webview store actions (created by resources/webview/store.js or main.js fallback)

describe('webview store actions', () => {
  let wvStore: any;
  beforeEach(() => {
    (global as any).window = {};
    // require a fresh store instance and attach to window
    try { delete require.cache[require.resolve('../../resources/webview/store.js')]; } catch (e) {}
    wvStore = require('../../resources/webview/store.js');
    (global as any).window.store = wvStore;
    // reset to a minimal known state
    try { wvStore.setState({ fileTree: {}, selectedPaths: [], preview: null, previewDelta: null }); } catch (e) {}
  });

  test('setFileTree updates fileTree and selectedPaths', () => {
    const tree = { a: { __isFile: true, path: 'a' }, dir: { child: { __isFile: true, path: 'dir/child' } } };
    wvStore.setFileTree(tree, ['a']);
    const s = wvStore.getState();
    expect(s.fileTree).toEqual(tree);
    expect(Array.isArray(s.selectedPaths)).toBe(true);
    expect(s.selectedPaths).toContain('a');
  });

  test('selectAllFiles collects leaves', () => {
    const tree = { a: { __isFile: true, path: 'a' }, dir: { child: { __isFile: true, path: 'dir/child' } } };
    wvStore.setFileTree(tree, []);
    wvStore.selectAllFiles();
    const s = wvStore.getState();
    expect(Array.isArray(s.selectedPaths)).toBe(true);
    expect(s.selectedPaths.length).toBe(2);
    expect(s.selectedPaths).toContain('a');
    expect(s.selectedPaths).toContain('dir/child');
  });
});
