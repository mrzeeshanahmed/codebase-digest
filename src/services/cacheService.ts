import { DigestConfig } from '../types/interfaces';

export class CacheService {
    computeKey(params: {
        sourceType: 'local' | 'remote',
        remoteRepo?: string,
        commitSha?: string,
        includePatterns?: string[],
        excludePatterns?: string[],
        subpath?: string,
        outputFormat?: string,
        outputPresetCompatible?: boolean,
        filterPresets?: string[],
        outputSeparatorsHeader?: string,
    }): string {
        // Stable JSON stringification: sort keys and arrays
        function stableStringify(obj: any): string {
            if (Array.isArray(obj)) {
                return '[' + obj.map(stableStringify).join(',') + ']';
            } else if (obj && typeof obj === 'object') {
                const keys = Object.keys(obj).sort();
                return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
            } else {
                return JSON.stringify(obj);
            }
        }
        const keyObj = {
            sourceType: params.sourceType,
            remoteRepo: params.remoteRepo || '',
            commitSha: params.commitSha || '',
            includePatterns: (params.includePatterns || []).slice().sort(),
            excludePatterns: (params.excludePatterns || []).slice().sort(),
            subpath: params.subpath || '',
            outputFormat: params.outputFormat || '',
            outputPresetCompatible: params.outputPresetCompatible || false,
            filterPresets: (params.filterPresets || []).slice().sort(),
            outputSeparatorsHeader: params.outputSeparatorsHeader || '',
        };
        const stableJson = stableStringify(keyObj);
        // NOTE: We prefer Node's built-in crypto for a strong SHA-256 key.
        // Some bundlers (or incorrect webpack configs) may externalize or
        // shim 'crypto' which can cause require('crypto') to throw at
        // runtime in ESM or packaged builds. Keep 'crypto' external in the
        // bundler config; if it's not available at runtime, fall back to a
        // deterministic JS hash so caching degrades gracefully rather than
        // throwing and disabling caching entirely.
        try {
            const crypto = require('crypto');
            if (crypto && typeof crypto.createHash === 'function') {
                return crypto.createHash('sha256').update(stableJson).digest('hex');
            }
        } catch (e) {
            try { console.warn('cacheService: crypto unavailable, falling back to JS hash; ensure bundler keeps crypto external'); } catch (_) {}
        }

        // Fallback: deterministic 128-bit FNV-1a (2×64-bit) using BigInt.
        // Produces 32 hex chars, substantially reducing collision risk vs 32-bit.
        function fnv1a64Hex(str: string, seed: bigint = 0xcbf29ce484222325n): string {
            let h = seed;
            const FNV_PRIME = 0x00000100000001B3n;
            const MASK_64 = 0xFFFFFFFFFFFFFFFFn;
            for (let i = 0; i < str.length; i++) {
                h ^= BigInt(str.charCodeAt(i));
                h = (h * FNV_PRIME) & MASK_64;
            }
            return h.toString(16).padStart(16, '0');
        }
        const h1 = fnv1a64Hex(stableJson, 0xcbf29ce484222325n);
        const h2 = fnv1a64Hex('#' + stableJson, 0x84222325cbf29ce4n);
        return h1 + h2;
    }
}
