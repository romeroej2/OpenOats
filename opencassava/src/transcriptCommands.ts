export const TRANSCRIPT_FOCUS_SEARCH_EVENT = "transcript-focus-search";
export const TRANSCRIPT_OPEN_EXPORT_EVENT = "transcript-open-export";

export function dispatchTranscriptFocusSearch() {
  window.dispatchEvent(new Event(TRANSCRIPT_FOCUS_SEARCH_EVENT));
}

export function dispatchTranscriptOpenExport() {
  window.dispatchEvent(new Event(TRANSCRIPT_OPEN_EXPORT_EVENT));
}
