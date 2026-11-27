use anyhow::{anyhow, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{aead, pbkdf2, rand::{SecureRandom, SystemRandom}, signature::{Ed25519KeyPair, KeyPair}};
use serde::Serialize;
use std::num::NonZeroU32;
use zeroize::Zeroizing;

const HEADER: &[u8] = b"KORERO-IDENTITY-1";
const ITERATIONS: NonZeroU32 = NonZeroU32::new(600_000).unwrap();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredIdentity {
    public_key: String,
    private_key: String,
}

fn stored(key: &[u8]) -> Result<StoredIdentity> {
    Ok(StoredIdentity {
        public_key: public_key(&decode(key)?),
        private_key: URL_SAFE_NO_PAD.encode(key),
    })
}

fn decode(key: &[u8]) -> Result<Ed25519KeyPair> {
    Ed25519KeyPair::from_pkcs8(key).map_err(|_| anyhow!("Invalid Korero.chat identity key"))
}

fn decode_stored(key: &str) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(key.len() <= 256, "Invalid Korero.chat identity key");
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.decode(key).context("Invalid Korero.chat identity key")?))
}

pub fn generate() -> Result<StoredIdentity> {
    let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .map_err(|_| anyhow!("Could not generate an identity key"))?;
    stored(key.as_ref())
}

pub fn load(key: &str) -> Result<Ed25519KeyPair> {
    decode(&decode_stored(key)?)
}

pub fn public_key(key: &Ed25519KeyPair) -> String {
    URL_SAFE_NO_PAD.encode(key.public_key().as_ref())
}

pub fn sign(key: &Ed25519KeyPair, transcript: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(key.sign(transcript).as_ref())
}

fn wrapping_key(passphrase: &str, salt: &[u8]) -> Result<aead::LessSafeKey> {
    ensure!(passphrase.chars().count() >= 12, "Use a passphrase of at least 12 characters");
    let mut bytes = Zeroizing::new([0u8; 32]);
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, ITERATIONS, salt, passphrase.as_bytes(), bytes.as_mut());
    Ok(aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, bytes.as_ref())
        .map_err(|_| anyhow!("Could not initialize identity encryption"))?))
}

fn encrypt(key: &[u8], passphrase: &str) -> Result<String> {
    let rng = SystemRandom::new();
    let mut salt = [0; 16];
    let mut nonce = [0; 12];
    rng.fill(&mut salt).and_then(|_| rng.fill(&mut nonce)).map_err(|_| anyhow!("Could not generate encryption parameters"))?;
    let mut sealed = Zeroizing::new(key.to_vec());
    wrapping_key(passphrase, &salt)?.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::from(HEADER), &mut *sealed).map_err(|_| anyhow!("Could not encrypt identity"))?;
    let mut output = HEADER.to_vec();
    output.extend(salt);
    output.extend(nonce);
    output.extend_from_slice(&sealed);
    Ok(URL_SAFE_NO_PAD.encode(output))
}

fn decrypt(blob: &str, passphrase: &str) -> Result<Zeroizing<Vec<u8>>> {
    ensure!(blob.len() <= 1024, "Invalid Korero.chat identity export");
    let bytes = URL_SAFE_NO_PAD.decode(blob.trim()).context("Invalid Korero.chat identity export")?;
    let parameters = bytes.strip_prefix(HEADER).filter(|value| value.len() > 44)
        .context("Invalid Korero.chat identity export")?;
    let mut sealed = Zeroizing::new(parameters[28..].to_vec());
    let opened = wrapping_key(passphrase, &parameters[..16])?.open_in_place(
        aead::Nonce::assume_unique_for_key(parameters[16..28].try_into()?),
        aead::Aad::from(HEADER), &mut sealed).map_err(|_| anyhow!("Incorrect passphrase or damaged identity export"))?;
    Ok(Zeroizing::new(opened.to_vec()))
}

pub fn export(key: &str, passphrase: &str) -> Result<String> {
    let key = decode_stored(key)?;
    decode(&key)?;
    encrypt(&key, passphrase)
}

pub fn import(blob: &str, passphrase: &str) -> Result<StoredIdentity> {
    stored(&decrypt(blob, passphrase)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_export_round_trips_and_rejects_wrong_password() -> Result<()> {
        let key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let password = "a sufficiently long passphrase";
        let blob = encrypt(key.as_ref(), password)?;
        assert_eq!(&*decrypt(&blob, password)?, key.as_ref());
        assert!(decrypt(&blob, "a different passphrase").is_err());
        let mut damaged = URL_SAFE_NO_PAD.decode(blob)?;
        *damaged.last_mut().unwrap() ^= 1;
        assert!(decrypt(&URL_SAFE_NO_PAD.encode(damaged), password).is_err());
        Ok(())
    }
}
