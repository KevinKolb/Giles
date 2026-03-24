import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { search, SafeSearchType } from 'duck-duck-scrape';
import { hueList, hueControl, hueScene } from './hue.js';
import { homeListShortcuts, homeRunShortcut } from './home.js';

const execFileAsync = promisify(execFile);

// Resolve ~ in paths
function resolvePath(p) {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

// ── AppleScript helper ────────────────────────────────────────────────────────
async function runAppleScript(script) {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10000 });
  return stdout.trim();
}

// Format JS Date → AppleScript date string: "3/25/2026 10:00 AM"
function toAppleScriptDate(isoString) {
  const d = new Date(isoString);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const yr = d.getFullYear();
  const hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${m}/${day}/${yr} ${h12}:${mins} ${ampm}`;
}

// ── DuckDuckGo search with optional Brave fallback ────────────────────────────
const searchCache = new Map();
let lastSearchTime = 0;

async function webSearch(query) {
  // Check cache
  if (searchCache.has(query)) return searchCache.get(query);

  // Rate-limit: 2-second debounce
  const now = Date.now();
  if (now - lastSearchTime < 2000) {
    await new Promise(r => setTimeout(r, 2000 - (now - lastSearchTime)));
  }
  lastSearchTime = Date.now();

  // Try Brave Search if key is available
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) {
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY }
      });
      const data = await res.json();
      const results = (data.web?.results ?? []).slice(0, 5).map(r => ({
        title: r.title, url: r.url, snippet: r.description ?? ''
      }));
      const out = JSON.stringify(results, null, 2);
      searchCache.set(query, out);
      return out;
    } catch { /* fall through to DDG */ }
  }

  // DuckDuckGo fallback
  const results = await search(query, { safeSearch: SafeSearchType.OFF });
  const top = (results.results ?? []).slice(0, 5).map(r => ({
    title: r.title, url: r.url, snippet: r.description ?? ''
  }));
  const out = JSON.stringify(top, null, 2);
  searchCache.set(query, out);
  return out;
}

// ── Tool handlers ─────────────────────────────────────────────────────────────
const handlers = {

  web_search: async ({ query }) => {
    return await webSearch(query);
  },

  read_file: async ({ path }) => {
    const resolved = resolvePath(path);
    if (!existsSync(resolved)) return `File not found: ${resolved}`;
    const stat = (await readFile(resolved)).length;
    if (stat > 512_000) return `File is too large (${Math.round(stat / 1024)}KB). Try a smaller file or read a specific section.`;
    return await readFile(resolved, 'utf-8');
  },

  write_file: async ({ path, content }) => {
    const resolved = resolvePath(path);
    await writeFile(resolved, content, 'utf-8');
    return `Written to ${resolved}`;
  },

  list_directory: async ({ path }) => {
    const resolved = resolvePath(path);
    const entries = await readdir(resolved, { withFileTypes: true });
    return JSON.stringify(
      entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
      null, 2
    );
  },

  run_shell: async ({ command, timeout_ms = 10000 }) => {
    const timeout = Math.min(timeout_ms, 30000);
    try {
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        const child = execFile('/bin/zsh', ['-c', command], { timeout }, (err, stdout, stderr) => {
          if (err && err.killed) reject(new Error('Command timed out'));
          else resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err?.code ?? 0 });
        });
        child;
      });
      const out = [stdout, stderr].filter(Boolean).join('\n').substring(0, 10000);
      return out || '(no output)';
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },

  get_datetime: async () => {
    const now = new Date();
    return now.toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    });
  },

  calendar_list_events: async ({ days_ahead = 7 }) => {
    const script = `
      set output to {}
      tell application "Calendar"
        set theDate to current date
        set endDate to (current date) + (${days_ahead} * days)
        repeat with c in calendars
          set theEvents to (events of c whose start date >= theDate and start date <= endDate)
          repeat with e in theEvents
            set end of output to (summary of e) & "|" & (start date of e as string) & "|" & (name of c)
          end repeat
        end repeat
      end tell
      set AppleScript's text item delimiters to "\\n"
      return output as string
    `;
    try {
      const result = await runAppleScript(script);
      if (!result) return 'No events found in the next ' + days_ahead + ' days.';
      const events = result.split('\n').filter(Boolean).map(line => {
        const [title, date, calendar] = line.split('|');
        return { title, date, calendar };
      });
      return JSON.stringify(events, null, 2);
    } catch (err) {
      return `Calendar error: ${err.message}. Make sure GILES has Calendar access in System Settings → Privacy & Security.`;
    }
  },

  calendar_add_event: async ({ title, start_date, end_date, notes = '' }) => {
    const startStr = toAppleScriptDate(start_date);
    const endStr = toAppleScriptDate(end_date);
    const script = `
      tell application "Calendar"
        tell calendar 1
          set newEvent to make new event with properties {summary:"${title.replace(/"/g, '\\"')}", start date:date "${startStr}", end date:date "${endStr}", description:"${notes.replace(/"/g, '\\"')}"}
        end tell
      end tell
      return "Event created"
    `;
    try {
      return await runAppleScript(script);
    } catch (err) {
      return `Calendar error: ${err.message}`;
    }
  },

  reminders_list: async ({ list_name } = {}) => {
    const listFilter = list_name
      ? `tell list "${list_name.replace(/"/g, '\\"')}"`
      : 'tell default list';
    const script = `
      set output to {}
      tell application "Reminders"
        set allReminders to reminders whose completed is false
        repeat with r in allReminders
          set dueStr to ""
          try
            set dueStr to " (due: " & (due date of r as string) & ")"
          end try
          set end of output to (name of r) & dueStr
        end repeat
      end tell
      set AppleScript's text item delimiters to "\\n"
      return output as string
    `;
    try {
      const result = await runAppleScript(script);
      return result || 'No incomplete reminders found.';
    } catch (err) {
      return `Reminders error: ${err.message}. Make sure GILES has Reminders access in System Settings → Privacy & Security.`;
    }
  },

  reminders_add: async ({ title, due_date, list_name = 'Reminders', notes = '' }) => {
    const dueClause = due_date ? `, due date:date "${toAppleScriptDate(due_date)}"` : '';
    const notesClause = notes ? `, body:"${notes.replace(/"/g, '\\"')}"` : '';
    const script = `
      tell application "Reminders"
        tell list "${list_name.replace(/"/g, '\\"')}"
          make new reminder with properties {name:"${title.replace(/"/g, '\\"')}"${dueClause}${notesClause}}
        end tell
      end tell
      return "Reminder added"
    `;
    try {
      return await runAppleScript(script);
    } catch (err) {
      return `Reminders error: ${err.message}`;
    }
  },

  hue_list: async () => {
    try { return await hueList(); } catch (err) { return `Hue error: ${err.message}`; }
  },

  hue_control: async ({ target, on, brightness, color, color_temp }) => {
    try { return await hueControl({ target, on, brightness, color, color_temp }); } catch (err) { return `Hue error: ${err.message}`; }
  },

  hue_scene: async ({ action, name, room }) => {
    try { return await hueScene({ action, name, room }); } catch (err) { return `Hue error: ${err.message}`; }
  },

  home_list_shortcuts: async () => {
    return await homeListShortcuts();
  },

  home_run_shortcut: async ({ name }) => {
    return await homeRunShortcut({ name });
  },
};

// ── Tool definitions (Ollama / OpenAI function-calling format) ────────────────
function fn(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

export const TOOL_DEFINITIONS = [
  fn('web_search', 'Search the web. Returns top 5 results with title, URL, and description.', {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  }),
  fn('read_file', 'Read the contents of a local file by path. Supports ~ for home directory.', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  }),
  fn('write_file', 'Write content to a local file, creating it if needed.', {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  }),
  fn('list_directory', 'List files and folders in a directory.', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  }),
  fn('run_shell', 'Run a zsh shell command on the Mac mini. Returns stdout + stderr.', {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'number', description: 'Max ms to wait, default 10000' },
    },
    required: ['command'],
  }),
  fn('get_datetime', 'Get the current date, time, day of week, and timezone.', {
    type: 'object', properties: {},
  }),
  fn('calendar_list_events', 'List upcoming events from macOS Calendar.', {
    type: 'object',
    properties: { days_ahead: { type: 'number', description: 'Days ahead to look, default 7' } },
  }),
  fn('calendar_add_event', 'Add an event to macOS Calendar.', {
    type: 'object',
    properties: {
      title:      { type: 'string' },
      start_date: { type: 'string', description: 'ISO 8601 datetime' },
      end_date:   { type: 'string', description: 'ISO 8601 datetime' },
      notes:      { type: 'string' },
    },
    required: ['title', 'start_date', 'end_date'],
  }),
  fn('reminders_list', 'List incomplete reminders from macOS Reminders.', {
    type: 'object',
    properties: { list_name: { type: 'string', description: 'Specific list, or omit for all' } },
  }),
  fn('reminders_add', 'Add a reminder to macOS Reminders.', {
    type: 'object',
    properties: {
      title:     { type: 'string' },
      due_date:  { type: 'string', description: 'Optional ISO 8601 datetime' },
      list_name: { type: 'string', description: 'Target list, default "Reminders"' },
      notes:     { type: 'string' },
    },
    required: ['title'],
  }),
  fn('hue_list', 'List all Philips Hue lights and rooms with their current state and brightness.', {
    type: 'object', properties: {},
  }),
  fn('hue_control', 'Control a Hue light or room by name. Set on/off, brightness 0-100, color, or color temperature.', {
    type: 'object',
    properties: {
      target:     { type: 'string', description: 'Light or room name — partial case-insensitive match.' },
      on:         { type: 'boolean' },
      brightness: { type: 'number', description: '0-100 percent' },
      color:      { type: 'string', description: 'Color name (red, blue, green, orange, purple, pink, cyan, white, warm_white) or hex.' },
      color_temp: { type: 'string', enum: ['warm', 'neutral', 'cool', 'daylight'] },
    },
    required: ['target'],
  }),
  fn('hue_scene', 'List or activate a Philips Hue scene by name.', {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'activate'] },
      name:   { type: 'string', description: 'Scene name. Required for activate.' },
      room:   { type: 'string', description: 'Optional room to narrow the search.' },
    },
    required: ['action'],
  }),
  fn('home_list_shortcuts', 'List all macOS Shortcuts. HomeKit automations appear here.', {
    type: 'object', properties: {},
  }),
  fn('home_run_shortcut', 'Run a macOS Shortcut by name to control Apple HomeKit devices.', {
    type: 'object',
    properties: { name: { type: 'string', description: 'Exact shortcut name.' } },
    required: ['name'],
  }),
];

export async function executeTool(name, input) {
  const handler = handlers[name];
  if (!handler) return `Unknown tool: ${name}`;
  return handler(input);
}
