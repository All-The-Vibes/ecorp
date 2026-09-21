use anyhow::{Result, anyhow};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, KeyInit, Nonce,
    aead::{Aead, AeadCore, OsRng, Payload},
};
use uuid::Uuid;

use crate::auth::ServerMode;

const DEVELOPMENT_KEY_HEX: &str =
    "a5c3f1458279dfb241239378dbefa6b8d2ab32703cba1768343712fd37ac1f04";

// Configuration errors retain only fixed diagnostics, never input values or
// decoder error chains. Startup can propagate them without losing the reason.
#[derive(Debug, thiserror::Error)]
pub enum SecretKeyError {
    #[error("CRONY_SECRET_MASTER_KEY_HEX is required in production mode")]
    Missing,
    #[error("invalid CRONY_SECRET_MASTER_KEY_HEX: expected a 32-byte hexadecimal key")]
    Invalid,
    #[error("CRONY_SECRET_MASTER_KEY_HEX must use a deployment-specific key in production mode")]
    DevelopmentKey,
}

#[derive(Clone)]
pub struct SecretCipher {
    cipher: ChaCha20Poly1305,
}

impl SecretCipher {
    pub fn initialize(
        mode: ServerMode,
        configured_key_hex: Option<&str>,
    ) -> Result<Self, SecretKeyError> {
        let key_hex = match (mode, configured_key_hex) {
            (_, Some(value)) if !value.trim().is_empty() => value.trim(),
            (ServerMode::Development, _) => DEVELOPMENT_KEY_HEX,
            (ServerMode::Production, _) => {
                return Err(SecretKeyError::Missing);
            }
        };
        let key = hex::decode(key_hex).map_err(|_| SecretKeyError::Invalid)?;
        if key.len() != 32 {
            return Err(SecretKeyError::Invalid);
        }
        if mode == ServerMode::Production && key_hex.eq_ignore_ascii_case(DEVELOPMENT_KEY_HEX) {
            return Err(SecretKeyError::DevelopmentKey);
        }
        Ok(Self {
            cipher: ChaCha20Poly1305::new(Key::from_slice(&key)),
        })
    }

    pub fn encrypt(
        &self,
        corp_id: Uuid,
        secret_id: Uuid,
        name: &str,
        plaintext: &[u8],
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
        let aad = associated_data(corp_id, secret_id, name);
        let ciphertext = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow!("encrypt secret"))?;
        Ok((ciphertext, nonce.to_vec()))
    }

    pub fn decrypt(
        &self,
        corp_id: Uuid,
        secret_id: Uuid,
        name: &str,
        ciphertext: &[u8],
        nonce: &[u8],
    ) -> Result<Vec<u8>> {
        if nonce.len() != 12 {
            return Err(anyhow!("stored secret nonce has an invalid length"));
        }
        let aad = associated_data(corp_id, secret_id, name);
        self.cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow!("decrypt secret"))
    }
}

fn associated_data(corp_id: Uuid, secret_id: Uuid, name: &str) -> String {
    format!("{corp_id}:{secret_id}:{name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn development_key_variants() -> Vec<String> {
        vec![
            DEVELOPMENT_KEY_HEX.to_owned(),
            DEVELOPMENT_KEY_HEX.to_ascii_uppercase(),
            format!(" \t{DEVELOPMENT_KEY_HEX}\r\n"),
            format!("\n {} \t", DEVELOPMENT_KEY_HEX.to_ascii_uppercase()),
            format!("\u{00a0}{DEVELOPMENT_KEY_HEX}\u{2003}"),
            DEVELOPMENT_KEY_HEX
                .chars()
                .enumerate()
                .map(|(index, letter)| {
                    if index % 2 == 0 {
                        letter.to_ascii_uppercase()
                    } else {
                        letter
                    }
                })
                .collect(),
        ]
    }

    #[test]
    fn production_rejects_public_development_key_variants_without_disclosure() {
        for configured in development_key_variants() {
            let error = SecretCipher::initialize(ServerMode::Production, Some(&configured))
                .err()
                .expect("production must reject the public development fixture key");
            assert!(error.to_string().contains("production"));
            assert!(!format!("{error:#}").contains(DEVELOPMENT_KEY_HEX));
            assert!(!format!("{error:#}").contains(&DEVELOPMENT_KEY_HEX.to_ascii_uppercase()));
        }
    }

    #[test]
    fn development_keeps_default_and_explicit_fixture_key_compatibility() {
        let default = SecretCipher::initialize(ServerMode::Development, None)
            .expect("default development cipher");
        let corp_id = Uuid::new_v4();
        let secret_id = Uuid::new_v4();
        let (ciphertext, nonce) = default
            .encrypt(corp_id, secret_id, "fixture", b"fixture plaintext")
            .expect("encrypt development fixture");
        for configured in development_key_variants() {
            let explicit = SecretCipher::initialize(ServerMode::Development, Some(&configured))
                .expect("explicit development fixture remains supported");
            assert_eq!(
                explicit
                    .decrypt(corp_id, secret_id, "fixture", &ciphertext, &nonce)
                    .expect("read an existing development fixture"),
                b"fixture plaintext"
            );
        }
    }

    #[test]
    fn production_keeps_other_valid_keys_and_normalization() {
        let configured = hex::encode([0x5a; 32]);
        let writer = SecretCipher::initialize(ServerMode::Production, Some(&configured))
            .expect("valid production key");
        let normalized = format!(" \t{}\r\n", configured.to_ascii_uppercase());
        let reader = SecretCipher::initialize(ServerMode::Production, Some(&normalized))
            .expect("valid normalized production key");
        let corp_id = Uuid::new_v4();
        let secret_id = Uuid::new_v4();
        let (ciphertext, nonce) = writer
            .encrypt(corp_id, secret_id, "fixture", b"fixture plaintext")
            .expect("encrypt production fixture");
        assert_eq!(
            reader
                .decrypt(corp_id, secret_id, "fixture", &ciphertext, &nonce)
                .expect("read with the same normalized deployment key"),
            b"fixture plaintext"
        );
    }

    #[test]
    fn production_still_requires_a_well_formed_32_byte_key() {
        for configured in [None, Some(""), Some(" \t\r\n"), Some("not-hex"), Some("ab")] {
            assert!(SecretCipher::initialize(ServerMode::Production, configured).is_err());
        }
    }

    #[test]
    fn nonces_are_not_constrained_to_uuid_v4_fixed_bits() {
        let cipher = SecretCipher::initialize(ServerMode::Development, None).unwrap();
        let corp_id = Uuid::new_v4();
        let secret_id = Uuid::new_v4();
        let mut non_v4_version = false;
        let mut non_uuid_variant = false;
        // Detect the historical truncated-UUID pattern, not entropy quality.
        // Random samples can still match either fixed field by chance.
        for _ in 0..32 {
            let (_, nonce) = cipher
                .encrypt(corp_id, secret_id, "fixture", b"same plaintext")
                .unwrap();
            assert_eq!(nonce.len(), 12);
            non_v4_version |= nonce[6] & 0xf0 != 0x40;
            non_uuid_variant |= nonce[8] & 0xc0 != 0x80;
        }
        assert!(
            non_v4_version && non_uuid_variant,
            "nonce samples retain UUID fixed fields: non_v4_version={non_v4_version}, non_uuid_variant={non_uuid_variant}"
        );
    }

    #[test]
    fn repeated_plaintext_uses_fresh_authenticated_nonces() {
        let cipher = SecretCipher::initialize(ServerMode::Development, None).unwrap();
        let corp_id = Uuid::new_v4();
        let secret_id = Uuid::new_v4();
        let first = cipher
            .encrypt(corp_id, secret_id, "fixture", b"same plaintext")
            .unwrap();
        let second = cipher
            .encrypt(corp_id, secret_id, "fixture", b"same plaintext")
            .unwrap();
        assert_eq!(first.1.len(), 12);
        assert_eq!(second.1.len(), 12);
        assert_ne!(first.1, second.1);
        assert_ne!(first.0, second.0);
        for (ciphertext, nonce) in [first, second] {
            assert_eq!(
                cipher
                    .decrypt(corp_id, secret_id, "fixture", &ciphertext, &nonce)
                    .unwrap(),
                b"same plaintext"
            );
        }
    }

    #[test]
    fn ciphertext_is_bound_to_corp_secret_and_name() {
        let cipher =
            SecretCipher::initialize(ServerMode::Development, None).expect("development cipher");
        let corp_id = Uuid::new_v4();
        let secret_id = Uuid::new_v4();
        let (ciphertext, nonce) = cipher
            .encrypt(corp_id, secret_id, "deploy-token", b"super-secret")
            .expect("encrypt");
        assert_ne!(ciphertext, b"super-secret");
        assert_eq!(
            cipher
                .decrypt(corp_id, secret_id, "deploy-token", &ciphertext, &nonce)
                .expect("decrypt"),
            b"super-secret"
        );
        assert!(
            cipher
                .decrypt(
                    Uuid::new_v4(),
                    secret_id,
                    "deploy-token",
                    &ciphertext,
                    &nonce
                )
                .is_err()
        );
    }
}
