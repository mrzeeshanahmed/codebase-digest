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
        return require('crypto').createHash('sha256').update(stableJson).digest('hex');
    }
}
