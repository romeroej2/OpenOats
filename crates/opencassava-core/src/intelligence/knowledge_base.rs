use crate::intelligence::embedding_client::cosine_similarity;
use crate::models::KBResult;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KbChunk {
    pub text: String,
    pub source_file: String,
    pub header_context: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedFileEntry {
    hash: String,
    chunks: Vec<KbChunk>,
}

#[derive(Serialize, Deserialize, Default)]
struct KbCache {
    entries: HashMap<String, CachedFileEntry>,
    config_fingerprint: String,
    root_marker: String,
}

pub struct KnowledgeBase {
    entries: HashMap<String, CachedFileEntry>,
    pub chunks: Vec<KbChunk>,
    cache_path: PathBuf,
    config_fingerprint: String,
    root_marker: String,
}

impl KnowledgeBase {
    pub fn new(cache_path: PathBuf, config_fingerprint: String, root_marker: String) -> Self {
        let entries =
            Self::load_cache(&cache_path, &config_fingerprint, &root_marker).unwrap_or_default();
        let chunks = flatten_chunks(&entries);
        Self {
            entries,
            chunks,
            cache_path,
            config_fingerprint,
            root_marker,
        }
    }

    pub async fn index<F, Fut>(&mut self, folder: &Path, embed_fn: F) -> Result<usize, String>
    where
        F: Fn(Vec<String>) -> Fut,
        Fut: std::future::Future<Output = Result<Vec<Vec<f32>>, String>>,
    {
        self.index_with_paths(folder, &[folder.to_path_buf()], &[], embed_fn)
            .await
    }

    pub async fn index_with_paths<F, Fut>(
        &mut self,
        root: &Path,
        include_paths: &[PathBuf],
        exclude_relative_paths: &[PathBuf],
        embed_fn: F,
    ) -> Result<usize, String>
    where
        F: Fn(Vec<String>) -> Fut,
        Fut: std::future::Future<Output = Result<Vec<Vec<f32>>, String>>,
    {
        let files = collect_files(root, include_paths, exclude_relative_paths);
        let mut embedded_chunks = 0usize;
        let mut seen_relative_paths = HashSet::new();

        for (relative_path, absolute_path) in files {
            seen_relative_paths.insert(relative_path.clone());
            let content = std::fs::read_to_string(&absolute_path)
                .map_err(|err| format!("Read {}: {err}", absolute_path.display()))?;
            let hash = content_hash(&content);

            if self
                .entries
                .get(&relative_path)
                .map(|entry| entry.hash == hash)
                .unwrap_or(false)
            {
                continue;
            }

            let raw_chunks = chunk_markdown(&content);
            if raw_chunks.is_empty() {
                self.entries.remove(&relative_path);
                continue;
            }

            let texts: Vec<String> = raw_chunks.iter().map(|(text, _)| text.clone()).collect();
            let embeddings = embed_fn(texts).await?;

            if embeddings.len() != raw_chunks.len() {
                return Err(format!(
                    "Embedding count mismatch for {}: expected {}, got {}",
                    relative_path,
                    raw_chunks.len(),
                    embeddings.len()
                ));
            }

            let chunks = raw_chunks
                .into_iter()
                .zip(embeddings.into_iter())
                .map(|((text, header_context), embedding)| KbChunk {
                    text,
                    source_file: relative_path.clone(),
                    header_context,
                    embedding,
                })
                .collect::<Vec<_>>();

            embedded_chunks += chunks.len();
            self.entries
                .insert(relative_path, CachedFileEntry { hash, chunks });
        }

        self.entries
            .retain(|relative_path, _| seen_relative_paths.contains(relative_path));
        self.rebuild_chunks();
        self.save_cache();
        Ok(embedded_chunks)
    }

    pub fn search(&self, query_embedding: &[f32], top_k: usize, threshold: f32) -> Vec<KBResult> {
        search_chunks(&self.chunks, query_embedding, top_k, threshold)
    }

    pub fn is_indexed(&self) -> bool {
        !self.chunks.is_empty()
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    fn rebuild_chunks(&mut self) {
        self.chunks = flatten_chunks(&self.entries);
    }

    fn save_cache(&self) {
        if let Some(parent) = self.cache_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let cache = KbCache {
            entries: self.entries.clone(),
            config_fingerprint: self.config_fingerprint.clone(),
            root_marker: self.root_marker.clone(),
        };

        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = std::fs::write(&self.cache_path, json);
        }
    }

    fn load_cache(
        path: &Path,
        fingerprint: &str,
        root_marker: &str,
    ) -> Option<HashMap<String, CachedFileEntry>> {
        let data = std::fs::read_to_string(path).ok()?;
        let cache: KbCache = serde_json::from_str(&data).ok()?;
        if cache.config_fingerprint != fingerprint || cache.root_marker != root_marker {
            return None;
        }
        Some(cache.entries)
    }
}

pub fn search_chunks(
    chunks: &[KbChunk],
    query_embedding: &[f32],
    top_k: usize,
    threshold: f32,
) -> Vec<crate::models::KBResult> {
    let mut scored: Vec<(f32, &KbChunk)> = chunks
        .iter()
        .map(|chunk| (cosine_similarity(query_embedding, &chunk.embedding), chunk))
        .filter(|(score, _)| *score >= threshold)
        .collect();
    scored.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
        .into_iter()
        .take(top_k)
        .map(|(score, chunk)| crate::models::KBResult {
            id: Uuid::new_v4(),
            text: chunk.text.clone(),
            source_file: chunk.source_file.clone(),
            header_context: chunk.header_context.clone(),
            score: score as f64,
        })
        .collect()
}

fn flatten_chunks(entries: &HashMap<String, CachedFileEntry>) -> Vec<KbChunk> {
    let mut ordered_entries = entries.iter().collect::<Vec<_>>();
    ordered_entries.sort_by(|left, right| left.0.cmp(right.0));
    ordered_entries
        .into_iter()
        .flat_map(|(_, entry)| entry.chunks.clone())
        .collect()
}

fn collect_files(
    root: &Path,
    include_paths: &[PathBuf],
    exclude_relative_paths: &[PathBuf],
) -> Vec<(String, PathBuf)> {
    let mut files = BTreeMap::new();
    let normalized_excludes = exclude_relative_paths
        .iter()
        .map(|path| normalize_relative_path(path))
        .collect::<Vec<_>>();

    if include_paths.is_empty() {
        return Vec::new();
    }

    for include_path in include_paths {
        let absolute_path = if include_path.is_absolute() {
            include_path.clone()
        } else {
            root.join(include_path)
        };
        collect_files_from_path(root, &absolute_path, &normalized_excludes, &mut files);
    }

    files.into_iter().collect()
}

fn collect_files_from_path(
    root: &Path,
    absolute_path: &Path,
    exclude_relative_paths: &[String],
    files: &mut BTreeMap<String, PathBuf>,
) {
    let Ok(metadata) = std::fs::metadata(absolute_path) else {
        return;
    };

    if metadata.is_dir() {
        let Ok(entries) = std::fs::read_dir(absolute_path) else {
            return;
        };
        let mut child_paths = entries
            .flatten()
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        child_paths.sort();

        for child_path in child_paths {
            collect_files_from_path(root, &child_path, exclude_relative_paths, files);
        }
        return;
    }

    if !is_indexable_text_file(absolute_path) {
        return;
    }

    let Ok(relative_path) = absolute_path.strip_prefix(root) else {
        return;
    };
    let normalized_relative_path = normalize_relative_path(relative_path);
    if normalized_relative_path.is_empty()
        || is_excluded_relative_path(&normalized_relative_path, exclude_relative_paths)
    {
        return;
    }

    files.insert(normalized_relative_path, absolute_path.to_path_buf());
}

fn is_indexable_text_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("md") | Some("txt")
    )
}

fn is_excluded_relative_path(relative_path: &str, exclude_relative_paths: &[String]) -> bool {
    let components = relative_path.split('/').collect::<Vec<_>>();
    if components.iter().any(|component| *component == ".obsidian") {
        return true;
    }

    exclude_relative_paths.iter().any(|exclude| {
        relative_path == exclude
            || relative_path
                .strip_prefix(exclude)
                .map(|suffix| suffix.starts_with('/'))
                .unwrap_or(false)
    })
}

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn chunk_markdown(content: &str) -> Vec<(String, String)> {
    let mut chunks = Vec::new();
    let mut current_header = String::new();
    let mut current_text = String::new();

    for line in content.lines() {
        if line.starts_with('#') {
            if !current_text.trim().is_empty() {
                let text = current_text.trim().to_string();
                if count_words(&text) >= 10 {
                    chunks.push((text, current_header.clone()));
                }
            }
            current_header = line.trim_start_matches('#').trim().to_string();
            current_text = format!("{line}\n");
        } else {
            current_text.push_str(line);
            current_text.push('\n');

            if count_words(&current_text) > 400 {
                let text = current_text.trim().to_string();
                chunks.push((text.clone(), current_header.clone()));

                let words: Vec<&str> = text.split_whitespace().collect();
                let overlap_start = words.len().saturating_sub(80);
                current_text = words[overlap_start..].join(" ");
                current_text.push('\n');
            }
        }
    }

    if !current_text.trim().is_empty() {
        let text = current_text.trim().to_string();
        if count_words(&text) >= 10 {
            chunks.push((text, current_header.clone()));
        }
    }

    chunks
}

fn count_words(text: &str) -> usize {
    text.split_whitespace().count()
}

fn content_hash(text: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

    fn long_markdown(seed: &str) -> String {
        format!(
            "# {seed}\nThis file contains enough words to be indexed safely and reused across knowledge base refreshes without any ambiguity in the cache layer.\n"
        )
    }

    fn embedding_stub(
        counter: Arc<Mutex<usize>>,
    ) -> impl Fn(
        Vec<String>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Vec<Vec<f32>>, String>> + Send>,
    > {
        move |texts: Vec<String>| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                *counter.lock().unwrap() += texts.len();
                Ok(texts
                    .into_iter()
                    .map(|text| vec![text.len() as f32, 1.0, 0.0])
                    .collect())
            })
        }
    }

    #[test]
    fn chunk_markdown_splits_on_headers() {
        let markdown = "# Section 1\nThis is the first section with enough words to be included in the chunks output.\n# Section 2\nThis is the second section with enough words to also be included in the chunks output.\n";
        let chunks = chunk_markdown(markdown);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn search_returns_top_k_above_threshold() {
        let mut kb = KnowledgeBase::new(PathBuf::from("cache.json"), "test".into(), "root".into());
        kb.chunks.push(KbChunk {
            text: "test content".into(),
            source_file: "notes/test.md".into(),
            header_context: "Header".into(),
            embedding: vec![1.0, 0.0, 0.0],
        });

        let query = vec![1.0, 0.0, 0.0];
        let results = kb.search(&query, 5, 0.5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].source_file, "notes/test.md");
        assert!((results[0].score - 1.0).abs() < 1e-4);
    }

    #[test]
    fn search_chunks_finds_similar() {
        let chunks = vec![KbChunk {
            text: "relevant content".into(),
            source_file: "f.md".into(),
            header_context: "".into(),
            embedding: vec![1.0, 0.0, 0.0],
        }];
        let results = search_chunks(&chunks, &[1.0, 0.0, 0.0], 5, 0.5);
        assert_eq!(results.len(), 1);
        assert!((results[0].score - 1.0).abs() < 1e-4);
    }

    #[test]
    fn search_filters_below_threshold() {
        let chunks = vec![KbChunk {
            text: "test".into(),
            source_file: "f.md".into(),
            header_context: "".into(),
            embedding: vec![0.0, 1.0, 0.0],
        }];
        let results = search_chunks(&chunks, &[1.0, 0.0, 0.0], 5, 0.5);
        assert!(results.is_empty());
    }

    #[tokio::test]
    async fn index_supports_duplicate_basenames_in_different_folders() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("team-a")).unwrap();
        std::fs::create_dir_all(dir.path().join("team-b")).unwrap();
        std::fs::write(
            dir.path().join("team-a").join("notes.md"),
            long_markdown("A"),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("team-b").join("notes.md"),
            long_markdown("B"),
        )
        .unwrap();

        let counter = Arc::new(Mutex::new(0usize));
        let cache_path = dir.path().join("kb_cache.json");
        let mut kb = KnowledgeBase::new(
            cache_path,
            "embed-config".into(),
            dir.path().to_string_lossy().into_owned(),
        );
        kb.index_with_paths(
            dir.path(),
            &[dir.path().to_path_buf()],
            &[],
            embedding_stub(counter),
        )
        .await
        .unwrap();

        let source_files = kb
            .chunks
            .iter()
            .map(|chunk| chunk.source_file.clone())
            .collect::<HashSet<_>>();
        assert!(source_files.contains("team-a/notes.md"));
        assert!(source_files.contains("team-b/notes.md"));
    }

    #[tokio::test]
    async fn unchanged_files_reuse_cached_embeddings() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.md"), long_markdown("reuse")).unwrap();

        let cache_path = dir.path().join("kb_cache.json");
        let mut kb = KnowledgeBase::new(
            cache_path.clone(),
            "embed-config".into(),
            root.to_string_lossy().into_owned(),
        );
        let first_counter = Arc::new(Mutex::new(0usize));
        kb.index_with_paths(
            &root,
            &[root.clone()],
            &[],
            embedding_stub(first_counter.clone()),
        )
        .await
        .unwrap();
        assert_eq!(*first_counter.lock().unwrap(), 1);

        let mut reloaded = KnowledgeBase::new(
            cache_path,
            "embed-config".into(),
            root.to_string_lossy().into_owned(),
        );
        let second_counter = Arc::new(Mutex::new(0usize));
        reloaded
            .index_with_paths(
                &root,
                &[root.clone()],
                &[],
                embedding_stub(second_counter.clone()),
            )
            .await
            .unwrap();
        assert_eq!(*second_counter.lock().unwrap(), 0);
    }

    #[tokio::test]
    async fn changed_files_are_reembedded() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let note_path = root.join("note.md");
        std::fs::write(&note_path, long_markdown("first")).unwrap();

        let counter = Arc::new(Mutex::new(0usize));
        let mut kb = KnowledgeBase::new(
            dir.path().join("kb_cache.json"),
            "embed-config".into(),
            root.to_string_lossy().into_owned(),
        );
        kb.index_with_paths(&root, &[root.clone()], &[], embedding_stub(counter.clone()))
            .await
            .unwrap();

        std::fs::write(&note_path, long_markdown("second updated")).unwrap();
        kb.index_with_paths(&root, &[root.clone()], &[], embedding_stub(counter.clone()))
            .await
            .unwrap();

        assert_eq!(*counter.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn deleted_files_are_removed_from_index() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let note_path = root.join("note.md");
        std::fs::write(&note_path, long_markdown("delete")).unwrap();

        let counter = Arc::new(Mutex::new(0usize));
        let mut kb = KnowledgeBase::new(
            dir.path().join("kb_cache.json"),
            "embed-config".into(),
            root.to_string_lossy().into_owned(),
        );
        kb.index_with_paths(&root, &[root.clone()], &[], embedding_stub(counter))
            .await
            .unwrap();
        assert_eq!(kb.chunk_count(), 1);

        std::fs::remove_file(note_path).unwrap();
        kb.index_with_paths(
            &root,
            &[root.clone()],
            &[],
            embedding_stub(Arc::new(Mutex::new(0))),
        )
        .await
        .unwrap();
        assert_eq!(kb.chunk_count(), 0);
    }

    #[tokio::test]
    async fn indexing_respects_exclusions_and_relative_source_paths() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::create_dir_all(root.join("OpenCassava").join("Transcripts")).unwrap();
        std::fs::create_dir_all(root.join("Customer Notes")).unwrap();

        std::fs::write(
            root.join(".obsidian").join("config.md"),
            long_markdown("hidden config"),
        )
        .unwrap();
        std::fs::write(
            root.join("OpenCassava").join("Transcripts").join("raw.md"),
            long_markdown("transcript raw"),
        )
        .unwrap();
        std::fs::write(
            root.join("Customer Notes").join("account.md"),
            long_markdown("customer keep"),
        )
        .unwrap();

        let mut kb = KnowledgeBase::new(
            dir.path().join("kb_cache.json"),
            "embed-config".into(),
            root.to_string_lossy().into_owned(),
        );
        kb.index_with_paths(
            &root,
            &[root.clone()],
            &[PathBuf::from("OpenCassava/Transcripts")],
            embedding_stub(Arc::new(Mutex::new(0))),
        )
        .await
        .unwrap();

        let source_files = kb
            .chunks
            .iter()
            .map(|chunk| chunk.source_file.clone())
            .collect::<Vec<_>>();
        assert_eq!(source_files, vec!["Customer Notes/account.md".to_string()]);
    }
}
