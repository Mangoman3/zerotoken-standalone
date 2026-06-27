# ZeroToken internals

This directory contains the standalone browser-authenticated provider implementation that gets bundled into `dist/index.js`.

## Layout

- `providers/` holds browser discovery, browser automation, and provider-specific login helpers.
- `streams/` holds the provider-specific `StreamFn` factories used after credentials are captured.
- `bridge/` holds provider descriptors and model catalogs shared by auth and runtime registration.

## Portability notes

- All imports in this tree are local to this repository so the plugin can be cloned and installed on another machine without the original monorepo.
- Runtime integration with OpenClaw happens only through the public `openclaw/plugin-sdk/core` surface exposed from `src/index.ts`.
