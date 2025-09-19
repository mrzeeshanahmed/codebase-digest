// Reusable runtime type guards and helpers to safely narrow unknown values

export function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null;
}

export function hasProp<K extends string>(obj: unknown, prop: K): obj is Record<K, unknown> {
    return isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, prop);
}

export function isStringArray(x: unknown): x is string[] {
    return Array.isArray(x) && x.every((v) => typeof v === 'string');
}

export function isNumber(x: unknown): x is number {
    return typeof x === 'number' && !Number.isNaN(x);
}

export function isFunction(x: unknown): x is Function {
    return typeof x === 'function';
}

export function safeParseJSON<T = unknown>(s: string): T | undefined {
    try {
        return JSON.parse(s) as T;
    } catch (err) {
        return undefined;
    }
}

export function ensureArray<T>(x: unknown): T[] {
    return Array.isArray(x) ? (x as T[]) : [];
}

export function assertIs<T>(v: unknown, check: (x: unknown) => x is T, message?: string): T {
    if (check(v)) {
        return v;
    }
    throw new Error(message ?? 'Value does not match expected type');
}
