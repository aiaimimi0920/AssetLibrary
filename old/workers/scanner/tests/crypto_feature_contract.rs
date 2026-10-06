#[test]
fn nats_and_package_signing_keys_keep_zeroize_drop_guards() {
    // In pinned dalek 2.2.0, SigningKey's Drop implementation is gated by
    // zeroize. No key is created and no legacy signature API is invoked here.
    assert!(std::mem::needs_drop::<ed25519_dalek_nats::SigningKey>());
    assert!(std::mem::needs_drop::<ed25519_dalek::SigningKey>());
}
