# NAAvOS naming and compatibility policy

## Canonical names

- **Product/platform:** NAAvOS, or **NAAvOS Avatar OS** when the category needs to be explicit.
- **Company/maintainer:** Radoss Agency.
- **Open-source project:** NAAvOS Avatar OS.

Radoss Agency is not the product name. New customer-facing screens, package
metadata, documentation, release notes, OAuth labels, and support messages must
use NAAvOS.

## Compatibility aliases

The following legacy identifiers are retained only where changing them would
break an existing installation or an external contract: the historical
`radoss-universal-avatar` repository URL, the `radoss` CLI command and
`radoss_avatar` MCP identifier, `radoss-universal-avatar` credential/Rust
identifiers, `RADOS_NAAS_GATEWAY_URL`, the `/Documents/NAAS` source folder and
historical evidence filenames, and existing deployment/protocol identifiers.

These are implementation aliases, not alternative product names. New
interfaces must explain them as legacy compatibility identifiers only when a
user needs to see one.

## Route naming

The public NAAvOS website is `https://naavos.radoss.agency` and the current
branded MCP route is `https://mcp.naavos.radoss.agency/mcp`. The retired
`api.naavos.io/mcp/v1` hostname must never be introduced into new code or
documentation.
