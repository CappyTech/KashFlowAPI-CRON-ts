// Central place to expose application version at runtime without JSON import assertions.
// Prefer environment variable (IMAGE_VERSION or APP_VERSION) to allow overriding in container builds.
// Fallback to embedded constant updated manually on version bumps.
export const APP_VERSION = process.env.APP_VERSION || process.env.IMAGE_VERSION || 'x.x.x';
