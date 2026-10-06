use ed25519_dalek::{Signer, SigningKey};
use getrandom::{
    SysRng,
    rand_core::{CryptoRng, TryCryptoRng, TryRng, UnwrapErr},
};
use serde_json::Value;
use std::io;

// Test-only source. Production always uses the operating system's SysRng.
struct PublicSeedSource {
    seed: [u8; 32],
    calls: usize,
    fail: bool,
}

impl TryRng for PublicSeedSource {
    type Error = io::Error;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        panic!("key generation must request the seed bytes directly")
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        panic!("key generation must request the seed bytes directly")
    }

    fn try_fill_bytes(&mut self, destination: &mut [u8]) -> Result<(), Self::Error> {
        self.calls += 1;
        if self.fail {
            return Err(io::Error::other("synthetic entropy failure"));
        }
        assert_eq!(destination.len(), 32);
        destination.copy_from_slice(&self.seed);
        Ok(())
    }
}

impl TryCryptoRng for PublicSeedSource {}

#[test]
fn generated_public_key_and_signature_match_frozen_seed_vector() {
    let oracle: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/ed25519-compatibility-v1.json"
    ))
    .unwrap();
    let mut source = PublicSeedSource {
        seed: [7; 32],
        calls: 0,
        fail: false,
    };
    let key = SigningKey::generate(&mut UnwrapErr(&mut source));
    assert_eq!(source.calls, 1);
    assert_eq!(
        hex::encode(key.verifying_key().to_bytes()),
        oracle["keys"][1]["public_key_hex"]
    );
    let receipt_signature = oracle["signatures"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["key"] == "seed-1" && case["message"] == "receipt-payload")
        .unwrap();
    let message = hex::decode(receipt_signature["message_hex"].as_str().unwrap()).unwrap();
    assert_eq!(
        hex::encode(key.sign(&message).to_bytes()),
        receipt_signature["signature_hex"]
    );
}

#[test]
fn entropy_failure_stops_generation_without_fallback() {
    let failed = std::panic::catch_unwind(|| {
        let mut source = PublicSeedSource {
            seed: [0; 32],
            calls: 0,
            fail: true,
        };
        SigningKey::generate(&mut UnwrapErr(&mut source))
    });
    assert!(failed.is_err(), "failed entropy must never yield a key");
}

#[test]
fn production_os_source_satisfies_crypto_rng_contract() {
    fn crypto_source<T: CryptoRng>() {}
    // Compile-time proof only; this test does not generate a real identity.
    crypto_source::<UnwrapErr<SysRng>>();
}
