const WRAPPER_RE = [
  /<tdai_memory_tools>[\s\S]*?<\/tdai_memory_tools>/gi,
  /<relevant-memories>[\s\S]*?<\/relevant-memories>/gi,
  /<user-persona>[\s\S]*?<\/user-persona>/gi,
  /<session_context>[\s\S]*?<\/session_context>/gi,
  /<cloud_skills>[\s\S]*?<\/cloud_skills>/gi,
  /<l2_scene_index>[\s\S]*?<\/l2_scene_index>/gi,
];

/** Strip known TDAI recall wrappers so they are not written back as L0. */
export function stripTdaiWrappers(text: string): string {
  let out = text;
  for (const re of WRAPPER_RE) out = out.replace(re, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function validateConversationRef(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("conversation_ref is required (opaque host conversation id)");
  }
  const ref = raw.trim();
  if (ref.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(ref)) {
    throw new Error("conversation_ref must be 1–128 chars of [A-Za-z0-9._:-]");
  }
  return ref;
}

export function validateCaptureId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("capture_id is required");
  }
  const id = raw.trim();
  if (id.length > 128) throw new Error("capture_id exceeds 128 characters");
  return id;
}
