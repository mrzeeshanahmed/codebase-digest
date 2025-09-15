import { DigestConfig } from '../types/interfaces';
import { Diagnostics } from '../utils/diagnostics';

const VALID_OUTPUT_FORMATS = ['markdown', 'text', 'json'];
const VALID_BINARY_POLICIES = ['skip', 'includeBase64', 'includePlaceholder'];

export function validateConfig(cfg: DigestConfig, diagnostics: Diagnostics): void {
    // Numeric limits: coerce and warn. Ensure integers where appropriate.
    function coercePositiveInteger(key: keyof DigestConfig, value: unknown, fallback: number, inclusiveZero = false) {
        const min = inclusiveZero ? 0 : 1;
        if (typeof value === 'number' && Number.isFinite(value) && Number(value) >= min && Number.isInteger(value)) {
            return Number(value);
        }
        diagnostics.warn(`${String(key)} is invalid or out of range. Coercing to ${fallback}.`);
        return fallback;
    }

    cfg.maxFileSize = coercePositiveInteger('maxFileSize', cfg.maxFileSize, 10485760, true);
    cfg.maxFiles = coercePositiveInteger('maxFiles', cfg.maxFiles, 25000, false);
    cfg.maxTotalSizeBytes = coercePositiveInteger('maxTotalSizeBytes', cfg.maxTotalSizeBytes, 536870912, true);
    cfg.maxDirectoryDepth = coercePositiveInteger('maxDirectoryDepth', cfg.maxDirectoryDepth, 20, true);
    // notebookIncludeNonTextOutputs: boolean
    if (cfg.tokenLimit !== undefined) {
        if (typeof cfg.tokenLimit !== 'number' || !Number.isFinite(cfg.tokenLimit) || cfg.tokenLimit < 0 || !Number.isInteger(cfg.tokenLimit)) {
            diagnostics.warn('tokenLimit is invalid; coercing to 32000.');
            cfg.tokenLimit = 32000;
        }
    }

    // Normalize certain legacy aliases first (e.g., 'include' => 'includePlaceholder')
    if (typeof cfg.binaryFilePolicy === 'string' && String(cfg.binaryFilePolicy).trim().toLowerCase() === 'include') {
        diagnostics.warn(`binaryFilePolicy 'include' is deprecated; treating as 'includePlaceholder'.`);
        cfg.binaryFilePolicy = 'includePlaceholder';
    }

    // Enums: coerce and warn
    if (!VALID_OUTPUT_FORMATS.includes(String(cfg.outputFormat))) {
        diagnostics.warn(`outputFormat '${String(cfg.outputFormat)}' is invalid. Coercing to 'markdown'. Valid: ${VALID_OUTPUT_FORMATS.join(', ')}`);
        cfg.outputFormat = 'markdown';
    }
    if (!VALID_BINARY_POLICIES.includes(String(cfg.binaryFilePolicy))) {
        diagnostics.warn(`binaryFilePolicy '${String(cfg.binaryFilePolicy)}' is invalid. Coercing to 'skip'. Valid: ${VALID_BINARY_POLICIES.join(', ')}`);
        cfg.binaryFilePolicy = 'skip';
    }

    // Other checks can be added here
    // Phase 6: Validate new keys
    // contextLimit: coerce number >= 0; default 0 means disabled
    if (cfg.contextLimit === undefined || typeof cfg.contextLimit !== 'number' || !Number.isFinite(cfg.contextLimit) || cfg.contextLimit < 0 || !Number.isInteger(cfg.contextLimit)) {
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
    if (cfg.notebookNonTextOutputMaxBytes === undefined || typeof cfg.notebookNonTextOutputMaxBytes !== 'number' || !Number.isFinite(cfg.notebookNonTextOutputMaxBytes) || cfg.notebookNonTextOutputMaxBytes < 0 || !Number.isInteger(cfg.notebookNonTextOutputMaxBytes)) {
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
            cfg.redactionPatterns = (cfg.redactionPatterns as Array<unknown>).map(p => typeof p === 'string' ? p : String(p)).filter(Boolean);
        } else if (typeof cfg.redactionPatterns === 'string') {
            // convert comma/newline-separated string to array
            const raw = String(cfg.redactionPatterns);
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

// Runtime type guard to validate a plain object matches the DigestConfig shape
export function isDigestConfig(obj: unknown): obj is DigestConfig {
    if (typeof obj !== 'object' || obj === null) { return false; }
    const o = obj as Record<string, unknown>;
    // Basic required numeric fields
    if (typeof o.maxFileSize !== 'number') { return false; }
    if (typeof o.maxFiles !== 'number') { return false; }
    if (typeof o.maxTotalSizeBytes !== 'number') { return false; }
    if (typeof o.maxDirectoryDepth !== 'number') { return false; }
    // Patterns arrays
    if (!Array.isArray(o.excludePatterns)) { return false; }
    if (!Array.isArray(o.includePatterns)) { return false; }
    // enums
    if (typeof o.outputFormat !== 'string') { return false; }
    if (typeof o.binaryFilePolicy !== 'string') { return false; }
    // booleans
    if (typeof o.includeMetadata !== 'boolean') { return false; }
    if (typeof o.includeTree !== 'boolean') { return false; }
    if (typeof o.includeSummary !== 'boolean') { return false; }
    if (typeof o.includeFileContents !== 'boolean') { return false; }
    if (typeof o.useStreamingRead !== 'boolean') { return false; }
    if (typeof o.notebookProcess !== 'boolean') { return false; }
    if (typeof o.tokenEstimate !== 'boolean') { return false; }
    if (typeof o.performanceCollectMetrics !== 'boolean') { return false; }
    if (typeof o.performanceLogLevel !== 'string') { return false; }
    if (typeof o.outputSeparatorsHeader !== 'string') { return false; }
    if (typeof o.outputWriteLocation !== 'string') { return false; }
    // tokenModel is a string
    if (typeof o.tokenModel !== 'string') { return false; }
    // tokenLimit is optional number
    if (o.tokenLimit !== undefined && typeof o.tokenLimit !== 'number') { return false; }
    // tokenDivisorOverrides is optional map
    if (o.tokenDivisorOverrides !== undefined && typeof o.tokenDivisorOverrides !== 'object') { return false; }
    return true;
}
