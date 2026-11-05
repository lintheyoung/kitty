/**
 * Kitty product identity. Kitty is a fork of T3 Code and must never share
 * state, app identity, or URL schemes with a T3 Code install on the same machine.
 *
 * `apps/desktop/scripts/electron-launcher.mjs` runs without TypeScript and
 * repeats these values; keep both in sync.
 */
export const KITTY_PRODUCT_NAME = "Kitty";
export const KITTY_HOME_DIRNAME = ".kitty";
export const KITTY_APP_ID = "gg.pest.kitty";
export const KITTY_PROTOCOL_SCHEME = "kitty";
export const KITTY_DEV_PROTOCOL_SCHEME = "kitty-dev";
