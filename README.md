# leocodebox

leocodebox is a local-only macOS desktop app for controlling local coding agents.

The native app starts its bundled local service when leocodebox opens and stops
that service when leocodebox quits. No hosted account is required.

## Local-Only Behavior

- The bundled service binds to `127.0.0.1` by default.
- The desktop app injects a per-launch local capability token into its own local
  web view.
- Cloud account and hosted-environment flows are disabled in this build.
- Web push and remote server downloads are disabled in this build.

## License And Notices

leocodebox is distributed under AGPL-3.0-or-later.

This distribution is based on CloudCLI UI
(`https://github.com/siteboon/claudecodeui`) and retains the required legal
notices in `LICENSE` and `NOTICE`.
