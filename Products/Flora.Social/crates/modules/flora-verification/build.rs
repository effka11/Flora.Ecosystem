fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../Infrastructure/Flora.gRPC/Protos/verification.proto"
    );
    let include = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../../Infrastructure/Flora.gRPC/Protos"
    );
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(&[proto], &[include])?;
    Ok(())
}
