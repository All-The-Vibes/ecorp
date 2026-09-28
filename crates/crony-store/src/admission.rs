//! Explicit native admission denials, distinct from unavailable validation.
//!
//! Shared validators keep their existing policy and messages. Only a confirmed
//! denial of authority or proof receives this marker; database, transport and
//! pending workflow errors must retain their native retry semantics.

#[derive(Debug)]
pub(super) struct Denied(pub(super) String);

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Denied {}

pub(super) fn denied(message: impl Into<String>) -> anyhow::Error {
    Denied(message.into()).into()
}

/// Mark a pure policy/proof validation error, preserving its original cause.
/// Never apply this to an asynchronous validator or a database operation.
pub(super) fn validation(error: impl Into<anyhow::Error>) -> anyhow::Error {
    let error = error.into();
    let message = error.to_string();
    error.context(Denied(message))
}
