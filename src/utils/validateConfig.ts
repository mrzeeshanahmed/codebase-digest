import { DigestConfig } from '../types/interfaces';
import { Diagnostics } from '../utils/diagnostics';

const VALID_OUTPUT_FORMATS = ['markdown', 'text', 'json'];
const VALID_BINARY_POLICIES = ['skip', 'includeBase64', 'includePlaceholder'];

export function validateConfig(cfg: DigestConfig, diagnostics: Diagnostics): void {
    // Numeric limits: coerce and warn
    if (typeof cfg.maxFileSize !== 'number' || cfg.maxFileSize < 0) {
        diagnostics.warn('maxFileSize is invalid or negative. Coercing to 10485760 (10MB).');
        cfg.maxFileSize = 10485760;
    }
    if (typeof cfg.maxFiles !== 'number' || cfg.maxFiles < 1) {
        diagnostics.warn('maxFiles is invalid or less than 1. Coercing to 25000.');
        cfg.maxFiles = 25000;
    }
    if (typeof cfg.maxTotalSizeBytes !== 'number' || cfg.maxTotalSizeBytes < 0) {
        diagnostics.warn('maxTotalSizeBytes is invalid or negative. Coercing to 536870912 (512MB).');
        cfg.maxTotalSizeBytes = 536870912;
    }
    if (typeof cfg.maxDirectoryDepth !== 'number' || cfg.maxDirectoryDepth < 0) {
        diagnostics.warn('maxDirectoryDepth is invalid or negative. Coercing to 20.');
        cfg.maxDirectoryDepth = 20;
    }
    // notebookIncludeNonTextOutputs: boolean
    if (cfg.tokenLimit !== undefined && (typeof cfg.tokenLimit !== 'number' || cfg.tokenLimit < 0)) {
        diagnostics.warn('tokenLimit is invalid or negative. Coercing to 32000.');
        cfg.tokenLimit = 32000;
    }

    // Normalize certain legacy aliases first (e.g., 'include' => 'includePlaceholder')
    if (typeof cfg.binaryFilePolicy === 'string' && String(cfg.binaryFilePolicy).trim().toLowerCase() === 'include') {
        diagnostics.warn(`binaryFilePolicy 'include' is deprecated; treating as 'includePlaceholder'.`);
        cfg.binaryFilePolicy = 'includePlaceholder' as any;
    }

    // Enums: coerce and warn
    if (!VALID_OUTPUT_FORMATS.includes(cfg.outputFormat)) {
        diagnostics.warn(`outputFormat '${cfg.outputFormat}' is invalid. Coercing to 'markdown'. Valid: ${VALID_OUTPUT_FORMATS.join(', ')}`);
        cfg.outputFormat = 'markdown';
    }
    if (!VALID_BINARY_POLICIES.includes(cfg.binaryFilePolicy)) {
        diagnostics.warn(`binaryFilePolicy '${cfg.binaryFilePolicy}' is invalid. Coercing to 'skip'. Valid: ${VALID_BINARY_POLICIES.join(', ')}`);
        cfg.binaryFilePolicy = 'skip';
    }

    // Other checks can be added here
    // Phase 6: Validate new keys
    // contextLimit: coerce number >= 0; default 0 means disabled
    if (cfg.contextLimit === undefined || typeof cfg.contextLimit !== 'number' || cfg.contextLimit < 0) {
        diagnostics.warn('contextLimit is invalid or negative. Coercing to 0 (disabled).');
        cfg.contextLimit = 0;
    }

    // cacheEnabled: boolean
    if (typeof cfg.cacheEnabled !== 'boolean') {
        diagnostics.warn('cacheEnabled is not a boolean. Coercing to false.');
        cfg.cacheEnabled = false;
    }

    // cacheDir: string or empty
    if (cfg.cacheDir !== undefined && typeof cfg.cacheDir !== 'string') {
        diagnostics.warn('cacheDir is not a string. Coercing to empty string.');
        cfg.cacheDir = '';
    }

    // notebookIncludeNonTextOutputs: boolean
    if (typeof cfg.notebookIncludeNonTextOutputs !== 'boolean') {
        diagnostics.warn('notebookIncludeNonTextOutputs is not a boolean. Coercing to false.');
        cfg.notebookIncludeNonTextOutputs = false;
    }

    // notebookNonTextOutputMaxBytes: number >= 0
    if (cfg.notebookNonTextOutputMaxBytes === undefined || typeof cfg.notebookNonTextOutputMaxBytes !== 'number' || cfg.notebookNonTextOutputMaxBytes < 0) {
        diagnostics.warn('notebookNonTextOutputMaxBytes is invalid or negative. Coercing to 200000.');
        cfg.notebookNonTextOutputMaxBytes = 200000;
    }

    // Redaction settings: defensive coercion and diagnostics
    if (typeof cfg.showRedacted !== 'boolean') {
        diagnostics.warn('showRedacted must be a boolean. Coercing to false.');
        cfg.showRedacted = false;
    }
    if (cfg.redactionPatterns !== undefined) {
        if (Array.isArray(cfg.redactionPatterns)) {
            // ensure all entries are strings
            cfg.redactionPatterns = (cfg.redactionPatterns as any[]).map(p => typeof p === 'string' ? p : String(p)).filter(Boolean);
        } else if (typeof cfg.redactionPatterns === 'string') {
            // convert comma/newline-separated string to array
            const raw = cfg.redactionPatterns as string;
            cfg.redactionPatterns = raw.split(/\r?\n|,/).map((s: string) => s.trim()).filter(Boolean);
        } else {
            diagnostics.warn('redactionPatterns must be an array or string. Coercing to empty array.');
            cfg.redactionPatterns = [];
        }
    } else {
        cfg.redactionPatterns = [];
    }
    if (typeof cfg.redactionPlaceholder !== 'string') {
        diagnostics.warn('redactionPlaceholder must be a string. Coercing to "[REDACTED]".');
        cfg.redactionPlaceholder = '[REDACTED]';
    }
}
