# Third-party notices

Interlock itself, including the first-party `identity/` package, is licensed
under [`AGPL-3.0-only`](LICENSE). The production dependency graph pinned by
`package-lock.json` also installs the following third-party packages.

| Package | Version | License | Source |
|---|---:|---|---|
| `@hexagon/base64` | `1.1.28` | MIT | <https://github.com/hexagon/base64> |
| `@levischuck/tiny-cbor` | `0.2.11` | MIT | <https://github.com/levischuck/tiny-cbor> |
| `@peculiar/asn1-android` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-cms` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-csr` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-ecc` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-pfx` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-pkcs8` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-pkcs9` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-rsa` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-schema` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-x509` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/asn1-x509-attr` | `2.9.4` | MIT | <https://github.com/PeculiarVentures/asn1-schema> |
| `@peculiar/utils` | `2.0.3` | MIT | <https://github.com/PeculiarVentures/pvtsutils> |
| `@peculiar/x509` | `1.14.3` | MIT | <https://github.com/PeculiarVentures/x509> |
| `@simplewebauthn/server` | `13.3.2` | MIT | <https://github.com/MasterKale/SimpleWebAuthn> |
| `asn1js` | `3.0.10` | BSD-3-Clause | <https://github.com/PeculiarVentures/ASN1.js> |
| `pvtsutils` | `1.3.6` | MIT | <https://github.com/PeculiarVentures/pvtsutils> |
| `pvutils` | `1.2.0` | MIT | <https://github.com/PeculiarVentures/pvutils> |
| `reflect-metadata` | `0.2.2` | Apache-2.0 | <https://github.com/rbuckton/reflect-metadata> |
| `tslib` | `1.14.1` | 0BSD | <https://github.com/Microsoft/tslib> |
| `tslib` | `2.8.1` | 0BSD | <https://github.com/Microsoft/tslib> |
| `tsyringe` | `4.10.0` | MIT | <https://github.com/Microsoft/tsyringe> |

The npm-installed copy of each package carries its complete license text. In
particular, `asn1js` carries the BSD 3-Clause copyright and conditions for GMO
GlobalSign and Peculiar Ventures, and `reflect-metadata` carries the Apache
License 2.0. Interlock does not remove or replace those files. A future bundled
or vendored distribution must carry the applicable complete license and notice
text itself; this inventory alone is not a substitute.

This inventory is tested against every production `node_modules/` entry in the
lockfile. Updating a dependency without updating this file fails the release
test.

## Bundled fonts

Interlock bundles the IBM Plex typefaces as WOFF2 files so the room needs no
font network requests (the content security policy stays `'self'`).

| Font | Files | License | Source |
|---|---|---|---|
| IBM Plex Sans (variable, latin) | `src/web/fonts/plex-sans-var.woff2` | SIL OFL 1.1 | <https://github.com/IBM/plex> |
| IBM Plex Mono 400/600 (latin) | `src/web/fonts/plex-mono-400.woff2`, `src/web/fonts/plex-mono-600.woff2` | SIL OFL 1.1 | <https://github.com/IBM/plex> |

The complete SIL Open Font License 1.1 text, with IBM's copyright and reserved
font name notice, ships beside the files as `src/web/fonts/LICENSE.txt`.
