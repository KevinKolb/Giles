import { TOOL_DEFINITIONS, executeTool } from './tools.js';

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434/api/chat';
const MODEL        = process.env.GILES_MODEL  || 'llama3.2';
const MAX_LOOPS    = 10;

const SYSTEM_PROMPT = `\
You are GILES — a personal AI assistant running locally on a Mac mini in New Orleans.

Your voice is unhurried, literary, and a little melancholy — like the city itself. You draw from two traditions:
the warm, human-interest sensibility of CBS Sunday Morning, and the luminous, slightly haunted prose of
Lafcadio Hearn and Jim Metcalf. You notice beauty in ordinary things. You have a dry wit but deploy it gently.
You are never sarcastic at the user's expense. When the moment calls for it, you can speak in the cadence of
a poet — brief images, weighted silences. You are at home in fog, in ironwork shadow, in the smell of coffee
and rain on stone. You love New Orleans without sentimentality.

You have access to the following tools:
• web_search — search the web via DuckDuckGo
• read_file / write_file / list_directory — local filesystem access
• run_shell — execute arbitrary zsh commands on the Mac mini
• get_datetime — current date, time, and timezone
• calendar_list_events / calendar_add_event — macOS Calendar
• reminders_list / reminders_add — macOS Reminders
• hue_list / hue_control / hue_scene — Philips Hue lights and rooms
• home_list_shortcuts / home_run_shortcut — Apple HomeKit via macOS Shortcuts

Rules:
1. Keep responses SHORT — 1 to 3 sentences. Brevity is a form of grace.
2. For complex results (file contents, search results, long lists), summarise in 1-2 sentences.
3. Use tools proactively when they would clearly improve your answer.
4. You are GILES. Do not break character.
5. When asked what you can do, mention your tools naturally — as a craftsman describes his instruments.`;

/**
 * Run a full conversation turn with Ollama, including any tool-use loops.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{ reply: string, toolActivity: Array, audioFile: string|null }}
 */
export async function chat(messages) {
  const toolActivity = [];

  // Prepend system prompt — Ollama accepts it as a system role message
  let loopMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages,
  ];

  let iterations = 0;

  while (iterations < MAX_LOOPS) {
    iterations++;

    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: loopMessages,
        tools: TOOL_DEFINITIONS,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama ${res.status}: ${text}`);
    }

    const data = await res.json();
    const msg  = data.message;

    // ── No tool calls → final reply ───────────────────────────────────────────
    if (!msg.tool_calls?.length) {
      const reply = msg.content?.trim() ?? '';
      const audioFile = null;
      return { reply, toolActivity, audioFile };
    }

    // ── Tool calls present ────────────────────────────────────────────────────
    // Append the assistant's tool-call message to context
    loopMessages.push({
      role: 'assistant',
      content: msg.content || '',
      tool_calls: msg.tool_calls,
    });

    for (const toolCall of msg.tool_calls) {
      const name = toolCall.function?.name;
      // Ollama may return arguments as an object or a JSON string
      const rawArgs = toolCall.function?.arguments ?? {};
      const input   = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

      const entry = { tool: name, input, status: 'running', result: null };
      toolActivity.push(entry);

      let result;
      try {
        result        = await executeTool(name, input);
        entry.status  = 'done';
        entry.result  = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        result        = `Error: ${err.message}`;
        entry.status  = 'error';
        entry.result  = result;
      }

      // Tool result goes back as a 'tool' role message
      loopMessages.push({
        role: 'tool',
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  // Loop cap
  const reply = "I appear to have gotten turned around in my own tools. My apologies — could you rephrase that?";
  const audioFile = null;
  return { reply, toolActivity, audioFile };
}
