const webviewStore: any = require('../../resources/webview/store.js');

describe('webview store', () => {
  beforeEach(() => {
    // Reset core slices to known values
    (webviewStore as any).setState({
      fileTree: {},
      selectedPaths: [],
      toasts: [],
      errors: [],
      loading: {}
    });
  });

  test('setFileTree and selectAllFiles update selectedPaths', () => {
    const tree = { dir: { fileA: { __isFile: true, path: 'dir/fileA' }, sub: { fileB: { __isFile: true, path: 'dir/sub/fileB' } } } };
    (webviewStore as any).setFileTree(tree, ['dir/fileA']);
    const s1 = (webviewStore as any).getState();
    expect(s1.fileTree).toBe(tree);
    expect(s1.selectedPaths).toEqual(['dir/fileA']);

    // selectAllFiles should collect leaves
    (webviewStore as any).selectAllFiles();
    const s2 = (webviewStore as any).getState();
    expect(new Set(s2.selectedPaths)).toEqual(new Set(['dir/fileA', 'dir/sub/fileB']));
  });

  test('toasts and errors behave correctly', () => {
    (webviewStore as any).addToast({ text: 'hello' });
    let s = (webviewStore as any).getState();
    expect(Array.isArray(s.toasts)).toBe(true);
    expect(s.toasts.length).toBeGreaterThanOrEqual(1);
    const id = s.toasts[s.toasts.length - 1].id;
    expect(typeof id).toBe('number');

    (webviewStore as any).removeToast(id);
    s = (webviewStore as any).getState();
    expect(s.toasts.find((t: any) => t.id === id)).toBeUndefined();

    (webviewStore as any).addError('boom');
    s = (webviewStore as any).getState();
    expect(s.errors).toContain('boom');
    (webviewStore as any).clearErrors();
    s = (webviewStore as any).getState();
    expect(s.errors.length).toBe(0);
  });

  test('setLoading toggles loading flags', () => {
    (webviewStore as any).setLoading('ingest', true);
    let s = (webviewStore as any).getState();
    expect(s.loading && s.loading.ingest).toBe(true);
    (webviewStore as any).setLoading('ingest', false);
    s = (webviewStore as any).getState();
    expect(s.loading && s.loading.ingest).toBe(false);
  });
});
