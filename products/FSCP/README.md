# PRODUCT_CLASS: functional
# FSCP — Flora Secure Communication Protocol (headless / embeddable)
#
# Spec: documents/fscp/FSCP.md
# Scope: wire format + crypto + server wire-validator + client session FSM.
# Not in scope (Social Messaging / documents/fscp/e2e-security.md): epochs, key backup API, devices.
#
# Rust: crates/fscp-{contracts,core,crypto} (members of backend/ workspace)
# TypeScript SoT: ts/ (@flora/fscp); @flora/client-core/fscp re-exports this tree.
