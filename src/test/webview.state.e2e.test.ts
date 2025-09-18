/**
 * E2E-like test: simulate the host posting a state message to the webview
 * and assert the webview handlers populate window.store.treeData.
 * This runs in the repository test environment (JSDOM by default).
 */
describe('webview state propagation (e2e)', () => {
    beforeEach(() => {
        // clear any cached modules to ensure fresh environment
        jest.resetModules();
        // Create a lightweight JSDOM instance so webview scripts can run under node testEnvironment
        const { JSDOM } = require('jsdom');
        const dom = new JSDOM('<!doctype html><html><body></body></html>');
        // Reflect globals expected by the webview scripts
        (global as any).window = dom.window;
        (global as any).document = dom.window.document;
        (global as any).navigator = dom.window.navigator;
        (global as any).MessageEvent = dom.window.MessageEvent;
        // Minimal DOM elements used by main.js and handlers
        document.body.innerHTML = `
            <div id="file-list"></div>
            <div id="toolbar"></div>
            <div id="toast-root"></div>
            <div id="progress-container"></div>
            <div id="progress-bar"></div>
        `;
        // Provide acquireVsCodeApi on global for the scripts (use any to avoid TS errors in tests)
        (global as any).acquireVsCodeApi = () => ({ postMessage: () => {} });
    });

    test('incoming state message populates store.treeData via handler', async () => {
        // Load the store and command registry + handlers
        require('../../resources/webview/store.js');
        require('../../resources/webview/commandRegistry.js');

        // Create a minimal registry and router similar to the webview runtime
        (global as any).__commandRegistry = (global as any).__commandRegistry || {};
        (global as any).__registerHandler = function (type: string, fn: Function) {
            (global as any).__commandRegistry[type] = fn;
        };

        window.addEventListener('message', (ev) => {
            const msg = ev && ev.data ? ev.data : null;
            if (!msg || !msg.type) { return; }
            const handler = (global as any).__commandRegistry && (global as any).__commandRegistry[msg.type];
            if (typeof handler === 'function') { try { handler(msg); } catch (e) { /* swallow */ } }
        });

        // Compose a sample tree payload
        const sampleTree = { 'src': { '__isFile': false, 'index.js': { '__isFile': true, 'path': 'src/index.js' } } };

        // Require the real handler files so they register with the command registry
        try { delete require.cache[require.resolve('../../resources/webview/handlers/stateHandler.js')]; } catch (e) {}
        try { delete require.cache[require.resolve('../../resources/webview/handlers/treeDataHandler.js')]; } catch (e) {}
        require('../../resources/webview/handlers/stateHandler.js');
        require('../../resources/webview/handlers/treeDataHandler.js');

        // Ensure handlers registered under a canonical name 'state'
        const handler = (global as any).__commandRegistry && (global as any).__commandRegistry['state'];
        expect(typeof handler === 'function').toBe(true);

        // Dispatch a message to the lightweight router we wired earlier
        const event = new MessageEvent('message', { data: { type: 'state', state: { fileTree: sampleTree }, folderPath: '/workspace' } });
        window.dispatchEvent(event);

    // Allow any microtasks/handlers to run
    await new Promise<void>(res => { if (typeof queueMicrotask === 'function') { queueMicrotask(() => res()); } else { Promise.resolve().then(() => res()); } });

        // Validate that the store was created and treeData set
        const st = (window as any).store && (window as any).store.getState ? (window as any).store.getState() : null;
        expect(st).not.toBeNull();
        expect(st.treeData).toBeDefined();
        // The handler sets treeData to the fileTree payload
        expect(st.treeData).toEqual(sampleTree);
    });
});
