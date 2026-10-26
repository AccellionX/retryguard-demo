/**
 * Step: validate create_offer_draft payload before any side effects.
 */
import type { EnsureEnvelopeJob } from "./ensureEnvelope.js";

export function validateCreateOfferDraft(
  job: { id: string; payload: unknown }
): asserts job is EnsureEnvelopeJob {
  const payload = job.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  if (typeof p.templateId !== "string" || !p.templateId.trim()) {
    throw new Error("payload.templateId is required");
  }
  if (typeof p.subject !== "string" || !p.subject.trim()) {
    throw new Error("payload.subject is required");
  }
}
