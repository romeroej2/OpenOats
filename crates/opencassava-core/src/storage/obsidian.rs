use crate::models::{EnhancedNotes, SessionRecord};
use chrono::{DateTime, Datelike, Utc};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObsidianVaultConfig {
    pub vault_path: PathBuf,
    pub notes_folder: PathBuf,
    pub transcripts_folder: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedObsidianPaths {
    pub note_path: PathBuf,
    pub transcript_path: PathBuf,
}

impl ObsidianVaultConfig {
    pub fn new(
        vault_path: PathBuf,
        notes_folder: impl AsRef<str>,
        transcripts_folder: impl AsRef<str>,
    ) -> Self {
        Self {
            vault_path,
            notes_folder: normalize_relative_folder(notes_folder.as_ref()),
            transcripts_folder: normalize_relative_folder(transcripts_folder.as_ref()),
        }
    }

    pub fn canonical_paths(
        &self,
        session_id: &str,
        started_at: DateTime<Utc>,
    ) -> PublishedObsidianPaths {
        let note_dir = self
            .vault_path
            .join(&self.notes_folder)
            .join(format!("{:04}", started_at.year()))
            .join(format!("{:02}", started_at.month()));
        let transcript_dir = self
            .vault_path
            .join(&self.transcripts_folder)
            .join(format!("{:04}", started_at.year()))
            .join(format!("{:02}", started_at.month()));

        PublishedObsidianPaths {
            note_path: note_dir.join(format!("{session_id}.md")),
            transcript_path: transcript_dir
                .join(format!("{}.md", transcript_file_stem(session_id))),
        }
    }

    pub fn publish_session(
        &self,
        session_id: &str,
        started_at: DateTime<Utc>,
        notes: &EnhancedNotes,
        transcript: &[SessionRecord],
    ) -> Result<PublishedObsidianPaths, String> {
        let paths = self.canonical_paths(session_id, started_at);
        let note_markdown = build_session_note_markdown(
            session_id,
            started_at,
            notes,
            &self.vault_path,
            &paths.transcript_path,
        )?;
        let transcript_markdown = build_transcript_markdown(
            session_id,
            started_at,
            &self.vault_path,
            &paths.note_path,
            transcript,
        )?;

        write_text_file(&paths.note_path, &note_markdown)?;
        write_text_file(&paths.transcript_path, &transcript_markdown)?;
        Ok(paths)
    }
}

pub fn normalize_relative_folder(input: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for segment in input.split(['/', '\\']) {
        let trimmed = segment.trim();
        if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
            continue;
        }
        path.push(trimmed);
    }
    path
}

fn transcript_file_stem(session_id: &str) -> String {
    if let Some(suffix) = session_id.strip_prefix("session_") {
        format!("transcript_{suffix}")
    } else if session_id.starts_with("transcript_") {
        session_id.to_string()
    } else {
        format!("transcript_{session_id}")
    }
}

fn build_session_note_markdown(
    session_id: &str,
    started_at: DateTime<Utc>,
    notes: &EnhancedNotes,
    vault_root: &Path,
    transcript_path: &Path,
) -> Result<String, String> {
    let frontmatter = format!(
        "---\n\
opencassava_session_id: {}\n\
generated_at: {}\n\
started_at: {}\n\
template_id: \"{}\"\n\
template_name: \"{}\"\n\
source: OpenCassava\n\
tags: [opencassava, meeting]\n\
---\n\n",
        session_id,
        notes.generated_at.to_rfc3339(),
        started_at.to_rfc3339(),
        notes.template.id,
        escape_yaml_string(&notes.template.name),
    );
    let transcript_link = vault_wikilink(vault_root, transcript_path, "Transcript")?;
    let header = format!("Transcript: {transcript_link}\n\n");

    let body = notes.markdown.trim();
    if body.is_empty() {
        Ok(format!("{frontmatter}{header}"))
    } else {
        Ok(format!("{frontmatter}{header}{body}\n"))
    }
}

fn build_transcript_markdown(
    session_id: &str,
    started_at: DateTime<Utc>,
    vault_root: &Path,
    note_path: &Path,
    transcript: &[SessionRecord],
) -> Result<String, String> {
    let note_link = vault_wikilink(vault_root, note_path, "Session note")?;
    let transcript_body = transcript
        .iter()
        .map(|record| {
            format!(
                "[{}] {}: {}",
                record.timestamp.format("%H:%M:%S"),
                record.display_label(),
                record.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    Ok(format!(
        "---\n\
opencassava_session_id: {}\n\
started_at: {}\n\
source: OpenCassava\n\
tags: [opencassava, transcript]\n\
---\n\n\
# Transcript\n\n\
Session note: {}\n\n{}\n",
        session_id,
        started_at.to_rfc3339(),
        note_link,
        transcript_body,
    ))
}

fn write_text_file(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Create {}: {err}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|err| format!("Write {}: {err}", path.display()))
}

fn escape_yaml_string(input: &str) -> String {
    input.replace('"', "\\\"")
}

fn vault_wikilink(vault_root: &Path, target_path: &Path, label: &str) -> Result<String, String> {
    let relative = target_path.strip_prefix(vault_root).map_err(|_| {
        format!(
            "Path {} is not inside vault {}",
            target_path.display(),
            vault_root.display()
        )
    })?;
    let mut link_target = relative.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = link_target.strip_suffix(".md") {
        link_target = stripped.to_string();
    }
    Ok(format!("[[{link_target}|{label}]]"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{EnhancedNotes, SessionRecord, Speaker, TemplateSnapshot};
    use chrono::TimeZone;
    use tempfile::tempdir;
    use uuid::Uuid;

    fn sample_notes(markdown: &str) -> EnhancedNotes {
        EnhancedNotes {
            template: TemplateSnapshot {
                id: Uuid::parse_str("00000000-0000-0000-0000-000000000000").unwrap(),
                name: "Summary".into(),
                icon: "doc.text".into(),
                system_prompt: "prompt".into(),
            },
            generated_at: Utc.with_ymd_and_hms(2026, 4, 11, 12, 30, 0).unwrap(),
            markdown: markdown.into(),
        }
    }

    fn sample_transcript() -> Vec<SessionRecord> {
        vec![SessionRecord {
            speaker: Speaker::Them,
            participant_id: Some("speaker-a".into()),
            participant_label: Some("Client".into()),
            text: "We need a shared source of truth.".into(),
            timestamp: Utc.with_ymd_and_hms(2026, 4, 11, 9, 15, 0).unwrap(),
            suggestions: None,
            kb_hits: None,
            suggestion_decision: None,
            surfaced_suggestion_text: None,
            conversation_state_summary: None,
        }]
    }

    #[test]
    fn canonical_paths_are_deterministic() {
        let config = ObsidianVaultConfig::new(
            PathBuf::from("/vault"),
            "OpenCassava/Meetings",
            "OpenCassava/Transcripts",
        );
        let started_at = Utc.with_ymd_and_hms(2026, 4, 11, 9, 15, 0).unwrap();

        let first = config.canonical_paths("session_2026-04-11_09-15-00", started_at);
        let second = config.canonical_paths("session_2026-04-11_09-15-00", started_at);

        assert_eq!(first, second);
        assert!(first.note_path.ends_with(Path::new(
            "OpenCassava/Meetings/2026/04/session_2026-04-11_09-15-00.md"
        )));
        assert!(first.transcript_path.ends_with(Path::new(
            "OpenCassava/Transcripts/2026/04/transcript_2026-04-11_09-15-00.md"
        )));
    }

    #[test]
    fn transcript_file_stem_renames_session_prefix() {
        assert_eq!(
            super::transcript_file_stem("session_2026-04-11_09-15-00"),
            "transcript_2026-04-11_09-15-00"
        );
        assert_eq!(
            super::transcript_file_stem("transcript_2026-04-11_09-15-00"),
            "transcript_2026-04-11_09-15-00"
        );
        assert_eq!(
            super::transcript_file_stem("ad-hoc-import"),
            "transcript_ad-hoc-import"
        );
    }

    #[test]
    fn publish_session_creates_expected_files_and_frontmatter() {
        let dir = tempdir().unwrap();
        let config = ObsidianVaultConfig::new(
            dir.path().to_path_buf(),
            "OpenCassava/Meetings",
            "OpenCassava/Transcripts",
        );
        let started_at = Utc.with_ymd_and_hms(2026, 4, 11, 9, 15, 0).unwrap();

        let published = config
            .publish_session(
                "session_2026-04-11_09-15-00",
                started_at,
                &sample_notes("## Summary\nImportant meeting"),
                &sample_transcript(),
            )
            .unwrap();

        assert!(published.note_path.exists());
        assert!(published.transcript_path.exists());

        let note_text = fs::read_to_string(&published.note_path).unwrap();
        assert!(note_text.contains("opencassava_session_id: session_2026-04-11_09-15-00"));
        assert!(note_text.contains("template_name: \"Summary\""));
        assert!(note_text.contains("tags: [opencassava, meeting]"));
        assert!(note_text.contains(
            "Transcript: [[OpenCassava/Transcripts/2026/04/transcript_2026-04-11_09-15-00|Transcript]]"
        ));
        assert!(note_text.contains("## Summary"));

        let transcript_text = fs::read_to_string(&published.transcript_path).unwrap();
        assert!(transcript_text.contains("tags: [opencassava, transcript]"));
        assert!(transcript_text.contains(
            "Session note: [[OpenCassava/Meetings/2026/04/session_2026-04-11_09-15-00|Session note]]"
        ));
        assert!(transcript_text.contains("Client: We need a shared source of truth."));
    }

    #[test]
    fn publish_session_overwrites_existing_note() {
        let dir = tempdir().unwrap();
        let config = ObsidianVaultConfig::new(
            dir.path().to_path_buf(),
            "OpenCassava/Meetings",
            "OpenCassava/Transcripts",
        );
        let started_at = Utc.with_ymd_and_hms(2026, 4, 11, 9, 15, 0).unwrap();
        let session_id = "session_2026-04-11_09-15-00";

        config
            .publish_session(
                session_id,
                started_at,
                &sample_notes("first"),
                &sample_transcript(),
            )
            .unwrap();
        config
            .publish_session(
                session_id,
                started_at,
                &sample_notes("second"),
                &sample_transcript(),
            )
            .unwrap();

        let published = config.canonical_paths(session_id, started_at);
        let note_text = fs::read_to_string(&published.note_path).unwrap();
        assert!(note_text.contains("second"));
        assert!(!note_text.contains("first"));
    }
}
