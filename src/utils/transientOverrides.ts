const overrides = new Map<string, Record<string, any>>();

export function setTransientOverride(folderPath: string | undefined, data: Record<string, any>) {
    const key = folderPath || '__global__';
    overrides.set(key, data);
}

export function takeTransientOverride(folderPath: string | undefined): Record<string, any> | undefined {
    const key = folderPath || '__global__';
    const v = overrides.get(key);
    if (v) { overrides.delete(key); }
    return v;
}

export function peekTransientOverride(folderPath: string | undefined): Record<string, any> | undefined {
    const key = folderPath || '__global__';
    return overrides.get(key);
}

export default { setTransientOverride, takeTransientOverride, peekTransientOverride };
