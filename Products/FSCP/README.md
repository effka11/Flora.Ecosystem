# PRODUCT_CLASS: functional
# FSCP — Flora Secure Communication Protocol (headless / embeddable)
#
# Spec: Documents/fscp/FSCP.md
# Scope: wire format + crypto + server wire-validator + client session FSM.
# Not in scope (Social Messaging / Documents/fscp/e2e-security.md): epochs, key backup API, devices.
#
# Rust: crates/fscp-{contracts,core,crypto} (members of Backend/ workspace)
# TypeScript SoT: ts/ (@flora/fscp); @flora/client-core/fscp re-exports this tree.
