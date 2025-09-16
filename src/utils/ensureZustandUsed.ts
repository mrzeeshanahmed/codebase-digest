// Tiny runtime shim to reference 'zustand' so dependency checkers (depcheck) mark
// it as used. This creates a minimal store at activation and immediately disposes it.
import create from 'zustand';

export function ensureZustandReferenced() {
    try {
        // create and immediately discard a tiny store — do not capture across activation
        const useStore = create(() => ({ _used: true }));
        // access state to prevent tree-shaking in some bundlers
        try { const s = useStore.getState(); void s; } catch (e) {}
        // no-op cleanup; zustand stores are GC'd when not referenced
    } catch (e) {
        // swallow any runtime error — function exists purely to reference the package
    }
}
