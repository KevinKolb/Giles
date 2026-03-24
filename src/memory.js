import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const HISTORY_PATH = join(process.env.HOME, '.giles', 'history.json');
const MAX_MESSAGES = 50; // total messages kept on disk

// ── Disk I/O ──────────────────────────────────────────────────────────────────

export async function load() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const raw = await readFile(HISTORY_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function save(history) {
  const tmp = `${HISTORY_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(history, null, 2), 'utf-8');
  await rename(tmp, HISTORY_PATH); // atomic write
}

export async function clear() {
  await save([]);
}

// ── Context building ──────────────────────────────────────────────────────────

/** Returns a Claude-compatible messages array with the new user message appended. */
export async function buildContext(userMessage) {
  const history = await load();
  const messages = history
    .slice(-MAX_MESSAGES)
    .map(({ role, content }) => ({ role, content })); // strip timestamps

  messages.push({ role: 'user', content: userMessage });
  return messages;
}

/** Append a completed turn to disk (prune to MAX_MESSAGES). */
export async function append(userMessage, assistantReply) {
  const history = await load();
  const now = new Date().toISOString();
  history.push({ role: 'user', content: userMessage, timestamp: now });
  history.push({ role: 'assistant', content: assistantReply, timestamp: now });

  // Prune oldest messages to stay within limit
  while (history.length > MAX_MESSAGES) history.shift();

  await save(history);
}
