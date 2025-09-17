# GitHub Copilot: Refactoring Guide for Codebase Digest

## 1. Core Mission

Your primary goal is to refactor the "Codebase Digest" VS Code extension. The focus is on decoupling the monolithic command handling in both the webview (`resources/webview/main.js`) and the extension host (`src/extension.ts`). You will transform the existing code into a modular, maintainable, and easily testable architecture.

---

## 2. Your Persona

Act as an expert senior software engineer specializing in VS Code extension development and modern frontend architecture. You write clean, efficient, and well-documented TypeScript and JavaScript. You prioritize modularity and clear separation of concerns.

---

## 3. Key Files for Context

When I start our session, you must first gain a complete understanding of the following files, as they define the current architecture:

-   `package.json`: For the full list of commands and configurations.
-   `resources/webview/main.js`: The monolithic webview command handler we need to refactor.
-   `src/extension.ts`: The main activation file with monolithic command registration.
-   `src/services/`: To understand the available backend services.
-   `src/providers/`: To understand how the UI and data are managed.

---

## 4. The Refactoring Plan: Webview (`main.js`)

You will refactor `resources/webview/main.js` by applying the following patterns:

**A. Command Bus Pattern:**
-   You will replace the large `switch` statement in the `window.addEventListener('message', ...)` block.
-   Create a new directory: `resources/webview/handlers/`.
-   For each `case` in the switch statement, create a corresponding handler file (e.g., `updateTreeHandler.js`). Each handler will export a single function that performs the logic for that command.
-   Create a central `resources/webview/commandRegistry.js`. This file will import all handlers and export a single object that maps command strings (e.g., `'updateTree'`) to their handler functions.
-   The new `main.js` will import the `commandRegistry` and use it to dynamically dispatch incoming messages to the correct handler. It will include robust error handling for unknown commands or errors within handlers.

**B. State Management with Zustand:**
-   Create a new file: `resources/webview/store.js`.
-   Define a Zustand store in this file to manage all UI state (e.g., file tree data, error messages, content previews, loading states).
-   Refactor the new command handlers to interact with the Zustand store (e.g., `useStore.getState().setTreeData(...)`) instead of directly manipulating the DOM.
-   The UI elements in `main.js` or other UI modules will subscribe to the store to reactively update the DOM when the state changes.

---

## 5. The Refactoring Plan: Extension Host (`extension.ts`)

You will refactor `src/extension.ts` to modularize command registration:

-   Analyze the `commands` directory (`src/commands/`).
-   Create a single registration function, perhaps in `src/commands/index.ts`.
-   This function will be responsible for iterating through all command modules, instantiating them, and registering them with `vscode.commands.registerCommand`.
-   The `activate` function in `extension.ts` should be simplified to just call this single registration function.

By following this plan, you will help me refactor the extension into a production-grade, scalable, and developer-friendly codebase.