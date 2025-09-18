# Contributor Guide for Codebase Digest

## 1. Core Mission

Our goal is to build and maintain a high-quality, robust, and user-friendly VS Code extension. We aim for a clean, modular, and easily testable codebase.

---

## 2. Guiding Principles

As a contributor, please adhere to the following principles:

-   **Modularity:** Keep components decoupled and focused on a single responsibility. Avoid monolithic files and logic.
-   **Clarity & Readability:** Write clean, efficient, and well-documented TypeScript and JavaScript.
-   **Separation of Concerns:** Strictly separate business logic, state management, and UI rendering. For example, extension host code should not be tightly coupled to webview implementation details.
-   **Testability:** Write unit and integration tests for new features and bug fixes. Ensure your code is structured to be easily testable.
-   **State-Driven UI:** In the webview, prefer state management libraries (like Zustand) over direct DOM manipulation. UI should react to state changes.

---

## 3. Getting Started: Key Files

To get familiar with the codebase, start by reviewing these areas:

-   `package.json`: Defines commands, dependencies, and extension metadata.
-   `src/extension.ts`: The extension's entry point where commands and providers are activated.
-   `src/services/`: Contains the core business logic (e.g., file scanning, content processing).
-   `src/providers/`: Manages VS Code UI elements like webviews and tree views.
-   `resources/webview/`: Contains the frontend code for the webview, including HTML, CSS, and JavaScript.
-   `eslint.config.mjs` & `tsconfig.json`: Defines the project's coding standards and TypeScript configuration.

By following these guidelines, you will help us build a scalable and developer-friendly codebase.