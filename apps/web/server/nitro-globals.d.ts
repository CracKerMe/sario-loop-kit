/**
 * Nitro auto-imports used by this app's server plugins.
 *
 * Nitro injects `defineNitroPlugin` (and friends) as globals at build time and
 * generates `.nitro/types/nitro-imports.d.ts` to declare them — but that file
 * only exists *after* a build, so a clean checkout's `tsc --noEmit` sees the
 * global as undefined. Declaring the one global this app actually uses keeps
 * the type-check gate usable without requiring a build first.
 *
 * Deliberately minimal: only what `server/plugins/*` references. If more Nitro
 * auto-imports start being used, add them here rather than reaching for the
 * build-time types, which are for Nitro's own config surface.
 */
declare global {
  interface NitroAppLike {
    hooks: {
      hook(name: string, handler: (...args: never[]) => unknown): void;
    };
  }

  const defineNitroPlugin: (plugin: (nitroApp: NitroAppLike) => void) => unknown;
}

export {};
