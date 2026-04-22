use crate::intelligence::llm_client::{strip_fences, Message};
use crate::intelligence::notes_engine::language_response_instruction;
use crate::models::{
    ConversationState, KBResult, Suggestion, SuggestionDecision, SuggestionKind, Utterance,
};
use std::collections::HashSet;
use std::time::{Duration, Instant};

const COOLDOWN_SECS: u64 = 90;
const MIN_WORDS: usize = 8;
const MIN_CHARS: usize = 30;
const MAX_RECENT_ANGLES: usize = 3;
const CONVERSATION_STATE_REFRESH_SECS: u64 = 20;
const CONVERSATION_STATE_REFRESH_UTTERANCE_DELTA: usize = 4;

pub struct SuggestionEngine {
    pub conversation_state: ConversationState,
    recent_suggestion_texts: Vec<String>,
    surfaced_smart_questions: HashSet<String>,
    last_suggestion_time: Option<Instant>,
    utterance_count: usize,
    last_conversation_state_refresh: Option<Instant>,
    last_conversation_state_utterance_count: usize,
    pub kb_surfacing_system_prompt: String,
    pub suggestion_synthesis_system_prompt: String,
    pub smart_question_system_prompt: String,
    /// BCP-47 locale (e.g. "es", "fr", "auto") from transcription settings.
    pub response_language: String,
}

impl SuggestionEngine {
    pub fn new() -> Self {
        Self {
            conversation_state: ConversationState::empty(),
            recent_suggestion_texts: Vec::new(),
            surfaced_smart_questions: HashSet::new(),
            last_suggestion_time: None,
            utterance_count: 0,
            last_conversation_state_refresh: None,
            last_conversation_state_utterance_count: 0,
            kb_surfacing_system_prompt: "You decide if an AI suggestion should be shown. Return only valid JSON.".into(),
            suggestion_synthesis_system_prompt: "You write brief, helpful suggestions for meeting participants.".into(),
            smart_question_system_prompt: "You decide when a smart clarifying question should be suggested. Return only valid JSON.".into(),
            response_language: String::new(),
        }
    }

    /// Process a recent transcript window through the suggestion pipeline.
    /// Returns a Suggestion if one should be surfaced, None otherwise.
    ///
    /// `embed_fn`: takes a batch of texts, returns embeddings
    /// `search_fn`: takes query embedding, returns KB results
    /// `complete_fn`: takes messages, returns LLM completion text
    pub async fn process_transcript_window<EmbedFn, EmbedFut, SearchFn, CompleteFn, CompleteFut>(
        &mut self,
        transcript_window: &str,
        recent_them_utterances: &[&Utterance],
        embed_fn: EmbedFn,
        search_fn: SearchFn,
        complete_fn: CompleteFn,
    ) -> Option<Suggestion>
    where
        EmbedFn: Fn(Vec<String>) -> EmbedFut,
        EmbedFut: std::future::Future<Output = Result<Vec<Vec<f32>>, String>>,
        SearchFn: Fn(&[f32]) -> Vec<KBResult>,
        CompleteFn: Fn(Vec<Message>) -> CompleteFut,
        CompleteFut: std::future::Future<Output = Result<String, String>>,
    {
        self.utterance_count += 1;

        // Stage 1: Heuristic pre-filter
        if !self.passes_prefilter(transcript_window) {
            return None;
        }

        // Stage 2: Refresh conversation state from the current rolling window.
        self.maybe_refresh_conversation_state(recent_them_utterances, &complete_fn)
            .await;

        // Stage 3: KB retrieval
        let queries = self.build_search_queries(transcript_window);
        let mut kb_hits: Vec<KBResult> = Vec::new();
        if let Ok(embeddings) = embed_fn(queries).await {
            for emb in embeddings {
                let results = search_fn(&emb);
                for r in results {
                    if !kb_hits.iter().any(|h: &KBResult| h.text == r.text) {
                        kb_hits.push(r);
                    }
                }
            }
        }

        if kb_hits.is_empty() {
            return self
                .maybe_surface_smart_question(
                    transcript_window,
                    recent_them_utterances,
                    &complete_fn,
                )
                .await;
        }

        // Stage 4: LLM surfacing gate
        let decision = self
            .run_surfacing_gate(transcript_window, &kb_hits, &complete_fn)
            .await?;

        if !decision.should_surface {
            return None;
        }

        let suggestion_text = self
            .synthesize_suggestion(transcript_window, &kb_hits, &complete_fn)
            .await?;

        // Track recent suggestions to avoid duplicates
        self.register_recent_suggestion(suggestion_text.clone());

        Some(Suggestion::new(
            SuggestionKind::KnowledgeBase,
            suggestion_text,
            kb_hits,
            Some(decision),
        ))
    }

    pub fn clear(&mut self) {
        self.conversation_state = ConversationState::empty();
        self.recent_suggestion_texts.clear();
        self.surfaced_smart_questions.clear();
        self.last_suggestion_time = None;
        self.utterance_count = 0;
        self.last_conversation_state_refresh = None;
        self.last_conversation_state_utterance_count = 0;
    }

    // -- Private helpers -------------------------------------------------------

    fn passes_prefilter(&self, text: &str) -> bool {
        let words: Vec<&str> = text.split_whitespace().collect();
        if words.len() < MIN_WORDS || text.len() < MIN_CHARS {
            return false;
        }
        if let Some(t) = self.last_suggestion_time {
            if t.elapsed() < Duration::from_secs(COOLDOWN_SECS) {
                return false;
            }
        }
        true
    }

    fn build_search_queries(&self, transcript_window: &str) -> Vec<String> {
        let mut queries = vec![transcript_window.to_string()];
        if !self.conversation_state.current_topic.is_empty() {
            queries.push(format!(
                "{} {}",
                self.conversation_state.current_topic, transcript_window
            ));
        }
        if !self.conversation_state.short_summary.is_empty() {
            queries.push(self.conversation_state.short_summary.clone());
        }
        queries
    }

    fn register_recent_suggestion(&mut self, text: String) {
        self.recent_suggestion_texts.push(text);
        if self.recent_suggestion_texts.len() > MAX_RECENT_ANGLES {
            self.recent_suggestion_texts.remove(0);
        }
        self.last_suggestion_time = Some(Instant::now());
    }

    fn normalize_suggestion_text(raw: &str) -> Option<String> {
        let trimmed = strip_fences(raw).trim();
        if trimmed.is_empty() || Self::looks_like_source_reference_list(trimmed) {
            return None;
        }
        Some(trimmed.to_string())
    }

    fn looks_like_source_reference_list(text: &str) -> bool {
        let parts = text
            .split(" . ")
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            return false;
        }

        parts.iter().all(|part| {
            let normalized = part.replace('\\', "/");
            let has_markdown_target = normalized.contains(".md");
            let has_heading_anchor = normalized.contains('#');
            let path_like = normalized.starts_with("OpenCassava/")
                || normalized.contains('/')
                || normalized.contains('\\');
            has_markdown_target && has_heading_anchor && path_like
        })
    }

    fn normalize_question(text: &str) -> String {
        text.split_whitespace()
            .map(|part| part.trim_matches(|c: char| c.is_ascii_punctuation()))
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    }

    fn has_already_surfaced_question(&self, question: &str) -> bool {
        let normalized = Self::normalize_question(question);
        !normalized.is_empty() && self.surfaced_smart_questions.contains(&normalized)
    }

    fn should_refresh_conversation_state(&self) -> bool {
        let enough_new_utterances = self
            .utterance_count
            .saturating_sub(self.last_conversation_state_utterance_count)
            >= CONVERSATION_STATE_REFRESH_UTTERANCE_DELTA;

        match self.last_conversation_state_refresh {
            None => true,
            Some(last_refresh) => {
                enough_new_utterances
                    || last_refresh.elapsed()
                        >= Duration::from_secs(CONVERSATION_STATE_REFRESH_SECS)
            }
        }
    }

    async fn maybe_refresh_conversation_state<F, Fut>(
        &mut self,
        recent_them: &[&Utterance],
        complete_fn: &F,
    ) where
        F: Fn(Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        if !self.should_refresh_conversation_state() {
            return;
        }

        self.last_conversation_state_refresh = Some(Instant::now());
        self.last_conversation_state_utterance_count = self.utterance_count;
        self.update_conversation_state(recent_them, complete_fn)
            .await;
    }

    async fn update_conversation_state<F, Fut>(
        &mut self,
        recent_them: &[&Utterance],
        complete_fn: &F,
    ) where
        F: Fn(Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        let transcript = recent_them
            .iter()
            .map(|u| format!("Them: {}", u.text))
            .collect::<Vec<_>>()
            .join("\n");

        let prompt = format!(
            "Analyze this conversation excerpt and return JSON with fields: \
            currentTopic, shortSummary, openQuestions (array), activeTensions (array), \
            recentDecisions (array), themGoals (array).\n\nTranscript:\n{}",
            transcript
        );

        let messages = vec![
            Message::system("You are a conversation analyst. Return only valid JSON."),
            Message::user(prompt),
        ];

        if let Ok(raw) = complete_fn(messages).await {
            let clean = strip_fences(&raw);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(clean) {
                if let Some(t) = v["currentTopic"].as_str() {
                    self.conversation_state.current_topic = t.to_string();
                }
                if let Some(s) = v["shortSummary"].as_str() {
                    self.conversation_state.short_summary = s.to_string();
                }
                self.conversation_state.last_updated_at = chrono::Utc::now();
            }
        }
    }

    async fn run_surfacing_gate<F, Fut>(
        &self,
        transcript_window: &str,
        kb_hits: &[KBResult],
        complete_fn: &F,
    ) -> Option<SuggestionDecision>
    where
        F: Fn(Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        let context = kb_hits
            .iter()
            .map(|h| {
                format!(
                    "- {} (score: {:.2})",
                    &h.text[..h.text.len().min(100)],
                    h.score
                )
            })
            .collect::<Vec<_>>()
            .join("\n");

        let recent = self.recent_suggestion_texts.join(", ");

        let prompt = format!(
            "Should we surface a suggestion based on this?\n\
            Recent conversation:\n{transcript_window}\n\
            KB Context:\n{context}\n\
            Recent suggestions: {recent}\n\n\
            Return JSON: {{\"shouldSurface\": bool, \"confidence\": 0-1, \
            \"relevanceScore\": 0-1, \"helpfulnessScore\": 0-1, \
            \"timingScore\": 0-1, \"noveltyScore\": 0-1, \"reason\": \"...\"}}"
        );

        let messages = vec![
            Message::system(&self.kb_surfacing_system_prompt),
            Message::user(prompt),
        ];

        let raw = complete_fn(messages).await.ok()?;
        let clean = strip_fences(&raw);
        let v: serde_json::Value = serde_json::from_str(clean).ok()?;

        let should_surface = v["shouldSurface"].as_bool().unwrap_or(false);
        let confidence = v["confidence"].as_f64().unwrap_or(0.0);

        Some(SuggestionDecision {
            should_surface,
            confidence,
            relevance_score: v["relevanceScore"].as_f64().unwrap_or(0.0),
            helpfulness_score: v["helpfulnessScore"].as_f64().unwrap_or(0.0),
            timing_score: v["timingScore"].as_f64().unwrap_or(0.0),
            novelty_score: v["noveltyScore"].as_f64().unwrap_or(0.0),
            reason: v["reason"].as_str().unwrap_or("").to_string(),
        })
    }

    async fn synthesize_suggestion<F, Fut>(
        &self,
        transcript_window: &str,
        kb_hits: &[KBResult],
        complete_fn: &F,
    ) -> Option<String>
    where
        F: Fn(Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        let context = kb_hits
            .iter()
            .take(3)
            .map(|h| h.text.clone())
            .collect::<Vec<_>>()
            .join("\n\n");

        let language_instruction = language_response_instruction(&self.response_language);
        let prompt = format!(
            "Given this conversation moment and relevant knowledge, write a concise, \
            actionable suggestion (1-2 sentences) that would help the speaker respond effectively.\n\n\
            Recent conversation:\n{transcript_window}\n\nRelevant knowledge:\n{context}{}",
            if language_instruction.is_empty() {
                String::new()
            } else {
                format!("\n\n{language_instruction}")
            }
        );

        let messages = vec![
            Message::system(&self.suggestion_synthesis_system_prompt),
            Message::user(prompt),
        ];

        let raw = complete_fn(messages).await.ok()?;
        Self::normalize_suggestion_text(&raw)
    }

    async fn maybe_surface_smart_question<F, Fut>(
        &mut self,
        utterance: &str,
        recent_them_utterances: &[&Utterance],
        complete_fn: &F,
    ) -> Option<Suggestion>
    where
        F: Fn(Vec<Message>) -> Fut,
        Fut: std::future::Future<Output = Result<String, String>>,
    {
        let recent_context = recent_them_utterances
            .iter()
            .rev()
            .take(3)
            .rev()
            .map(|u| format!("Them: {}", u.text))
            .collect::<Vec<_>>()
            .join("\n");

        let recent = self.recent_suggestion_texts.join(", ");
        let previously_surfaced_questions = self
            .surfaced_smart_questions
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let language_instruction = language_response_instruction(&self.response_language);
        let question_language_note = if language_instruction.is_empty() {
            String::new()
        } else {
            format!(" {language_instruction} The \"question\" field must be in the same language as the conversation.")
        };
        let prompt = format!(
            "A meeting participant may need a clarifying or probing question when there is a knowledge gap, ambiguity, \
            missing constraint, or unstated assumption.\n\
            Current topic: {}\n\
            Short summary: {}\n\
            Recent conversation:\n{}\n\n\
            Most recent utterance: {}\n\
            Recent suggestions: {}\n\
            Previously surfaced smart questions: {}\n\n\
            Return JSON: {{\"shouldSurface\": bool, \"question\": string, \"confidence\": 0-1, \
            \"relevanceScore\": 0-1, \"helpfulnessScore\": 0-1, \"timingScore\": 0-1, \
            \"noveltyScore\": 0-1, \"reason\": string}}.\n\
            The question must be concise, natural, and directly ask for the missing information. \
            Do not repeat a smart question that was already surfaced earlier in the session.{}",
            self.conversation_state.current_topic,
            self.conversation_state.short_summary,
            recent_context,
            utterance,
            recent,
            previously_surfaced_questions,
            question_language_note,
        );

        let messages = vec![
            Message::system(&self.smart_question_system_prompt),
            Message::user(prompt),
        ];

        let raw = complete_fn(messages).await.ok()?;
        let clean = strip_fences(&raw);
        let v: serde_json::Value = serde_json::from_str(clean).ok()?;

        let should_surface = v["shouldSurface"].as_bool().unwrap_or(false);
        let question = v["question"].as_str().unwrap_or("").trim().to_string();

        if !should_surface || question.is_empty() || self.has_already_surfaced_question(&question) {
            return None;
        }

        let decision = SuggestionDecision {
            should_surface,
            confidence: v["confidence"].as_f64().unwrap_or(0.0),
            relevance_score: v["relevanceScore"].as_f64().unwrap_or(0.0),
            helpfulness_score: v["helpfulnessScore"].as_f64().unwrap_or(0.0),
            timing_score: v["timingScore"].as_f64().unwrap_or(0.0),
            novelty_score: v["noveltyScore"].as_f64().unwrap_or(0.0),
            reason: v["reason"].as_str().unwrap_or("").to_string(),
        };

        self.surfaced_smart_questions
            .insert(Self::normalize_question(&question));
        self.register_recent_suggestion(question.clone());

        Some(Suggestion::new(
            SuggestionKind::SmartQuestion,
            question,
            Vec::new(),
            Some(decision),
        ))
    }
}

impl Default for SuggestionEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Speaker;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn prefilter_rejects_short_text() {
        let engine = SuggestionEngine::new();
        assert!(!engine.passes_prefilter("hi"));
    }

    #[test]
    fn prefilter_accepts_substantive_text() {
        let engine = SuggestionEngine::new();
        let text =
            "What is the best approach to solving this customer problem we keep running into?";
        assert!(engine.passes_prefilter(text));
    }

    #[test]
    fn prefilter_accepts_plain_substantive_statement() {
        let engine = SuggestionEngine::new();
        let text = "Estamos revisando el alcance del proyecto y necesitamos ordenar las prioridades del cliente.";
        assert!(engine.passes_prefilter(text));
    }

    #[test]
    fn normalize_question_ignores_case_whitespace_and_punctuation() {
        let normalized = SuggestionEngine::normalize_question("  What is the budget timeline?  ");
        assert_eq!(normalized, "what is the budget timeline");
    }

    #[test]
    fn surfaced_question_match_uses_normalized_text() {
        let mut engine = SuggestionEngine::new();
        engine
            .surfaced_smart_questions
            .insert(SuggestionEngine::normalize_question(
                "What is the budget timeline?",
            ));

        assert!(engine.has_already_surfaced_question("what is the budget timeline"));
        assert!(engine.has_already_surfaced_question("What is the budget timeline?!"));
        assert!(!engine.has_already_surfaced_question("Who owns the budget timeline?"));
    }

    #[tokio::test]
    async fn process_transcript_window_batches_query_embeddings() {
        let mut engine = SuggestionEngine::new();
        engine.conversation_state.current_topic = "timeline".into();
        engine.conversation_state.short_summary = "Budget review".into();
        engine.last_conversation_state_refresh = Some(Instant::now());
        engine.last_conversation_state_utterance_count = usize::MAX;

        let embed_call_count = Arc::new(AtomicUsize::new(0));
        let embed_batch_size = Arc::new(AtomicUsize::new(0));
        let search_call_count = Arc::new(AtomicUsize::new(0));

        let transcript_window =
            "We need to lock the customer timeline and confirm budget owners before Friday.";
        let them = vec![Utterance::new(transcript_window.to_string(), Speaker::Them)];
        let recent_them = them.iter().collect::<Vec<_>>();

        let suggestion = engine
            .process_transcript_window(
                transcript_window,
                &recent_them,
                {
                    let embed_call_count = Arc::clone(&embed_call_count);
                    let embed_batch_size = Arc::clone(&embed_batch_size);
                    move |texts: Vec<String>| {
                        let embed_call_count = Arc::clone(&embed_call_count);
                        let embed_batch_size = Arc::clone(&embed_batch_size);
                        async move {
                            embed_call_count.fetch_add(1, Ordering::Relaxed);
                            embed_batch_size.store(texts.len(), Ordering::Relaxed);
                            Ok(texts.iter().map(|_| vec![1.0, 0.0, 0.0]).collect())
                        }
                    }
                },
                {
                    let search_call_count = Arc::clone(&search_call_count);
                    move |_embedding: &[f32]| {
                        search_call_count.fetch_add(1, Ordering::Relaxed);
                        vec![KBResult::new(
                            "Use the pricing playbook".into(),
                            "playbook.md".into(),
                            String::new(),
                            0.95,
                        )]
                    }
                },
                |_messages| async {
                    Ok(
                        "{\"shouldSurface\":true,\"confidence\":0.9,\"relevanceScore\":0.9,\"helpfulnessScore\":0.9,\"timingScore\":0.9,\"noveltyScore\":0.9,\"reason\":\"helpful\"}"
                            .to_string(),
                    )
                },
            )
            .await;

        assert!(suggestion.is_some());
        assert_eq!(embed_call_count.load(Ordering::Relaxed), 1);
        assert_eq!(embed_batch_size.load(Ordering::Relaxed), 3);
        assert_eq!(search_call_count.load(Ordering::Relaxed), 3);
    }

    #[test]
    fn conversation_state_refresh_is_gated_by_utterance_delta() {
        let mut engine = SuggestionEngine::new();
        engine.last_conversation_state_refresh = Some(Instant::now());
        engine.last_conversation_state_utterance_count = 5;
        engine.utterance_count = 7;
        assert!(!engine.should_refresh_conversation_state());

        engine.utterance_count = 9;
        assert!(engine.should_refresh_conversation_state());
    }

    #[test]
    fn normalize_suggestion_text_rejects_blank_output() {
        assert_eq!(SuggestionEngine::normalize_suggestion_text("   \n\t"), None);
    }

    #[test]
    fn normalize_suggestion_text_rejects_source_reference_lists() {
        let source_list = "OpenCassava/Meetings/2026/04/session_2026-04-22_09-29-15.md#Summary . OpenCassava/Meetings/2026/04/session_2026-04-22_09-29-15.md#Key Points . OpenCassava/Meetings/2026/04/session_2026-04-22_09-29-15.md#Decisions Made";
        assert_eq!(SuggestionEngine::normalize_suggestion_text(source_list), None);
    }

    #[test]
    fn normalize_suggestion_text_keeps_real_suggestions() {
        let suggestion =
            "Ask whether procurement needs to be involved before they commit to the revised timeline.";
        assert_eq!(
            SuggestionEngine::normalize_suggestion_text(suggestion),
            Some(suggestion.to_string())
        );
    }
}
