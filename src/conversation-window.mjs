import {
  CHECKPOINT_WARNING,
  LEGACY_V1_SUMMARY_PREFIX,
  LEGACY_WARNING,
} from "./compaction-checkpoint.mjs";

// A routed or native turn leaves this router as a stateless full conversation:
// neither Codex nor a routed provider keeps server-side turn state, because
// `previous_response_id` is stripped before the turn leaves. The client
// therefore replays every previous item on every turn, so a thread whose own
// text is a few kilobytes still bills hundreds of thousands of input tokens.
//
// This pass keeps the newest slice of the conversation byte-for-byte and drops
// what came before, rather than summarizing it. Nothing the model reads was
// rewritten behind the operator's back, and the client's own compaction
// threshold is left alone. Instruction messages and the carriers of
// already-compacted history are pinned regardless of age: dropping the former
// would lose the operator's rules, and dropping the latter would silently
// discard everything the client already compacted.
//
// The budget is measured over the whole conversation, and the frontier is
// pulled back onto safe boundaries, so a follow-up keeps the turn it depends on
// and a call is never separated from its result. The current turn is never
// truncated: the frontier stops at the newest user message even when that
// turn's own tool output exhausts the budget. The cut is deterministic, so an
// unchanged prefix still matches the provider's prompt cache.
export const CONVERSATION_WINDOW_TAIL_BYTES = 64 * 1024;
export const CONVERSATION_WINDOW_MIN_TOTAL_BYTES = 0;
export const CONVERSATION_WINDOW_BOUNDARY_SLACK_ITEMS = 4;

const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
]);
const REASONING_TYPES = new Set(["reasoning"]);
const INSTRUCTION_ROLES = new Set(["system", "developer"]);
const COMPACTION_TYPES = new Set(["compaction", "compaction_trigger"]);
// `renderCompactionValue` emits this when a compaction payload cannot be
// decoded. The text carries no history, but it must still survive: it is the
// client's only record that the earlier turns existed.
const UNREADABLE_COMPACTION_PREFIX =
  "[Earlier conversation history was compacted in an unreadable format.]";

// `CODEX_ROUTER_CONVERSATION_WINDOW=0` is the operator kill switch. Everything
// else, including an unset variable, leaves the pass enabled.
export function conversationWindowEnabled() {
  return process.env.CODEX_ROUTER_CONVERSATION_WINDOW !== "0";
}

// `CODEX_ROUTER_CONVERSATION_WINDOW_KB=<n>` tunes how much of the newest
// conversation survives. Unset, blank, or unparsable falls back to the default,
// and `0` keeps only the pinned items plus the current turn. The value is read
// per turn, so it can be changed without restarting the router.
export function conversationWindowTailBytes() {
  const raw = process.env.CODEX_ROUTER_CONVERSATION_WINDOW_KB;
  if (raw === undefined || raw.trim() === "") return CONVERSATION_WINDOW_TAIL_BYTES;
  const kilobytes = Number(raw);
  if (!Number.isFinite(kilobytes) || kilobytes < 0) {
    return CONVERSATION_WINDOW_TAIL_BYTES;
  }
  return Math.floor(kilobytes * 1024);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function isInstruction(item) {
  return item?.type === "message" && INSTRUCTION_ROLES.has(item.role);
}

function isUserMessage(item) {
  return item?.type === "message" && item.role === "user";
}

function messageText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return undefined;
  const text = [];
  for (const part of item.content) {
    if (typeof part?.text !== "string") return undefined;
    text.push(part.text);
  }
  return text.join("");
}

// Compaction survives as a rewritten user message, not as ordinary history:
// `normalizeRoutedInput` and the native pass both turn a `compaction` item into
// a user message rendered by `renderCompactionValue`. Dropping it because it is
// an old user turn would silently throw away everything the client compacted,
// so carriers of compacted history are pivots exactly like instructions are.
function carriesCompactedHistory(item) {
  if (COMPACTION_TYPES.has(item?.type)) return true;
  if (!isUserMessage(item)) return false;
  const text = messageText(item);
  if (typeof text !== "string") return false;
  return (
    text.startsWith(CHECKPOINT_WARNING) ||
    text.startsWith(LEGACY_WARNING) ||
    text.startsWith(LEGACY_V1_SUMMARY_PREFIX) ||
    text.startsWith(UNREADABLE_COMPACTION_PREFIX)
  );
}

function lastUserIndex(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isUserMessage(input[index])) return index;
  }
  return -1;
}

function emptyStats() {
  return {
    // False until the pass actually runs. A disabled pass keeps the zeroed
    // counters below but leaves this false, so "off" stays distinguishable
    // from "on and the conversation already fit" on the usage ledger.
    conversationWindowRan: false,
    conversationWindowBytesBefore: 0,
    conversationWindowBytesAfter: 0,
    conversationWindowBytesSaved: 0,
    conversationWindowItemsDropped: 0,
    conversationWindowTailItems: 0,
    conversationWindowFrontierIndex: 0,
    conversationWindowLatestUserIndex: -1,
    conversationWindowTailBytes: 0,
  };
}

// Walks back from the end of the conversation until the newest `tailBytes`
// worth of items are covered, then widens the frontier until it sits on a
// boundary a provider will accept. Returns 0 when the whole conversation
// already fits, which is the caller's signal to return the input untouched.
function findFrontier(input, sizes, tailBytes, boundarySlackItems, latestUser) {
  let frontier = input.length;
  let tail = 0;
  while (frontier > 0 && tail < tailBytes) {
    frontier -= 1;
    tail += sizes[frontier];
  }
  // The slack only widens a cut the budget already made. With a zero budget
  // the frontier stays on the newest user message, so an operator who asks for
  // "the current turn only" gets exactly that instead of a few extra items.
  if (tail > 0) frontier = Math.max(0, frontier - boundarySlackItems);
  // Never begin the kept region in the middle of a call/result pair.
  if (frontier > 0 && OUTPUT_TYPES.has(input[frontier]?.type)) {
    const callId = input[frontier].call_id;
    for (let index = frontier - 1; index >= 0; index -= 1) {
      if (CALL_TYPES.has(input[index]?.type) && input[index].call_id === callId) {
        frontier = index;
        break;
      }
    }
  }
  while (frontier > 0 && CALL_TYPES.has(input[frontier - 1]?.type)) {
    frontier -= 1;
  }
  // Nor split reasoning from the assistant turn it was produced for.
  while (frontier > 0 && REASONING_TYPES.has(input[frontier - 1]?.type)) {
    frontier -= 1;
  }
  // The request being answered is never truncated, even when its own tool
  // output is what exhausted the budget.
  if (latestUser >= 0) frontier = Math.min(frontier, latestUser);
  return frontier;
}

export function windowConversation(
  input,
  {
    enabled = true,
    tailBytes = CONVERSATION_WINDOW_TAIL_BYTES,
    minTotalBytes = CONVERSATION_WINDOW_MIN_TOTAL_BYTES,
    boundarySlackItems = CONVERSATION_WINDOW_BOUNDARY_SLACK_ITEMS,
  } = {},
) {
  const stats = emptyStats();
  if (!enabled || !Array.isArray(input) || input.length === 0) {
    return { input, stats };
  }
  stats.conversationWindowRan = true;
  stats.conversationWindowTailBytes = tailBytes;
  stats.conversationWindowLatestUserIndex = lastUserIndex(input);

  const sizes = input.map(jsonBytes);
  const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
  if (totalBytes <= minTotalBytes) return { input, stats };

  const frontier = findFrontier(
    input,
    sizes,
    tailBytes,
    boundarySlackItems,
    stats.conversationWindowLatestUserIndex,
  );
  if (frontier === 0) {
    stats.conversationWindowBytesBefore = totalBytes;
    stats.conversationWindowBytesAfter = totalBytes;
    stats.conversationWindowTailItems = input.length;
    return { input, stats };
  }

  const next = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (isInstruction(item) || carriesCompactedHistory(item)) {
      next.push(item);
      continue;
    }
    if (index < frontier) {
      stats.conversationWindowItemsDropped += 1;
      continue;
    }
    next.push(item);
  }

  const afterBytes = next.reduce((sum, item) => sum + jsonBytes(item), 0);
  stats.conversationWindowBytesBefore = totalBytes;
  stats.conversationWindowBytesAfter = afterBytes;
  stats.conversationWindowBytesSaved = totalBytes - afterBytes;
  stats.conversationWindowTailItems = input.length - frontier;
  stats.conversationWindowFrontierIndex = frontier;
  return { input: next, stats };
}
