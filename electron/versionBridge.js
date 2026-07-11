// Product-version reset bridge for users already on the historical 1.37.x line.
// The updater feed advertises a synthetic version above 1.37.0 exactly while
// packaging 1.1.5; once installed, 1.1.5 ignores that synthetic feed entry and
// follows normal 1.1.x semver releases.
export const VERSION_RESET_TARGET = '1.1.5';
export const LEGACY_UPDATE_BRIDGE_VERSION = '1.37.1';

export function getUpdateMetadataVersion(productVersion) {
  return productVersion === VERSION_RESET_TARGET ? LEGACY_UPDATE_BRIDGE_VERSION : productVersion;
}
