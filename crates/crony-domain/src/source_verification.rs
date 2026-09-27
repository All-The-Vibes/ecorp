use serde::{Deserialize, Serialize};

pub const CANONICAL_SOURCE_VERIFICATION_CAPABILITY: &str = "canonical-source-verification-v1";

/// Identity of the complete canonical Git tree and explicitly separate local build inputs.
/// The candidate commit supplies temporary Git context; export must retain its tree, not metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceVerification {
    pub tree: String,
    pub base_commit: String,
    pub candidate_commit: String,
    pub ignored_input_sha256: String,
    pub ignored_input_count: usize,
    pub ignored_input_bytes: u64,
}

impl SourceVerification {
    /// New verification events and signed upload metadata must agree on the same tree.
    /// Historical artifacts can still be read; this is an admission rule for new completion.
    pub fn from_payload(payload: &serde_json::Value) -> Result<Self, &'static str> {
        let source_payload = payload
            .get("source_verification")
            .ok_or("source verification identity is missing")?;
        if !source_payload.is_object() {
            return Err("source verification identity is malformed");
        }
        let source: Self = serde_json::from_value(source_payload.clone())
            .map_err(|_| "source verification identity is malformed")?;
        if !source.is_valid()
            || payload
                .get("verified_tree")
                .and_then(serde_json::Value::as_str)
                != Some(&source.tree)
            || payload
                .get("base_commit")
                .is_some_and(|base| base.as_str() != Some(&source.base_commit))
        {
            return Err("source verification tree or base does not match");
        }
        Ok(source)
    }

    pub fn is_valid(&self) -> bool {
        let hex = |value: &str, len| {
            value.len() == len
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        matches!(self.tree.len(), 40 | 64)
            && hex(&self.tree, self.tree.len())
            && hex(&self.base_commit, self.tree.len())
            && hex(&self.candidate_commit, self.tree.len())
            && hex(&self.ignored_input_sha256, 64)
            && self.ignored_input_count <= 100_000
            && self.ignored_input_bytes <= 4 * 1024 * 1024 * 1024
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue82_source_payload_requires_matching_canonical_identity() {
        let source = SourceVerification {
            tree: "a".repeat(40),
            base_commit: "b".repeat(40),
            candidate_commit: "c".repeat(40),
            ignored_input_sha256: "d".repeat(64),
            ignored_input_count: 1,
            ignored_input_bytes: 128,
        };
        let payload = serde_json::json!({
            "source_verification": source, "verified_tree": source.tree,
            "base_commit": source.base_commit,
        });
        assert_eq!(
            SourceVerification::from_payload(&payload),
            Ok(source.clone())
        );
        let mut event = payload.clone();
        event.as_object_mut().unwrap().remove("base_commit");
        assert_eq!(SourceVerification::from_payload(&event), Ok(source));
        for field in ["source_verification", "verified_tree"] {
            let mut missing = payload.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                SourceVerification::from_payload(&missing).is_err(),
                "missing {field}"
            );
        }
        for field in ["verified_tree", "base_commit"] {
            let mut mismatch = payload.clone();
            mismatch[field] = serde_json::json!("e".repeat(40));
            assert!(
                SourceVerification::from_payload(&mismatch).is_err(),
                "mismatched {field}"
            );
        }
        for (field, value) in [
            ("candidate_commit", serde_json::json!("C".repeat(40))),
            ("tree", serde_json::Value::Null),
            ("ignored_input_count", serde_json::json!(1.5)),
            (
                "ignored_input_bytes",
                serde_json::json!(4_u64 * 1024 * 1024 * 1024 + 1),
            ),
            ("unrecognized", serde_json::json!(true)),
        ] {
            let mut malformed = payload.clone();
            malformed["source_verification"][field] = value;
            assert!(
                SourceVerification::from_payload(&malformed).is_err(),
                "malformed {field}"
            );
        }
    }

    #[test]
    fn source_payload_rejects_positional_array_identity() {
        let payload = serde_json::json!({
            "verified_tree": "a".repeat(40),
            "base_commit": "b".repeat(40),
            "source_verification": [
                "a".repeat(40), "b".repeat(40), "c".repeat(40),
                "d".repeat(64), 1, 128,
            ],
        });
        assert_eq!(
            SourceVerification::from_payload(&payload),
            Err("source verification identity is malformed")
        );
    }

    #[test]
    fn source_verification_requires_full_consistent_object_ids_and_bounded_inputs() {
        for len in [40, 64] {
            let source = SourceVerification {
                tree: "a".repeat(len),
                base_commit: "b".repeat(len),
                candidate_commit: "c".repeat(len),
                ignored_input_sha256: "d".repeat(64),
                ignored_input_count: 1,
                ignored_input_bytes: 128,
            };
            assert!(source.is_valid());
            let mut bad = source.clone();
            bad.tree.pop();
            assert!(!bad.is_valid());
            bad = source.clone();
            bad.base_commit = "e".repeat(if len == 40 { 64 } else { 40 });
            assert!(!bad.is_valid());
            bad = source.clone();
            bad.candidate_commit = "G".repeat(len);
            assert!(!bad.is_valid());
            bad = source.clone();
            bad.ignored_input_count = 100_001;
            assert!(!bad.is_valid());
            bad = source.clone();
            bad.ignored_input_bytes = 4 * 1024 * 1024 * 1024 + 1;
            assert!(!bad.is_valid());
            bad = source;
            bad.ignored_input_sha256 = "x".repeat(64);
            assert!(!bad.is_valid());
        }
    }
}
