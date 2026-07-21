# PRODUCT_CLASS: functional
# FEP — Flora Economic Protocol (headless / embeddable)
#
# Spec: Documents/fep/FEP.md; currency layer (LIV): Documents/fep/LIV.md
# Crates: flora-economy-crypto (kernel), flora-economy-contracts, flora-economy (runtime, own tables),
#         flora-economy-wasm (C-ABI wasm32 surface for client L2 replay),
#         flora-economy-witness (reference witness daemon: observe -> verify -> cosign, fork detection).
# Client SDK: Packages/flora-client-core/src/economy (wallet, L0/L1 light client, FepWasmVerifier loader).
# Golden vectors: Documents/test-vectors/fep/ (regen: cargo run -p flora-economy-crypto --example gen_vectors).
#   Consumer tests: Rust tests/fep_vectors.rs; TS fepVectors.test.ts + wasm.test.ts (bit-for-bit parity).
