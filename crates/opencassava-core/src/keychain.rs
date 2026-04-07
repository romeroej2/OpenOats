use keyring::Entry;

const SERVICE: &str = "com.openoats.app";

pub struct KeyEntry {
    entry: Entry,
}

impl KeyEntry {
    fn new(key: &str) -> Self {
        Self {
            entry: Entry::new(SERVICE, key).expect("keyring entry creation failed"),
        }
    }

    pub fn new_with_service(service: &str, key: &str) -> Self {
        Self {
            entry: Entry::new(service, key).expect("keyring entry creation failed"),
        }
    }

    pub fn open_router_api_key() -> Self {
        Self::new("openRouterApiKey")
    }
    pub fn voyage_api_key() -> Self {
        Self::new("voyageApiKey")
    }
    pub fn open_ai_llm_api_key() -> Self {
        Self::new("openAILLMApiKey")
    }
    pub fn open_ai_embed_api_key() -> Self {
        Self::new("openAIEmbedApiKey")
    }
    pub fn hugging_face_token() -> Self {
        Self::new("huggingFaceToken")
    }

    pub fn save(&self, value: &str) -> Result<(), keyring::Error> {
        self.entry.set_password(value)
    }

    pub fn save_or_delete(&self, value: &str) -> Result<(), keyring::Error> {
        if value.trim().is_empty() {
            match self.entry.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err),
            }
        } else {
            self.entry.set_password(value)
        }
    }

    pub fn load(&self) -> Option<String> {
        self.entry.get_password().ok()
    }

    pub fn delete(&self) -> Result<(), keyring::Error> {
        self.entry.delete_credential()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_roundtrip() {
        let entry = KeyEntry::new_with_service("openoats-test", "test_api_key");
        entry.save("sk-test-value-123").unwrap();
        let loaded = entry.load().unwrap();
        assert_eq!(loaded, "sk-test-value-123");
        entry.delete().ok();
    }

    #[test]
    fn load_missing_key_returns_none() {
        let entry = KeyEntry::new_with_service("openoats-test", "definitely_does_not_exist_xyz");
        let result = entry.load();
        assert!(result.is_none());
    }
}
