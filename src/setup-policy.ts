// Environment-free policy constants: CLI argument validation must not initialize
// state/config paths before a caller selects its state directory.
export const SETUP_DEFAULT_TIMEOUT_MS = 120_000;
export const SETUP_MAX_TIMEOUT_MS = 300_000;
export const SETUP_MAX_LOG_BYTES = 256 * 1024;
