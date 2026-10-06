/**
 * POST /v1/responses - OpenAI Responses API compatibility layer.
 *
 * Translates Responses requests to the internal Chat Completions handler and
 * adapts Chat SSE chunks back into Responses SSE events.
 */

import { randomUUID } from 'crypto';
import { handleChatCompletions, normalizeOpenAIErrorType, connectErrorToHttp, hasPerUserScope } from './chat.js';
import { getResponse, putResponse, deleteResponse, isResponseStoreEnabled, wantsPersistence } from '../response-store.js';
import { safeLogValue } from '../log-safety.js';
import { log } from '../config.js';

function genResponseId() {
  return 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genMessageId() {
  return 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function genFunctionCallId() {
  return 'fc_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

function stringifyMaybe(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function safeJsonParse(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyMaybe(content);

  // A zero-length content array means "no content", not the two-character
  // string "[]". JSON.stringify([]) used to send that literal junk upstream
  // and slip past the shared empty-user 400 (predicate B); the Responses
  // surface must reach the same guard as the chat surface.
  // See docs/REQUEST-TAIL-CONTRACT.md.
  if (content.length === 0) return '';

  const hasContentBlock = content.some(part => part && typeof part === 'object' && typeof part.type === 'string');
  if (!hasContentBlock) {
    return stringifyMaybe(content);
  }

  const out = [];
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') {
      out.push({ type: 'text', text: part });
      continue;
    }
    if (typeof part !== 'object') continue;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      out.push({ type: 'text', text: part.text || '' });
    } else if (part.type === 'input_image') {
      // H-1 (ultracode audit 2026-07-13): Responses API `input_image.image_url`
      // is a STRING (a URL or a `data:` base64 URI). Downstream image extractors
      // (image.js:568, devin-connect.js:210) read `block.image_url?.url`, so a
      // bare string yields `.url === undefined` → 0 images extracted → the model
      // is told "there's an image" (hasMultimodalContent is truthy on the
      // non-empty string) but silently answers blind. Normalize to the standard
      // Chat-Completions object shape `{ image_url: { url, detail? } }` so the
      // whole vision chain works for both string and (defensively) object forms.
      const raw = part.image_url;
      const url = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw.url || '') : '');
      if (url) {
        const img = { url };
        if (part.detail) img.detail = part.detail;
        else if (raw && typeof raw === 'object' && raw.detail) img.detail = raw.detail;
        out.push({ type: 'image_url', image_url: img });
      } else {
        out.push(part);
      }
    } else {
      out.push(part);
    }
  }
  return out.length ? out : '';
}

// Codex SDK exposes server-side tools (file_search, computer_use_preview,
// mcp) where execution lives on OpenAI's side, not the model's. The proxy
// can't bridge these — each needs its own service implementation — so
// drop them silently rather than 500-ing the whole request.
//
// `web_search` / `web_search_preview` are NOT in this set: they get
// translated by flattenResponseTool below into a regular function tool
// with a `query` param so the model can still drive the search loop
// through normal function calls.
const UNBRIDGED_SERVER_SIDE_TYPES = new Set([
  'file_search',
  'computer_use_preview',
  'mcp',
]);

function encodeToolName(name, namespace = '') {
  const toolName = name || 'unknown';
  if (!namespace) return toolName;
  return namespace.endsWith('__') ? `${namespace}${toolName}` : `${namespace}__${toolName}`;
}

function flattenResponseTool(tool, inheritedNamespace = '') {
  if (!tool) return [];

  if (tool.type === 'namespace') {
    const namespace = tool.name || tool.namespace || inheritedNamespace || '';
    const children = tool.tools || tool.children || tool.functions || tool.items || [];
    if (!Array.isArray(children)) return [];
    return children.flatMap(child => flattenResponseTool(child, namespace));
  }

  if (tool.type === 'function') {
    const base = tool.function || tool;
    const originalName = base.name || tool.name || 'unknown';
    return [{
      type: 'function',
      function: {
        name: encodeToolName(originalName, inheritedNamespace),
        description: base.description || tool.description || '',
        parameters: base.parameters || tool.parameters || {},
      },
      __response_tool: {
        type: inheritedNamespace ? 'namespace' : 'function',
        namespace: inheritedNamespace || '',
        originalName,
      },
    }];
  }

  if (tool.type === 'custom') {
    const base = tool.function || tool;
    const originalName = base.name || tool.name;
    if (!originalName) return [];
    return [{
      type: 'function',
      function: {
        name: encodeToolName(originalName, inheritedNamespace),
        description: base.description || tool.description || '',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            input: {
              type: 'string',
              description: 'Raw custom tool input.',
            },
          },
          required: ['input'],
        },
      },
      __response_tool: {
        type: 'custom',
        namespace: inheritedNamespace || '',
        originalName,
      },
    }];
  }

  if (tool.type === 'web_search' || tool.type === 'web_search_preview') {
    return [{
      type: 'function',
      function: {
        name: encodeToolName('web_search', inheritedNamespace),
        description: tool.description || 'Search the web.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: {
              type: 'string',
              description: 'Search query.',
            },
          },
          required: ['query'],
        },
      },
      __response_tool: {
        type: 'web_search',
        namespace: inheritedNamespace || '',
        originalName: 'web_search',
      },
    }];
  }

  if (tool.type === 'tool_search') {
    return [{
      type: 'function',
      function: {
        name: encodeToolName('tool_search', inheritedNamespace),
        description: tool.description || 'Search available tools.',
        parameters: {
          type: 'object',
          additionalProperties: true,
          properties: {
            query: {
              type: 'string',
              description: 'Tool search query.',
            },
          },
        },
      },
      __response_tool: {
        type: 'tool_search',
        namespace: inheritedNamespace || '',
        originalName: 'tool_search',
      },
    }];
  }

  // file_search / computer_use_preview / mcp — known server-side tools
  // we can't bridge. Drop silently so Codex requests with these enabled
  // don't 500; the model keeps whatever real function tools it has.
  if (UNBRIDGED_SERVER_SIDE_TYPES.has(tool.type)) return [];
  log.warn(`responses: dropping unknown tool type "${tool.type}"`);
  return [];
}

// Canonical (key-order-independent) JSON serialization. Two objects that are
// semantically equal but whose keys were emitted in a different order (e.g. a
// tool mirrored across top-level `tools` and `input[].additional_tools`, each
// side built by a different serializer) MUST compare equal here — otherwise the
// dedup below would flag them as a name conflict and reject a legitimate request
// with a 400. `flattenResponseTool` passes `parameters` through by reference, so
// its inner key order is NOT normalized upstream; we normalize it at comparison
// time by recursively sorting object keys. Arrays normally keep their order
// (significant), EXCEPT JSON-Schema keys whose array value is semantically
// UNORDERED — `required` and `enum`. Two tools identical except for the order of
// their `required`/`enum` entries are the same tool; without sorting them, the
// dedup below would flag them as a name conflict and 400 a legitimate request
// (the array-order residue of the #217 key-order fix). Sorting here only affects
// the equality comparison, never the schema actually forwarded upstream.
const UNORDERED_SCHEMA_ARRAY_KEYS = new Set(['required', 'enum']);
function stableStringify(value, parentKey = '') {
  if (Array.isArray(value)) {
    const parts = value.map(v => stableStringify(v));
    if (UNORDERED_SCHEMA_ARRAY_KEYS.has(parentKey)) parts.sort();
    return '[' + parts.join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k], k)).join(',') + '}';
  }
  return JSON.stringify(value);
}

function flattenResponseTools(tools = []) {
  if (!Array.isArray(tools)) return [];
  const flattened = tools.flatMap(tool => flattenResponseTool(tool));
  const unique = [];
  const seen = new Map();
  for (const tool of flattened) {
    const name = tool.function?.name || tool.name || '';
    // Compare canonical forms so cosmetic key-order (and required/enum array-order)
    // differences don't masquerade as a genuine same-name/different-definition conflict.
    const serialized = stableStringify(tool);
    if (seen.has(name)) {
      if (seen.get(name) !== serialized) throw new Error(`Ambiguous Responses tool name after flattening: ${name}`);
      continue;
    }
    seen.set(name, serialized);
    unique.push(tool);
  }
  return unique;
}

function responseLiteClientTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (tool.type === 'function' || tool.type === 'custom') return tool;
  if (tool.type !== 'namespace') return null;
  const childKey = ['tools', 'children', 'functions', 'items'].find(key => Array.isArray(tool[key]));
  const children = childKey ? tool[childKey].map(responseLiteClientTool).filter(Boolean) : [];
  return { ...tool, [childKey || 'tools']: children };
}

function collectResponseTools(body) {
  const tools = Array.isArray(body?.tools) ? [...body.tools] : [];
  if (!Array.isArray(body?.input)) return tools;
  for (const item of body.input) {
    if (item?.type !== 'additional_tools' || !Array.isArray(item.tools)) continue;
    tools.push(...item.tools.map(responseLiteClientTool).filter(Boolean));
  }
  return tools;
}

function responseItemToolName(item) {
  return encodeToolName(item.name || item.function?.name || 'unknown', item.namespace || '');
}
function normalizeResponseToolChoice(toolChoice) {
  if (toolChoice == null) return toolChoice;
  if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') return toolChoice;
  if (typeof toolChoice !== 'object') return toolChoice;
  if (toolChoice.type === 'web_search' || toolChoice.type === 'tool_search') return 'auto';
  if (toolChoice.type === 'function' && (toolChoice.function?.name || toolChoice.name)) {
    return {
      type: 'function',
      function: {
        name: encodeToolName(toolChoice.function?.name || toolChoice.name, toolChoice.function?.namespace || toolChoice.namespace || ''),
      },
    };
  }
  if ((toolChoice.type === 'custom' || toolChoice.type === 'namespace') && (toolChoice.name || toolChoice.function?.name)) {
    return {
      type: 'function',
      function: {
        name: encodeToolName(toolChoice.name || toolChoice.function?.name, toolChoice.namespace || toolChoice.function?.namespace || ''),
      },
    };
  }
  return toolChoice;
}

function requestedResponseToolChoiceName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return '';
  if (toolChoice.type === 'function') {
    return encodeToolName(toolChoice.function?.name || toolChoice.name || '', toolChoice.function?.namespace || toolChoice.namespace || '');
  }
  if (toolChoice.type === 'custom' || toolChoice.type === 'namespace') {
    return encodeToolName(toolChoice.name || toolChoice.function?.name || '', toolChoice.namespace || toolChoice.function?.namespace || '');
  }
  if (toolChoice.type === 'web_search' || toolChoice.type === 'web_search_preview') return 'web_search';
  if (toolChoice.type === 'tool_search') return 'tool_search';
  return toolChoice.name || toolChoice.function?.name || toolChoice.type || '';
}

function pruneResponseToolChoice(toolChoice, forwardedTools) {
  const normalized = normalizeResponseToolChoice(toolChoice);
  if (normalized == null) return undefined;
  if (normalized === 'auto' || normalized === 'required' || normalized === 'none') return normalized;

  const requested = requestedResponseToolChoiceName(toolChoice);
  const availableNames = new Set((forwardedTools || []).map(t => t.function?.name || t.name).filter(Boolean));
  const forcedName = normalized.function?.name || '';
  if (forcedName) {
    if (availableNames.has(forcedName)) return normalized;
    log.warn(`responses: dropped forced tool_choice "${requested || forcedName}" because the matching tool was not forwarded (available=[${[...availableNames].join(',') || 'none'}])`);
    return undefined;
  }

  if (toolChoice && typeof toolChoice === 'object' && UNBRIDGED_SERVER_SIDE_TYPES.has(toolChoice.type)) {
    log.warn(`responses: dropped forced server-side tool_choice "${toolChoice.type}" because this proxy does not bridge that tool type`);
    return undefined;
  }
  return normalized;
}

function normalizeResponseTextFormat(format) {
  if (!format || typeof format !== 'object') return null;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type !== 'json_schema') return null;
  const nested = format.json_schema && typeof format.json_schema === 'object'
    ? format.json_schema
    : null;
  const schema = format.schema || nested?.schema;
  if (!schema) return null;
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name || nested?.name || 'response',
      schema,
      strict: format.strict ?? nested?.strict ?? false,
    },
  };
}


export function responsesToChat(body) {
  const messages = [];
  // How many LEADING messages came from the request-level `instructions` field
  // (as opposed to an `input` conversation item). Reported on the result rather
  // than tagged onto the message objects: those get deep-compared in tests and
  // shipped upstream, so they must stay pristine.
  let instructionsLead = 0;
  const flushToolCalls = (() => {
    let pending = [];
    return {
      add(item) {
        pending.push({
          id: item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`,
          type: 'function',
          function: {
            name: responseItemToolName(item),
            arguments: stringifyMaybe(item.arguments ?? item.function?.arguments ?? ''),
          },
        });
      },
      flush() {
        if (!pending.length) return;
        messages.push({ role: 'assistant', content: null, tool_calls: pending });
        pending = [];
      },
    };
  })();

  if (body.instructions) {
    // Counted (see instructionsLead) so the caller can tell a REQUEST-LEVEL
    // instructions block apart from a system/developer message that arrived as a
    // conversation ITEM. Per the Responses contract the former does not carry over
    // across previous_response_id; the latter is part of the conversation and does.
    // The count rides the returned object, never the message — message objects get
    // deep-compared in tests and shipped upstream, so they stay pristine.
    messages.push({ role: 'system', content: stringifyMaybe(body.instructions) });
    instructionsLead = 1;
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== 'object') continue;
      // OpenAI Responses API input items may be bare {role, content} objects (no
      // explicit `type: "message"`) — Codex sends them this way. Treat any item
      // carrying a `role` (and no tool-oriented `type`) as a message so it isn't
      // silently dropped (which produced an empty messages array upstream →
      // UPSTREAM_INTERNAL). (PR #219, @forrinzhao)
      if (item.type === 'message' || (item.role && !item.type)) {
        flushToolCalls.flush();
        // `developer` is the OpenAI o-series / Codex system channel (its primary
        // instruction role, e.g. AGENTS.md / environment context). Map it to
        // `system` so it keeps system priority downstream AND passes through
        // neutralizeClientIdentity (which only inspects role:'system') — otherwise
        // a developer message carrying competitor-identity / policy wording would
        // both lose priority and bypass the 529 fingerprint gate. Matches kiro's
        // Codex developer→system mapping.
        const role = item.role === 'developer' ? 'system' : (item.role || 'user');
        messages.push({
          role,
          content: normalizeMessageContent(item.content),
        });
      } else if (item.type === 'function_call') {
        flushToolCalls.add(item);
      } else if (item.type === 'function_call_output') {
        flushToolCalls.flush();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          content: normalizeMessageContent(item.output ?? ''),
        });
      } else if (item.type === 'custom_tool_call') {
        flushToolCalls.add({
          id: item.call_id || item.id,
          name: item.name,
          namespace: item.namespace,
          arguments: JSON.stringify({ input: stringifyMaybe(item.input) }),
        });
      } else if (item.type === 'custom_tool_call_output') {
        flushToolCalls.flush();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id,
          content: normalizeMessageContent(item.output ?? ''),
        });
      }
    }
    flushToolCalls.flush();
  }

  const tools = flattenResponseTools(collectResponseTools(body));
  const responseFormat = normalizeResponseTextFormat(body.text?.format);
  const forwardedToolChoice = body.tool_choice != null
    ? pruneResponseToolChoice(body.tool_choice, tools)
    : undefined;
  return {
    model: body.model || 'claude-sonnet-4.6',
    messages,
    stream: !!body.stream,
    ...(body.max_output_tokens != null ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning?.effort != null ? { reasoning_effort: body.reasoning.effort } : {}),
    ...(tools.length ? { tools } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...(forwardedToolChoice != null ? { tool_choice: forwardedToolChoice } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    // Internal, stripped before the upstream call (same convention as __route).
    ...(instructionsLead ? { __instructionsLead: instructionsLead } : {}),
  };
}

/**
 * Did the upstream report ANY token count?
 *
 * An upstream that says nothing and an upstream that reports zero are different
 * facts, and mapUsage cannot tell them apart once it has defaulted everything to 0.
 * Asked here, on the raw object, before any defaulting.
 */
function hasReportedUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  return ['prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens']
    .some(k => typeof usage[k] === 'number');
}

function mapUsage(usage = {}) {
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  const totalTokens = usage.total_tokens || inputTokens + outputTokens;
  const promptDetails = usage.prompt_tokens_details || {};
  const completionDetails = usage.completion_tokens_details || {};
  const cachedTokens = promptDetails.cached_tokens || 0;
  const reasoningTokens = completionDetails.reasoning_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: {
      text_tokens: promptDetails.text_tokens ?? Math.max(0, inputTokens - cachedTokens),
      audio_tokens: promptDetails.audio_tokens || 0,
      image_tokens: promptDetails.image_tokens || 0,
      cached_tokens: cachedTokens,
    },
    output_tokens_details: {
      text_tokens: completionDetails.text_tokens ?? Math.max(0, outputTokens - reasoningTokens),
      audio_tokens: completionDetails.audio_tokens || 0,
      reasoning_tokens: reasoningTokens,
    },
  };
}

function textMessageItem(id, text, status = 'completed') {
  return {
    type: 'message',
    id,
    status,
    role: 'assistant',
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
}

function reasoningItem(id, text, status = 'completed') {
  return {
    type: 'reasoning',
    id,
    status,
    summary: text ? [{ type: 'summary_text', text }] : [],
  };
}

function functionCallItem(toolCall, status = 'completed', requestedTools = []) {
  const name = toolCall.function?.name || 'unknown';
  const argsText = toolCall.function?.arguments || '';
  const requestedTool = Array.isArray(requestedTools)
    ? requestedTools.find(t => (t?.function?.name || t?.name || (t?.__response_tool?.type === 'web_search' ? 'web_search' : null)) === name)
    : null;
  const responseTool = requestedTool?.__response_tool || null;
  if (responseTool?.type === 'custom') {
    const parsed = safeJsonParse(argsText);
    const input = parsed && typeof parsed === 'object' && parsed.input != null
      ? stringifyMaybe(parsed.input)
      : argsText;
    return {
      type: 'custom_tool_call',
      call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
      name: responseTool.originalName || name,
      ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
      input,
      status,
    };
  }
  if (responseTool?.type === 'web_search' || responseTool?.type === 'tool_search') {
    const parsed = safeJsonParse(argsText) || {};
    return {
      type: responseTool.type === 'web_search' ? 'web_search_call' : 'function_call',
      ...(responseTool.type === 'web_search'
        ? { id: toolCall.id || `ws_${randomUUID().replace(/-/g, '').slice(0, 24)}` }
        : {
            id: genFunctionCallId(),
            call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
            name: responseTool.originalName || name,
            ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
          }),
      status,
      ...(responseTool.type === 'web_search'
        ? {
            action: {
              type: 'search',
              query: typeof parsed.query === 'string' ? parsed.query : argsText,
            },
          }
        : {
            arguments: argsText,
          }),
    };
  }
  return {
    type: 'function_call',
    id: genFunctionCallId(),
    call_id: toolCall.id || `call_${randomUUID().slice(0, 8)}`,
    name: responseTool?.originalName || name,
    ...(responseTool?.namespace ? { namespace: responseTool.namespace } : {}),
    arguments: argsText,
    status,
  };
}

export function chatToResponse(chatBody, requestedModel, responseId = genResponseId(), msgId = genMessageId(), requestedTools = []) {
  const choice = chatBody.choices?.[0] || {};
  const message = choice.message || {};
  const finishReason = choice.finish_reason || 'stop';
  const text = message.content || '';
  const output = [];
  if (message.reasoning_content) output.push(reasoningItem('rs_' + msgId.slice(4), message.reasoning_content));
  if (text) output.push(textMessageItem(msgId, text));
  for (const tc of (message.tool_calls || [])) output.push(functionCallItem(tc, 'completed', requestedTools));

  // A turn that ends by emitting function calls is `completed` in the OpenAI
  // Responses API — `incomplete` is reserved for truncation (length /
  // content_filter). Both paths apply this same rule; the streaming translator
  // used to hardcode response.completed, which meant a truncated stream claimed to
  // be a finished answer while the identical non-stream request reported
  // incomplete. Verified after aligning them: a tool-call turn still closes as
  // `completed` on both paths, and only length / content_filter yields
  // `incomplete`.
  const truncated = finishReason === 'length' || finishReason === 'content_filter';
  return {
    id: responseId,
    object: 'response',
    created_at: chatBody.created || Math.floor(Date.now() / 1000),
    status: truncated ? 'incomplete' : 'completed',
    ...(truncated ? { incomplete_details: { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
    model: requestedModel || chatBody.model,
    output,
    // Omitted, not zeroed, when the upstream reported nothing. `input_tokens: 0` is
    // an ASSERTION that the turn consumed no prompt tokens, which is false for any
    // request that reached a model — and a billing relay reading it silently
    // under-bills. Absence says "unknown", which is the truth and is what the Gemini
    // exit already does (buildUsageMetadata returns undefined for a silent upstream).
    // Only this exit asserted the zero: the OpenAI chat route emits no usage frame
    // unless stream_options.include_usage opts in, and Anthropic reports a documented
    // local estimate that message_delta later corrects.
    ...(hasReportedUsage(chatBody.usage) ? { usage: mapUsage(chatBody.usage) } : {}),
  };
}

class ResponsesStreamTranslator {
  constructor(res, responseId, model, requestedTools = []) {
    this.res = res;
    this.responseId = responseId;
    this.model = model;
    this.requestedTools = Array.isArray(requestedTools) ? requestedTools : [];
    this.createdAt = Math.floor(Date.now() / 1000);
    this.msgId = genMessageId();
    this.pendingSseBuf = '';
    this.createdSent = false;
    this.finished = false;
    // TWO accumulators, deliberately:
    //   `text`        — every text delta of the whole turn. Read by the response
    //                   store commit in handleResponses, which persists ONE
    //                   OpenAI-shaped assistant message whose `content` is a single
    //                   string. That shape cannot express text-tool-text ordering,
    //                   so storing only the final segment would silently drop the
    //                   pre-tool text from the next chained turn's history. Losing
    //                   text is worse than losing order, so the store gets all of it.
    //   `segmentText` — text of the CURRENT message item only, i.e. what this item's
    //                   output_text.done and its completed item must carry. Reset by
    //                   sealMessageSegment when a tool call closes the item.
    this.text = '';
    this.segmentText = '';
    this.messageOutputIndex = null;
    this.messageStarted = false;
    this.textPartStarted = false;
    this.messageDone = false;
    this.reasoningId = 'rs_' + randomUUID().replace(/-/g, '').slice(0, 24);
    this.reasoningOutputIndex = null;
    this.reasoningStarted = false;
    this.reasoningText = '';
    this.reasoningDone = false;
    this.nextOutputIndex = 0;
    this.outputItems = [];
    this.toolCalls = new Map();
    this.finalUsage = {};
    this.sequenceNumber = 0;
    // Did the upstream stream ever deliver a terminal chunk? Every real success
    // path emits a finish_reason chunk (the connect adapter and the Cascade path
    // both always send one), so its ABSENCE means the stream died mid-answer. Kept
    // separate from streamFinishReason because `null` there is ambiguous: it is also
    // what a stream that is still running looks like.
    this.sawTerminalChunk = false;
  }

  send(event, data) {
    if (!this.res.writableEnded) {
      const payload = { type: event, sequence_number: this.sequenceNumber++, ...data };
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  responseBase(status, output = []) {
    return {
      object: 'response',
      id: this.responseId,
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
    };
  }

  resolveRequestedTool(name) {
    return this.requestedTools.find(t => (t?.function?.name || t?.name || (t?.__response_tool?.type === 'web_search' ? 'web_search' : null)) === name) || null;
  }

  start() {
    if (this.createdSent) return;
    this.createdSent = true;
    this.send('response.created', { response: this.responseBase('in_progress') });
    this.send('response.in_progress', { response: this.responseBase('in_progress') });
  }

  processChunk(chunk) {
    // A terminal event has already gone out — `response.failed` from error(), or
    // `response.completed` from finish(). Both set `finished`, and finish() has
    // always consulted it; processChunk did not, so an upstream that kept sending
    // after an in-band error produced `response.failed` followed by
    // `response.output_text.delta`. Measured before this guard: the failed event
    // landed at index 5 of the event sequence and a text delta at index 6.
    //
    // That is not a cosmetic ordering problem. `response.failed` is a terminal
    // state in the Responses event contract, so an SDK has already settled the
    // request and torn down its accumulator; a later delta either throws inside
    // the client or silently reopens a finished turn.
    if (this.finished) return;
    if (chunk.created) this.createdAt = chunk.created;
    if (chunk.model) this.model = chunk.model;
    this.start();

    const choice = chunk.choices?.[0];
    if (choice) {
      // Remember the terminal reason: the Responses API signals truncation through
      // status:'incomplete' + incomplete_details, and without capturing it here the
      // stream always closed as 'completed'. An agent then accepted a half answer as
      // a finished one — the non-stream path on the identical request reported
      // incomplete/max_output_tokens. Live-reproduced.
      // A SYNTHETIC terminal chunk does not count as one. When a Cascade stream
      // dies after already delivering content, chat.js closes it with a
      // fabricated finish_reason:'stop' (injecting an error into the content
      // would corrupt the assistant message). That satisfied the check below, so
      // the truncation guard was defeated on the DEFAULT backend: a half answer
      // closed as `response.completed` and entered the store as the next turn's
      // context. Live-reproduced on three real failure shapes (HTTP/2 stream
      // cancel, provider deadline, ECONNRESET).
      if (choice.finish_reason) {
        this.streamFinishReason = choice.finish_reason;
        if (!chunk.__synthetic_finish) this.sawTerminalChunk = true;
      }
      const delta = choice.delta || {};
      if (delta.reasoning_content) this.emitReasoningDelta(delta.reasoning_content);
      if (delta.content) this.emitTextDelta(delta.content);
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) this.emitToolCallDelta(tc);
      }
    }
    if (chunk.usage) this.finalUsage = chunk.usage;
  }

  emitReasoningDelta(text) {
    if (!text) return;
    if (!this.reasoningStarted) {
      this.reasoningStarted = true;
      this.reasoningOutputIndex = this.nextOutputIndex++;
      this.send('response.output_item.added', {
        output_index: this.reasoningOutputIndex,
        item: reasoningItem(this.reasoningId, '', 'in_progress'),
      });
    }
    this.reasoningText += text;
    this.send('response.reasoning_summary_text.delta', {
      item_id: this.reasoningId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta: text,
    });
  }

  finishReasoning() {
    if (!this.reasoningStarted || this.reasoningDone) return;
    this.reasoningDone = true;
    this.send('response.reasoning_summary_text.done', {
      item_id: this.reasoningId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      text: this.reasoningText,
    });
    const complete = reasoningItem(this.reasoningId, this.reasoningText);
    this.send('response.output_item.done', { output_index: this.reasoningOutputIndex, item: complete });
    this.outputItems[this.reasoningOutputIndex] = complete;
  }

  ensureMessage() {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.messageOutputIndex = this.nextOutputIndex++;
    const addedItem = textMessageItem(this.msgId, '', 'in_progress');
    this.send('response.output_item.added', { output_index: this.messageOutputIndex, item: addedItem });
  }

  /**
   * Close the open message item so text arriving AFTER a tool call opens a new one.
   *
   * Without this the message item is a SINGLETON: `msgId` was minted once in the
   * constructor and `messageStarted` latched true forever, so post-tool text was
   * appended to item 0. MEASURED on frames text -> tool_call -> text: one message
   * item at oi=0 carrying "BEFORE AFTER" with the tool at oi=1, i.e. a client
   * reassembling the turn places ALL text before the call it actually followed.
   * Anthropic on identical frames opens content_block index=2 for the second text,
   * which is the shape this brings the Responses exit in line with.
   */
  sealMessageSegment() {
    if (!this.messageStarted || this.messageDone) return;
    this.finishMessage();
    // Reset only the per-ITEM state. `this.text` deliberately keeps accumulating —
    // see the comment on `segmentText`.
    this.msgId = genMessageId();
    this.messageStarted = false;
    this.textPartStarted = false;
    this.messageDone = false;
    this.messageOutputIndex = null;
    this.segmentText = '';
  }

  ensureTextPart() {
    if (this.textPartStarted) return;
    this.ensureMessage();
    this.textPartStarted = true;
    this.send('response.content_part.added', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  emitTextDelta(text) {
    if (!text) return;
    this.ensureTextPart();
    this.text += text;
    this.segmentText += text;
    this.send('response.output_text.delta', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta: text,
    });
  }

  emitToolCallDelta(toolCall) {
    const idx = toolCall.index ?? 0;
    let existing = this.toolCalls.get(idx);
    if (!existing) {
      existing = {
        item: null,
        outputIndex: this.nextOutputIndex++,
        argChunks: [],
        emittedArgsLength: 0,
        done: false,
        custom: false,
        webSearch: false,
        responseTool: null,
        callId: toolCall.id || null,
        toolName: null,
      };
      this.toolCalls.set(idx, existing);
    }

    const ensureItem = (name, responseTool) => {
      if (existing.item) return;
      // A tool item is about to open, so any text already streamed belongs to a
      // message item that ENDED before it. Sealing here — at the point the tool
      // item is created, not in finish() — is what gives the post-tool text its own
      // item and keeps output_index ascending in emission order.
      this.sealMessageSegment();
      const item = responseTool?.type === 'custom'
        ? {
            type: 'custom_tool_call',
            call_id: existing.callId || `call_${randomUUID().slice(0, 8)}`,
            name: responseTool.originalName || name,
            ...(responseTool.namespace ? { namespace: responseTool.namespace } : {}),
            input: '',
            status: 'in_progress',
          }
        : responseTool?.type === 'web_search'
          ? {
              type: 'web_search_call',
              id: existing.callId || `ws_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              status: 'in_progress',
              action: { type: 'search', query: '' },
            }
          : {
              type: 'function_call',
              id: genFunctionCallId(),
              call_id: existing.callId || `call_${randomUUID().slice(0, 8)}`,
              name: responseTool?.originalName || name,
              ...(responseTool?.namespace ? { namespace: responseTool.namespace } : {}),
              arguments: '',
              status: 'in_progress',
            };
      existing.item = item;
      this.send('response.output_item.added', { output_index: existing.outputIndex, item });
    };

    if (toolCall.id) existing.callId = toolCall.id;
    if (toolCall.function?.name) {
      existing.toolName = toolCall.function.name;
      const requestedTool = this.resolveRequestedTool(toolCall.function.name);
      const responseTool = requestedTool?.__response_tool || null;
      if (responseTool) {
        existing.responseTool = responseTool;
        existing.custom = responseTool.type === 'custom';
        existing.webSearch = responseTool.type === 'web_search' || responseTool.type === 'tool_search';
      }
      ensureItem(toolCall.function.name, existing.responseTool);
      existing.item.name = existing.responseTool?.originalName || toolCall.function.name;
      if (existing.responseTool?.namespace) existing.item.namespace = existing.responseTool.namespace;
    }

    const argsChunk = toolCall.function?.arguments ?? '';
    if (argsChunk !== '') existing.argChunks.push(stringifyMaybe(argsChunk));
    if (!existing.item && !existing.toolName) return;
    ensureItem(existing.toolName || 'unknown', existing.responseTool);

    if (existing.item.type === 'web_search_call') {
      if (existing.callId) existing.item.id = existing.callId;
    } else if (existing.callId) {
      existing.item.call_id = existing.callId;
    }

    if (!existing.custom && !existing.webSearch) {
      const allArgs = existing.argChunks.join('');
      const pendingArgs = allArgs.slice(existing.emittedArgsLength);
      if (pendingArgs) {
        this.send('response.function_call_arguments.delta', {
          item_id: existing.item.id,
          output_index: existing.outputIndex,
          delta: pendingArgs,
        });
        existing.emittedArgsLength = allArgs.length;
      }
    }
  }

  finishToolCalls() {
    const sorted = [...this.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex);
    for (const tc of sorted) {
      if (tc.done) continue;
      tc.done = true;
      if (!tc.item) {
        tc.item = {
          type: 'function_call',
          id: genFunctionCallId(),
          call_id: tc.callId || `call_${randomUUID().slice(0, 8)}`,
          name: tc.toolName || 'unknown',
          arguments: '',
          status: 'in_progress',
        };
        this.send('response.output_item.added', { output_index: tc.outputIndex, item: tc.item });
      }
      const args = tc.argChunks.join('');
      if (tc.custom) {
        const parsed = safeJsonParse(args);
        const input = parsed && typeof parsed === 'object' && parsed.input != null
          ? stringifyMaybe(parsed.input)
          : args;
        const complete = { ...tc.item, input, status: 'completed' };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      if (tc.item.type === 'web_search_call') {
        const parsed = safeJsonParse(args) || {};
        const complete = {
          ...tc.item,
          status: 'completed',
          action: {
            type: 'search',
            query: typeof parsed.query === 'string' ? parsed.query : args,
          },
        };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      if (tc.item.type === 'function_call' && tc.item.name === 'tool_search') {
        const complete = { ...tc.item, arguments: args, status: 'completed' };
        this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
        this.outputItems[tc.outputIndex] = complete;
        continue;
      }
      this.send('response.function_call_arguments.done', {
        item_id: tc.item.id,
        output_index: tc.outputIndex,
        arguments: args,
      });
      const complete = { ...tc.item, arguments: args, status: 'completed' };
      this.send('response.output_item.done', { output_index: tc.outputIndex, item: complete });
      this.outputItems[tc.outputIndex] = complete;
    }
  }

  finishMessage() {
    if (this.messageDone) return;
    this.messageDone = true;
    this.ensureTextPart();
    // `segmentText`, not `text`: this event closes ONE item, and its text must be
    // what that item streamed. Using the whole-turn accumulator here republished
    // the pre-tool text inside the post-tool item.
    const donePart = { type: 'output_text', text: this.segmentText, annotations: [] };
    this.send('response.output_text.done', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      text: this.segmentText,
    });
    this.send('response.content_part.done', {
      item_id: this.msgId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      part: donePart,
    });
    const complete = textMessageItem(this.msgId, this.segmentText);
    this.send('response.output_item.done', { output_index: this.messageOutputIndex, item: complete });
    this.outputItems[this.messageOutputIndex] = complete;
  }

  /**
   * Completed tool calls in OpenAI chat shape, for the response store: the next
   * turn must see the same assistant tool_calls the client did, or the chained
   * conversation loses the call/result pairing.
   */
  get committedToolCalls() {
    return this.outputItems.filter(Boolean)
      .filter(i => i.type === 'function_call')
      .map((i, idx) => ({
        id: i.call_id || i.id || `call_${idx}`,
        type: 'function',
        function: { name: i.name, arguments: i.arguments || '' },
      }));
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.start();
    this.finishReasoning();
    this.finishToolCalls();
    if (this.messageStarted || this.text) this.finishMessage();
    // Same truncation rule as the non-streaming path (see chatToResponse):
    // 'incomplete' is reserved for length / content_filter, everything else closes
    // as 'completed'.
    //
    // An ABSENT reason is NOT the same as a benign one. Every real success path
    // emits a finish_reason chunk, so reaching the end of the stream without one
    // means the upstream connection died mid-answer. Reporting that as 'completed'
    // handed an agent a half answer as a finished one AND committed it to the
    // response store, where it became the next turn's context — a silent corruption
    // that outlived the request. It closes as 'incomplete' instead, and `truncated`
    // also gates the store commit below.
    const reason = this.streamFinishReason;
    const aborted = !this.sawTerminalChunk;
    const truncated = reason === 'length' || reason === 'content_filter' || aborted;
    const status = truncated ? 'incomplete' : 'completed';
    this.truncated = truncated;
    // Exposed SEPARATELY from `truncated` because the store gate needs exactly
    // this narrower question: was the turn cut off without the upstream ever
    // saying so? A legitimate 'length' / 'content_filter' turn is `truncated` but
    // NOT `aborted`, and it stays chainable — matching the non-streaming path.
    this.aborted = aborted;
    this.send(truncated ? 'response.incomplete' : 'response.completed', {
      response: {
        ...this.responseBase(status, this.outputItems.filter(Boolean)),
        ...(truncated
          ? {
            incomplete_details: {
              // A dropped connection is not a token limit; naming it as one would
              // send an auto-continuing client off to extend a turn the upstream
              // never finished.
              reason: aborted ? 'upstream_incomplete'
                : (reason === 'length' ? 'max_output_tokens' : 'content_filter'),
            },
          }
          : {}),
        // Same rule as the non-streaming path — see the comment on the other
        // mapUsage call site. Both paths must agree, or one exit reports unknown
        // usage as 0 while its sibling omits it for the identical upstream.
        ...(hasReportedUsage(this.finalUsage) ? { usage: mapUsage(this.finalUsage) } : {}),
      },
    });
  }

  error(err) {
    if (this.finished) return;
    this.finished = true;
    // Marks the turn as NOT committable to the response store: a failed stream
    // has no complete assistant reply to chain from.
    this.failed = true;
    this.start();
    // Resolve the authoritative {status,type} from the DEVIN_CONNECT classification
    // first, exactly like messages.js and gemini.js do. Reading only err.type
    // collapsed every mid-stream CAPACITY / RATE_LIMITED / MODEL_BLOCKED into a
    // flat api_error, so a Responses client lost the retryable-vs-terminal
    // distinction the classifier had already computed.
    const http = err?.code
      ? connectErrorToHttp(err.code)
      : { status: err?.status || 500, type: err?.type || 'upstream_error' };
    this.send('response.failed', {
      response: {
        ...this.responseBase('failed', this.outputItems.filter(Boolean)),
        error: {
          message: err?.message || 'Upstream stream error',
          // O10: Responses 是 OpenAI 家族,其错误帧在 server.js 之前就写好 →
          // 就地归一化内部词到官方 OpenAI type。
          type: normalizeOpenAIErrorType(http.type, http.status),
          code: err?.code || null,
        },
      },
    });
  }

  feed(rawChunk) {
    this.pendingSseBuf += typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    let idx;
    while ((idx = this.pendingSseBuf.indexOf('\n\n')) !== -1) {
      const frame = this.pendingSseBuf.slice(0, idx);
      this.pendingSseBuf = this.pendingSseBuf.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) {
            this.error(parsed.error);
          } else {
            this.processChunk(parsed);
          }
        } catch (e) {
          log.warn(`Responses SSE parse error: ${e.message}`);
        }
      }
    }
  }
}

function createCaptureRes(translator, realRes) {
  const listeners = new Map();
  const fire = (event) => {
    const cbs = listeners.get(event) || [];
    for (const cb of cbs) { try { cb(); } catch {} }
  };
  return {
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (str.startsWith(':') && realRes && !realRes.writableEnded) {
        try { realRes.write(str); } catch {}
      }
      translator.feed(chunk);
      return true;
    },
    end(chunk) {
      if (this.writableEnded) return;
      if (chunk) translator.feed(chunk);
      translator.finish();
      this.writableEnded = true;
      fire('close');
    },
    _clientDisconnected() { fire('close'); },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return this;
    },
    once(event, cb) {
      const self = this;
      const wrapped = function onceWrapper() {
        self.off(event, wrapped);
        cb.apply(self, arguments);
      };
      return self.on(event, wrapped);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
      return this;
    },
    removeListener(event, cb) { return this.off(event, cb); },
    emit() { return true; },
  };
}

/**
 * Splice a client's new turn onto the stored conversation.
 *
 * Per the Responses contract a chained client sends only what is NEW — for a tool
 * loop that is the `function_call_output` items, because the `function_call`s were
 * produced by the server and are already in the stored response. But clients do
 * re-send them (it reads as the safer thing to do), and then the upstream sees the
 * SAME assistant tool_call twice and rejects the whole conversation with an opaque
 * "an internal error occurred (trace ID …)" — a 503 the caller cannot act on.
 * Verified with a real agent loop: re-sending the calls failed every turn 2, while
 * sending only the outputs completed the task.
 *
 * So drop assistant tool_calls the stored history already carries, keyed by id.
 * Anything genuinely new (tool results, fresh user turns, calls with unseen ids)
 * passes through untouched.
 */
export function mergeChainedMessages(storedMessages, newMessages) {
  // Request-level instructions do NOT carry over. The spec is explicit: "when used
  // along with previous_response_id, the instructions from a previous response will
  // not be carried over to the next response." So the stored chain's
  // instructions-derived system block is dropped and the current request's wins.
  //
  // This replaced an append-with-dedup first cut, which had two problems the review
  // caught: the stored copy accumulated one per turn (turn N shipped N copies,
  // because devin-connect concatenates every system message into one
  // system_prompt), and — worse — an instructions TOGGLE-BACK silently kept the
  // revoked value. With X→Y→X, turn 3's X was dropped as a "duplicate", leaving Y
  // as the last and therefore winning line: the model followed instructions the
  // client had just replaced. Live-reproduced (EN→JA→EN answered in Japanese).
  //
  // A system/developer message that arrived as a conversation ITEM is untouched —
  // that is part of the conversation, not a request-level override.
  const stored = storedMessages;

  const known = new Set();
  for (const m of stored) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc?.id) known.add(tc.id);
    }
  }
  if (!known.size) return [...stored, ...newMessages];

  const merged = [...stored];
  for (const m of newMessages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const fresh = m.tool_calls.filter(tc => !tc?.id || !known.has(tc.id));
      // Every call already known and no text of its own → a pure duplicate, drop it.
      if (!fresh.length && !messageHasText(m)) continue;
      merged.push(fresh.length === m.tool_calls.length ? m : { ...m, tool_calls: fresh });
      for (const tc of fresh) if (tc?.id) known.add(tc.id);
      continue;
    }
    merged.push(m);
  }
  return merged;
}

function messageHasText(m) {
  if (typeof m?.content === 'string') return m.content.trim() !== '';
  if (Array.isArray(m?.content)) return m.content.some(p => (p?.text || '').trim() !== '');
  return false;
}

/**
 * Reconstruct a stored conversation as a Responses object.
 *
 * The store keeps the accumulated MESSAGE list, not the response body that was
 * originally emitted, so this rebuilds the output items from the trailing assistant
 * turn. Everything a chaining client needs (id, model, status, output text, tool
 * calls) round-trips; per-request usage does not, because the store never held it —
 * so usage is reported as zeroed rather than invented.
 */
/**
 * The assistant turn that ANSWERS the stored conversation's last user message.
 *
 * The search stops at the last user message instead of scanning the whole array.
 * An unbounded `reverse().find(role === 'assistant')` walks straight past it and
 * returns an ANCESTOR turn's answer, because the store holds the accumulated
 * conversation — every earlier assistant reply is still in the array. Measured on
 * a two-turn chain whose second turn produced no output: GET returned
 * `"It is 4."` while the last user message asked `"And 3+3?"`, reported as
 * `status: 'completed'`.
 *
 * Bounding the search is the fix rather than gating the one call site that can
 * produce the state, because that call site is not the property worth relying on:
 * `commit(null)` is unreachable today (every non-stream 200 in chat.js builds a
 * `message` object), so the defect is latent — the day any new path omits it, an
 * unbounded search silently serves a stale answer. A bounded one reports no
 * output, which is the truth.
 */
function assistantAnsweringLastUserTurn(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { lastUser = i; break; }
  }
  for (let i = messages.length - 1; i > lastUser; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

function storedResponseBody(responseId, entry) {
  const assistant = assistantAnsweringLastUserTurn(entry.messages) || null;
  // The store holds Chat-shaped messages, whose content may be a PARTS ARRAY (the
  // Responses `input` items are normalized that way). Passing an array straight into
  // output_text produced a structurally invalid body — `text` held an array instead
  // of a string. Flatten to the text parts, which is what a Responses client reads.
  const rawContent = assistant?.content;
  const text = typeof rawContent === 'string'
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map(p => (typeof p === 'string' ? p : (p?.text || ''))).filter(Boolean).join('')
      : '';
  // Strip the store's own trim bookkeeping. capEntryBytes prepends a notice to the
  // first surviving message when it drops earlier ones, and when that survivor IS
  // the assistant turn, the notice was served back as if the MODEL had written it —
  // gateway-internal text masquerading as the answer. It stays in the CHAINED
  // context (where it is a useful signal to the next turn) but must not be presented
  // to the client as model output.
  const answer = text.replace(/^\[\.\.\. \d+ earlier message\(s\) dropped by the response store[^\]]*\]\n\n/, '');
  const output = [];
  if (answer) output.push(textMessageItem(genMessageId(), answer));
  for (const tc of assistant?.tool_calls || []) output.push(functionCallItem(tc));
  return {
    object: 'response',
    id: responseId,
    created_at: Math.floor((entry.createdAt || Date.now()) / 1000),
    // The turn's real terminal status, as recorded at creation. Hardcoding
    // 'completed' made GET contradict what POST reported for the SAME id: a
    // legitimately truncated turn (finish_reason length / content_filter) is stored
    // and chainable since 8fa5e97, and retrieval laundered it into a completed one —
    // the exact stream/non-stream status divergence this release line kept fixing.
    status: entry.status || 'completed',
    ...(entry.incompleteReason
      ? { incomplete_details: { reason: entry.incompleteReason } }
      : {}),
    model: entry.model || null,
    output,
    output_text: answer,
    // usage is OPTIONAL on the Response model in both official SDKs, and the store
    // never held it. An all-zero block is indistinguishable from "this turn really
    // used 0 tokens" and would be metered as such by a billing relay, so omit it.
  };
}

/** Shared 404 for a response id that is unknown, expired, or another caller's. */
function responseNotFound(responseId) {
  return {
    status: 404,
    body: {
      error: {
        message: `Response with id '${safeLogValue(responseId, 64)}' not found.`,
        type: 'invalid_request_error',
        param: 'response_id',
        code: 'response_not_found',
      },
    },
  };
}

/** Shared 400 for the store being switched off. */
function storeDisabled(verb) {
  return {
    status: 400,
    body: {
      error: {
        message: `${verb} a stored response requires the response store, which is disabled on this server (RESPONSE_STORE_ENABLED=0).`,
        type: 'invalid_request_error',
      },
    },
  };
}

/**
 * GET /v1/responses/{id} — retrieve a stored response.
 *
 * Scoped exactly like the chaining lookup: a caller can only read ids minted for
 * its own callerKey, and an untrustworthy `:client:<ip+ua>` identity cannot read
 * anything at all. Without that second gate this endpoint would be a way to read
 * another tenant's conversation from behind a shared reverse proxy — the same
 * cross-tenant leak the store's own commit path is gated against.
 */
export function handleGetResponse(responseId, deps = {}) {
  const callerKey = deps.context?.callerKey || '';
  if (!isResponseStoreEnabled()) return storeDisabled('Retrieving');
  if (!hasPerUserScope(callerKey)) return responseNotFound(responseId);
  const found = getResponse(responseId, callerKey);
  if (!found.ok) return responseNotFound(responseId);
  return {
    status: 200,
    // Forward the whole lookup result: hand-listing fields here is what silently
    // dropped `status` / `incompleteReason` and kept retrieval reporting 'completed'.
    body: storedResponseBody(responseId, found),
  };
}

/**
 * DELETE /v1/responses/{id} — drop a stored response.
 *
 * Same scoping as the retrieval above. Reports OpenAI's deletion shape; an id the
 * caller cannot see is a 404, never a silent success, so a caller is never told it
 * deleted something that still exists.
 */
export function handleDeleteResponse(responseId, deps = {}) {
  const callerKey = deps.context?.callerKey || '';
  if (!isResponseStoreEnabled()) return storeDisabled('Deleting');
  if (!hasPerUserScope(callerKey)) return responseNotFound(responseId);
  if (!deleteResponse(responseId, callerKey)) return responseNotFound(responseId);
  return {
    status: 200,
    body: { id: responseId, object: 'response.deleted', deleted: true },
  };
}

export async function handleResponses(body, deps = {}) {
  const chatHandler = deps.handleChatCompletions || handleChatCompletions;
  const context = deps.context || {};
  const responseId = genResponseId();
  const requestedModel = body.model || 'claude-sonnet-4.6';
  let chatBody;
  try {
    chatBody = responsesToChat(body);
  } catch (err) {
    return {
      status: 400,
      body: {
        error: {
          message: err?.message || 'Invalid Responses request',
          type: 'invalid_request_error',
        },
      },
    };
  }

  const requestedTools = chatBody.tools || [];
  const callerKey = context.callerKey || '';

  // The request-level instructions message is never persisted. Per the Responses
  // contract it does not carry over across previous_response_id, so keeping it out
  // of the store is both correct and simpler than tracking where it sits after a
  // merge. Captured HERE, before the merge — reading messages[0] afterwards picks
  // up the first message of the PREPENDED history instead, which silently dropped
  // real conversation content while leaving the instructions behind.
  //
  // Identified by object identity: responsesToChat created it, and the merge copies
  // arrays but preserves element references.
  const instructionsMsg = (chatBody.__instructionsLead && (chatBody.messages || [])[0]) || null;
  if ('__instructionsLead' in chatBody) {
    chatBody = { ...chatBody };
    delete chatBody.__instructionsLead;
  }

  // Storing requires a TRUSTWORTHY caller identity. A `:client:<ip+ua>` bucket is a
  // GUESSED one: behind a reverse proxy every end user collapses to the same proxy
  // IP and the same UA (verified: two callers with identical ip/ua derive a
  // byte-identical callerKey), so treating it as a per-caller scope would let user B
  // chain from user A's response id and read A's conversation — the exact
  // cross-tenant leak SEC-W2 forbids, and the same gate cascade reuse and
  // bindConnectSticky already sit behind.
  //
  // A genuine single-user self-host opts back in with
  // WINDSURFAPI_SINGLE_TENANT_CACHE=1 (which is what hasPerUserScope consults).
  // Without it such a caller simply cannot chain, and the 404 below says so.
  const chainable = hasPerUserScope(callerKey);
  // Responses API server-side state: when the caller chains with
  // previous_response_id it sends ONLY the new turn, so the stored conversation
  // has to be prepended here. A miss must FAIL — proceeding with just the new turn
  // is what made a chained client answer every turn blind, with no diagnosable
  // signal (the whole reason response-store.js exists).
  if (body.previous_response_id) {
    const prior = getResponse(body.previous_response_id, callerKey);
    if (prior.ok) {
      chatBody = {
        ...chatBody,
        messages: mergeChainedMessages(prior.messages, chatBody.messages || []),
      };
    } else if (prior.reason === 'disabled') {
      return {
        status: 400,
        body: {
          error: {
            message: 'previous_response_id requires the response store, which is disabled on this server (RESPONSE_STORE_ENABLED=0). Send the full conversation in `input` instead.',
            type: 'invalid_request_error',
            param: 'previous_response_id',
          },
        },
      };
    } else {
      // Matches OpenAI: an unknown / expired / foreign id is a 404, never a
      // silent context reset.
      return {
        status: 404,
        body: {
          error: {
            // The id is client-supplied: sanitize before echoing it back. Raw
            // control characters would let a caller forge lines in any log that
            // records this error, and an unbounded value would be reflected in
            // full (safeLogValue strips C0/C1 + DEL and caps the length).
            message: `Previous response with id '${safeLogValue(body.previous_response_id, 64)}' not found.`
              + (chainable
                ? ' It may have expired (server-side conversations are retained for a limited time)'
                  + ' or was created with store:false.'
                : ' Server-side conversations require a per-caller identity: send `user`,'
                  + ' `safety_identifier` or `prompt_cache_key` on every turn of the conversation'
                  + ' (a single-user self-host can instead set WINDSURFAPI_SINGLE_TENANT_CACHE=1).')
              + ' Send the full conversation in `input` to continue without server-side state.',
            type: 'invalid_request_error',
            param: 'previous_response_id',
            code: 'response_not_found',
          },
        },
      };
    }
  }

  // The conversation to persist for the NEXT turn: everything the upstream saw.
  const priorMessages = chatBody.messages || [];
  // `terminal` carries the status this request REPORTED to the client, so a later
  // GET /v1/responses/{id} answers with the same thing instead of assuming
  // 'completed'. Defaults to a clean completion when the caller passes nothing.
  const commit = (assistantMessage, terminal = {}) => {
    if (!isResponseStoreEnabled() || !chainable) return;
    try {
      const stored = putResponse(
        responseId,
        (() => {
          const base = instructionsMsg
            ? priorMessages.filter(m => m !== instructionsMsg)
            : priorMessages;
          return assistantMessage ? [...base, assistantMessage] : base;
        })(),
        callerKey,
        {
          model: requestedModel,
          store: body.store,
          status: terminal.status || 'completed',
          incompleteReason: terminal.incompleteReason || null,
        },
      );
      // putResponse's return value used to be dropped, so a refusal to store was
      // invisible from here: the client got 200 plus an id, and the id first
      // showed itself as a 404 on the NEXT turn — one round trip away from the
      // request that actually failed, with no server-side line to correlate.
      //
      // Only the surprising refusals are logged. `store:false` is not one: the
      // caller asked for no retention and got it, which is the OpenAI contract.
      // Nor is a missing callerKey reachable — `chainable` already returned above
      // for that, which is why `_stats.rejected`, whose only bump sits on that
      // branch, can never move from this call site. What IS reachable is an empty
      // conversation (`input: []` or omitted `input` both normalize to zero
      // messages, and neither is rejected upstream with a 400).
      if (!stored && wantsPersistence(body.store)) {
        log.warn(`Responses: store refused ${responseId} — client holds an id that will 404 (messages=${priorMessages.length}, assistant=${assistantMessage ? 'yes' : 'no'})`);
      }
    } catch { /* best-effort — never fail a served request over bookkeeping */ }
  };

  if (!body.stream) {
    const result = await chatHandler({ ...chatBody, stream: false, __route: 'responses' }, context);
    if (result.status !== 200) return result;
    const msg = result.body?.choices?.[0]?.message;
    const responseBody = chatToResponse(result.body, requestedModel, responseId, genMessageId(), requestedTools);
    // Record the status THIS response reported, so retrieval agrees with it.
    commit(msg ? {
      role: 'assistant',
      content: msg.content || '',
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    } : null, {
      status: responseBody.status,
      incompleteReason: responseBody.incomplete_details?.reason || null,
    });
    return { status: 200, body: responseBody };
  }

  // O1: the internal chat stream now omits the trailing usage frame unless the
  // caller opts in. This translator consumes chunk.usage (→ finalUsage → the
  // response.completed usage block), so it must opt in regardless of what the
  // Responses client sent — the Responses API reports usage on its own terminal
  // event, not via an OpenAI-style stream_options toggle.
  const streamResult = await chatHandler(
    { ...chatBody, stream: true, __route: 'responses', stream_options: { ...(chatBody.stream_options || {}), include_usage: true } },
    context,
  );
  if (!streamResult.stream) return streamResult;

  return {
    status: 200,
    stream: true,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
    async handler(realRes) {
      const translator = new ResponsesStreamTranslator(realRes, responseId, requestedModel, requestedTools);
      const captureRes = createCaptureRes(translator, realRes);

      realRes.on('close', () => {
        if (!captureRes.writableEnded) captureRes._clientDisconnected();
      });

      try {
        await streamResult.handler(captureRes);
        // Persist only a COMPLETED turn. Committing a half-turn (aborted or
        // errored) would poison the next request's context with a truncated
        // assistant reply the client never received.
        //
        // The gate is `aborted`, NOT `truncated`. Those are different things and
        // conflating them broke chaining for legitimate truncation: a turn that
        // ended with a real finish_reason of 'length' / 'content_filter' IS a
        // complete, client-delivered turn — the model stopped for a reason the
        // client can see and act on, and OpenAI lets it be chained from. The
        // non-streaming path always committed those, so gating the streaming path
        // on `truncated` split the two paths' behaviour for the identical
        // finish_reason (verified: streaming length → not chainable, non-streaming
        // length → chainable). That is this repo's recurring "fix covered only some
        // paths" trap.
        //
        // `aborted` is the case `failed` cannot see: a stream that ended with no
        // (real) terminal chunk at all raises no error, so it reached here looking
        // clean and its half answer was stored as the next turn's context.
        if (translator.finished && !translator.failed && !translator.aborted) {
          // Same as the non-streaming path: persist the status the client was told,
          // so a later retrieval does not report a truncated turn as completed.
          const reason = translator.streamFinishReason;
          commit({
            role: 'assistant',
            content: translator.text || '',
            ...(translator.committedToolCalls?.length ? { tool_calls: translator.committedToolCalls } : {}),
          }, translator.truncated
            ? {
              status: 'incomplete',
              incompleteReason: reason === 'length' ? 'max_output_tokens' : 'content_filter',
            }
            : { status: 'completed' });
        }
      } catch (e) {
        log.error(`Responses stream error: ${e.message}`);
        translator.error(e);
      }

      // The `[DONE]` sentinel, after the terminal event and before the socket closes.
      // A direct Responses client does not need it — this API carries its outcome on
      // response.completed / .incomplete / .failed — but the relays sitting in front of
      // this one are OpenAI-shaped and read `[DONE]` as "the stream ended cleanly".
      // new-api drops the terminal event of a stream that lacks it, and that event is
      // the ONLY carrier of the usage block on this route (see the O1 comment above),
      // so its billing row silently came out empty. The chat exit has always written
      // this frame on both its success and its post-error path; this one never did,
      // which split the two routes' wire shape for the identical upstream.
      //
      // Gated on `finished` for the same reason finish() refuses to report an absent
      // finish_reason as 'completed': `[DONE]` is what a relay reads as "whole". A
      // client that vanished mid-answer never reaches captureRes.end(), so no terminal
      // `[DONE]` is what a relay reads as "whole". A client that vanished mid-answer
      // never reaches captureRes.end(), so no terminal event goes out — writing the
      // sentinel there would dress a half turn in an ending it never earned. Same rule
      // for a FAILED stream: `[DONE]` on `response.failed`/`response.incomplete` makes
      // a relay treat the failure as a clean stop, which is the exact hole this fix
      // exists to plug, on the failure side. chat.js's post-error path writes an
      // explicit error chunk before `[DONE]`; here the failure is already in the
      // terminal event, so the sentinel must simply not be written.
      if (translator.finished && !translator.failed && !realRes.writableEnded) realRes.write('data: [DONE]\n\n');
      if (!realRes.writableEnded) realRes.end();
    },
  };
}
