import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { callLLM } from '@/lib/llm';

/**
 * A single field-level change between two catalog versions, as computed by the
 * client diff view.
 */
interface DiffChange {
  field: string;
  kind: 'added' | 'removed' | 'modified';
  before?: string;
  after?: string;
}

/**
 * Truncates a value for inclusion in the prompt so a single huge policy body
 * cannot blow the context budget.
 *
 * @param val - The raw text value.
 * @param max - Maximum characters to keep.
 * @returns The truncated value with an ellipsis marker if shortened.
 */
function clip(val: string | undefined, max = 4000): string {
  if (!val) return '(empty)';
  return val.length > max ? `${val.slice(0, max)}… [truncated]` : val;
}

/**
 * Builds the editorial prompt body describing the changes for the LLM.
 *
 * @param nodeType - Course | Program | Policy.
 * @param baseLabel - Human label for the base catalog version.
 * @param compareLabel - Human label for the comparison catalog version.
 * @param identity - The name/code of the item being compared.
 * @param changes - The list of field-level changes.
 * @returns The formatted prompt text.
 */
function buildPrompt(
  nodeType: string,
  baseLabel: string,
  compareLabel: string,
  identity: string,
  changes: DiffChange[]
): string {
  const lines = changes.map(c => {
    const fieldName = c.field.replace(/_/g, ' ');
    if (c.kind === 'added') return `- "${fieldName}" was ADDED. New value:\n  ${clip(c.after)}`;
    if (c.kind === 'removed') return `- "${fieldName}" was REMOVED. Previous value:\n  ${clip(c.before)}`;
    return `- "${fieldName}" was CHANGED.\n  Before: ${clip(c.before)}\n  After:  ${clip(c.after)}`;
  });

  return `Item type: ${nodeType}
Item: ${identity}
Base version: ${baseLabel}
Comparison version: ${compareLabel}

The following fields differ between the two catalog versions:

${lines.join('\n\n')}`;
}

const EDITORIAL_SYSTEM_PROMPT = `You are an editorial assistant helping a non-technical college catalog editor at Calumet College of St. Joseph review changes between two catalog versions.

You will be given the field-level differences for a single course, program, or policy. Write a short, plain-language editorial review aimed at a reader who is NOT technical. Structure your response in Markdown with exactly these sections:

## Summary
One short paragraph (2-4 sentences) describing, in plain English, what changed overall and whether it looks like a minor edit or a substantive change.

## What changed
A few concise bullet points covering the most meaningful changes. Translate jargon into plain language. Quote specific old → new values where it helps.

## Worth a closer look
Bullet points flagging anything that stands out and may need editorial attention: possible errors, inconsistencies, ambiguous wording, numbers that changed unexpectedly (e.g. credit hours), removed prerequisites, or content that seems incomplete or contradictory. If nothing stands out, say so honestly in one line.

Rules:
- Be specific and concrete; refer to the actual values.
- Be neutral and factual — you are flagging things for a human editor, not making final decisions.
- Do not invent changes that are not in the provided diff.
- Respond directly with the Markdown. Do not include any preamble, reasoning, or meta-commentary before the first heading.`;

/**
 * Calls the first available LLM provider to produce an editorial review.
 * Preference order: Anthropic (Claude) -> Vertex AI (Gemini) -> Gemini API key -> OpenAI.
 *
 * @param userPrompt - The change description prompt.
 * @param req - The incoming request (for Vertex credential resolution).
 * @returns The generated Markdown text and the model used, or null if no provider is configured.
 */
async function generateEditorial(
  userPrompt: string,
  req: Request
): Promise<{ text: string; model: string } | null> {
  return callLLM({ system: EDITORIAL_SYSTEM_PROMPT, user: userPrompt, req, maxTokens: 2000 });
}

/**
 * Handles requests to generate an AI editorial review of catalog diffs.
 *
 * @param req - The incoming POST request with diff context.
 * @returns A JSON response with the Markdown summary and the model used.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized access.' }, { status: 401 });
    }

    const body = await req.json();
    const {
      nodeType = 'item',
      baseLabel = 'Base catalog',
      compareLabel = 'Comparison catalog',
      identity = '',
      changes = [],
    }: {
      nodeType?: string;
      baseLabel?: string;
      compareLabel?: string;
      identity?: string;
      changes?: DiffChange[];
    } = body;

    if (!Array.isArray(changes) || changes.length === 0) {
      return NextResponse.json({ error: 'No changes provided to summarize.' }, { status: 400 });
    }

    const userPrompt = buildPrompt(nodeType, baseLabel, compareLabel, identity, changes);
    const result = await generateEditorial(userPrompt, req);

    if (!result) {
      return NextResponse.json({
        error: 'The editorial assistant is not configured — no AI provider key was found on the server. Configure an ANTHROPIC_API_KEY, GEMINI_API_KEY, or Vertex AI credentials to enable AI editorial review.',
      }, { status: 503 });
    }

    return NextResponse.json({ summary: result.text, model: result.model });
  } catch (e: any) {
    console.error('Diff Editorial Gateway Error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
