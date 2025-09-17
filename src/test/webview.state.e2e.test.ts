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
        // The webview bundle expects ./store.js and ./commandRegistry/handlers to run
    require('../../resources/webview/store.js');
    require('../../resources/webview/commandRegistry.js');
    // load handlers and main to ensure listeners registered
        // Instead of loading main.js/handlers (they may redeclare globals in test env),
        // create a minimal command registry and message router that mirrors the
        // webview's behavior for the 'state' command.
        // Register a simple handler that writes the incoming fileTree into the store
        (global as any).__commandRegistry = (global as any).__commandRegistry || {};
        (global as any).__registerHandler = function (type: string, fn: Function) {
            (global as any).__commandRegistry[type] = fn;
        };
        // Add a lightweight router similar to main.js so dispatching a MessageEvent
        // will call the registered handlers.
        window.addEventListener('message', (ev) => {
            const msg = ev && ev.data ? ev.data : null;
            if (!msg || !msg.type) { return; }
            const handler = (global as any).__commandRegistry && (global as any).__commandRegistry[msg.type];
            if (typeof handler === 'function') { try { handler(msg); } catch (e) { /* swallow */ } }
        });

        // Compose a sample tree payload
        const sampleTree = { 'src': { '__isFile': false, 'index.js': { '__isFile': true, 'path': 'src/index.js' } } };

            // Require the real handler files so they register with the command registry
            // in the same test runtime. We avoid requiring main.js to prevent redeclaration
            // issues (main.js declares a local `store` variable in some branches).
            try { delete require.cache[require.resolve('../../resources/webview/handlers/stateHandler.js')]; } catch (e) {}
            try { delete require.cache[require.resolve('../../resources/webview/handlers/treeDataHandler.js')]; } catch (e) {}
            require('../../resources/webview/handlers/stateHandler.js');
            require('../../resources/webview/handlers/treeDataHandler.js');

            // Ensure handlers registered
            const cmdName = (global as any).COMMANDS && (global as any).COMMANDS.state ? (global as any).COMMANDS.state : 'state';
            const registryKeys = Object.keys((global as any).__commandRegistry || {});
            // eslint-disable-next-line no-console
            console.debug('registry keys before dispatch:', registryKeys);
            const handlerExists = !!((global as any).__commandRegistry && (global as any).__commandRegistry[cmdName]);
            expect(handlerExists).toBeTruthy();

            // Send a MessageEvent as the extension host would; the real handlers should
            // be registered on window.__commandRegistry by the requires above and
            // will be invoked by the lightweight router we wired earlier.
            const event = new MessageEvent('message', { data: { type: cmdName, state: { fileTree: sampleTree }, folderPath: '/workspace' } });
            window.dispatchEvent(event);

        // Allow any microtasks/handlers to run
        await new Promise((res) => setTimeout(res, 20));

        // Validate that the store was created and treeData set
        const st = (window as any).store && (window as any).store.getState ? (window as any).store.getState() : null;
        expect(st).not.toBeNull();
        expect(st.treeData).toBeDefined();
        // The handler sets treeData to the fileTree payload
        expect(st.treeData).toEqual(sampleTree);
    });
});
