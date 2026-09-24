use crate::{Address, Bytes, Error, Result, config::identifier, signing::NonExportableSigner};
use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::eip2718::Encodable2718,
    network::TxSigner,
};
use async_trait::async_trait;

pub struct AwsKmsSigner {
    signer: alloy::signers::aws::AwsSigner,
    immutable_key_identity: String,
    address: Address,
}
impl AwsKmsSigner {
    /// Only the isolated gateway receives this client and its KMS signing permission.
    /// Client credentials/endpoints are supplied by host administration, not application requests.
    pub async fn connect(
        client: aws_sdk_kms::Client,
        immutable_key_identity: String,
        chain_id: u64,
        expected_address: Address,
    ) -> Result<Self> {
        use aws_sdk_kms::types::{KeySpec, KeyState, KeyUsageType, OriginType};
        if !matches!(chain_id, 8453 | 84532)
            || expected_address.is_zero()
            || !immutable_key_identity.starts_with("arn:aws:kms:")
            || !immutable_key_identity.contains(":key/")
            || immutable_key_identity.contains(":alias/")
            || !identifier(&immutable_key_identity)
        {
            return Err(Error::Signing("immutable KMS key ARN required"));
        }
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            client.describe_key().key_id(&immutable_key_identity).send(),
        )
        .await
        .map_err(|_| Error::Signing("KMS identity timeout"))?
        .map_err(|_| Error::Signing("KMS identity unavailable"))?;
        let metadata = response
            .key_metadata
            .ok_or(Error::Signing("KMS metadata absent"))?;
        if metadata.arn.as_deref() != Some(immutable_key_identity.as_str())
            || metadata.key_spec != Some(KeySpec::EccSecgP256K1)
            || metadata.key_usage != Some(KeyUsageType::SignVerify)
            || metadata.origin != Some(OriginType::AwsKms)
            || metadata.key_state != Some(KeyState::Enabled)
        {
            return Err(Error::Signing(
                "KMS key must be enabled non-exportable secp256k1 signing key",
            ));
        }
        let signer = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            alloy::signers::aws::AwsSigner::new(
                client,
                immutable_key_identity.clone(),
                Some(chain_id),
            ),
        )
        .await
        .map_err(|_| Error::Signing("KMS public key timeout"))?
        .map_err(|_| Error::Signing("KMS public key unavailable"))?;
        let address = alloy::signers::Signer::address(&signer);
        if address != expected_address {
            return Err(Error::Signing("KMS publisher address mismatch"));
        }
        Ok(Self {
            signer,
            immutable_key_identity,
            address,
        })
    }
}
#[async_trait]
impl NonExportableSigner for AwsKmsSigner {
    fn address(&self) -> Address {
        self.address
    }
    fn immutable_key_identity(&self) -> &str {
        &self.immutable_key_identity
    }
    async fn sign_transaction(&self, mut transaction: TxEip1559) -> Result<Bytes> {
        let signature = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            self.signer.sign_transaction(&mut transaction),
        )
        .await
        .map_err(|_| Error::Signing("KMS signing outcome unknown"))?
        .map_err(|_| Error::Signing("KMS signing failed"))?;
        Ok(TxEnvelope::Eip1559(transaction.into_signed(signature))
            .encoded_2718()
            .into())
    }
}
