import { WEBVIEW_COMMANDS } from './constants.js';

const commandRegistry = {};

export function registerHandler(type, fn) {
    if (!type || typeof fn !== 'function') {
        console.warn('Invalid handler registration attempt', { type });
        return;
    }
    commandRegistry[type] = fn;
}

export function getHandler(type) {
    return commandRegistry[type];
}

// For introspection or debugging
export function getRegistry() {
    return commandRegistry;
}