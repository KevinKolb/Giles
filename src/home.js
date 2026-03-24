// Apple HomeKit integration via macOS Shortcuts CLI.
// Requires macOS 12 Monterey or later (/usr/bin/shortcuts).
// Create HomeKit shortcuts in the Shortcuts app, then GILES can run them by name.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const SHORTCUTS = '/usr/bin/shortcuts';

export async function homeListShortcuts() {
  try {
    const { stdout } = await execFileAsync(SHORTCUTS, ['list'], { timeout: 10000 });
    const names = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    if (!names.length) return 'No shortcuts found. Create HomeKit shortcuts in the Shortcuts app first.';
    return JSON.stringify(names, null, 2);
  } catch (err) {
    if (err.code === 'ENOENT') return 'Shortcuts CLI not available. Requires macOS 12+.';
    return `Error listing shortcuts: ${err.message}`;
  }
}

export async function homeRunShortcut({ name }) {
  if (!name) return 'Error: name is required.';
  try {
    const { stdout, stderr } = await execFileAsync(SHORTCUTS, ['run', name], { timeout: 20000 });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    return out || `Shortcut "${name}" ran successfully.`;
  } catch (err) {
    if (err.code === 'ENOENT') return 'Shortcuts CLI not available. Requires macOS 12+.';
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return out || `Error running shortcut "${name}": ${err.message}`;
  }
}
