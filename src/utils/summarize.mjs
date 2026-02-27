/**
 * Conversation Summarization Utilities
 */

import { runQuery } from '../api/streaming.mjs';
import { createMessage } from './messages.mjs';

/**
 * Resolve the model to use for summarization.
 * Uses OPENCLAUDE_COMPACT_MODEL env var if set, otherwise falls back to
 * claude-haiku-4-5 or the current session model — whichever is cheaper.
 * Avoids hardcoding a specific dated model string.
 */
function getSummarizationModel() {
  if (process.env.OPENCLAUDE_COMPACT_MODEL) {
    return process.env.OPENCLAUDE_COMPACT_MODEL;
  }
  // Prefer a fast/cheap model; fall back gracefully if config unavailable
  try {
    // Dynamic import avoids circular deps at module level
    const { getConfig } = require('../config/index.mjs');
    const cfg = getConfig();
    if (cfg?.compactModel) return cfg.compactModel;
  } catch {}
  // Default: latest haiku (no dated suffix — Anthropic aliases the latest)
  return 'claude-haiku-4-5-20251001';
}

const SUMMARIZATION_PROMPT = `
You are a conversation summarizer. Your task is to read the provided conversation history and create a concise summary. The summary should be written from the perspective of an omniscient narrator, explaining what was discussed and what actions were taken.

Focus on key decisions, important facts, code snippets, tool outputs, and unresolved questions. Preserve the essential context needed for an AI assistant to pick up the conversation where it left off.

The conversation history is provided below. Generate a summary.
`;

/**
 * Summarize a chunk of conversation messages.
 * @param {Array} messages - The array of messages to summarize.
 * @returns {Promise<string>} - The generated summary text.
 */
async function summarize(messages) {
  const content = messages.map(msg => {
    const role = msg.message?.role || msg.role;
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return `${role}: ${text}`;
  }).join('\n\n');

  try {
    const summaryResult = await runQuery(
      `${SUMMARIZATION_PROMPT}\n\n---\n\n${content}`,
      [], // No tools needed for summarization
      { model: getSummarizationModel() }
    );

    const summaryText = summaryResult[0]?.message?.content?.[0]?.text || '[Could not generate summary]';
    return summaryText;
  } catch (error) {
    console.error('Summarization failed:', error);
    return '[Summarization failed]';
  }
}

/**
 * Compact messages by summarizing older turns to free context space.
 * Keeps the first system-relevant message and last N messages intact.
 * @param {Array} messages - The full message history.
 * @param {number} keepLastN - The number of recent messages to keep untouched.
 * @returns {Promise<Array>} - The compacted message history.
 */
export async function compactMessagesWithAi(messages, keepLastN = 8) {
  if (messages.length <= keepLastN + 2) {
    return messages;
  }

  const toSummarize = messages.slice(0, -keepLastN);
  const toKeep = messages.slice(-keepLastN);

  const summaryText = await summarize(toSummarize);

  const summaryMessage = createMessage(
    'user',
    `[Context compacted: ${toSummarize.length} older messages were summarized to free up space.]

**Summary of earlier conversation:**
${summaryText}`
  );

  return [summaryMessage, ...toKeep];
}

/**
 * Compact from a specific message index onwards.
 * Summarizes messages[fromIndex ... -keepLastN], keeping newer messages intact.
 * (CC 2.1.32 "summarize from here" parity)
 *
 * @param {Array} messages - The full message history.
 * @param {number} fromIndex - Index to start summarizing from (0-based).
 * @param {number} keepLastN - Number of recent messages to keep verbatim.
 * @returns {Promise<Array>} - New message array with summary inserted at fromIndex.
 */
export async function compactFromMessage(messages, fromIndex, keepLastN = 4) {
  if (!messages || messages.length === 0) return messages;

  const safeFrom = Math.max(0, Math.min(fromIndex, messages.length - 1));
  const sliceEnd = messages.length - keepLastN;

  // Nothing to summarize if the range is empty
  if (safeFrom >= sliceEnd) {
    return messages;
  }

  // Keep messages before fromIndex intact (they form the "before" anchor)
  const before = messages.slice(0, safeFrom);
  const toSummarize = messages.slice(safeFrom, sliceEnd);
  const toKeep = messages.slice(sliceEnd);

  if (toSummarize.length === 0) return messages;

  const summaryText = await summarize(toSummarize);

  const summaryMessage = createMessage(
    'user',
    `[Context summarized from message ${safeFrom + 1}: ${toSummarize.length} messages condensed.]

**Summary:**
${summaryText}`
  );

  return [...before, summaryMessage, ...toKeep];
}
