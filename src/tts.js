import { execFile, execFileSync } from 'child_process';
import { unlink } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, '..', 'public', 'audio');

const VOICE = process.env.GILES_VOICE || 'Samantha';
const RATE = 185; // words per minute

// Verify the configured voice exists at startup; fall back to Samantha
function resolveVoice(preferred) {
  try {
    const output = execFileSync('say', ['-v', '?'], { encoding: 'utf-8' });
    const voices = output.split('\n').map(l => l.split(/\s+/)[0]);
    if (voices.includes(preferred)) return preferred;
    console.warn(`[tts] Voice "${preferred}" not found, falling back to Samantha`);
    return 'Samantha';
  } catch {
    return 'Samantha';
  }
}

const ACTIVE_VOICE = resolveVoice(VOICE);
console.log(`[tts] Using voice: ${ACTIVE_VOICE}`);

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err); else resolve({ stdout, stderr });
    });
  });
}

/**
 * Convert text → WAV via macOS `say` + `afconvert`.
 * Returns the WAV filename (relative to AUDIO_DIR).
 */
export async function speak(text) {
  if (!text?.trim()) return null;

  // Truncate very long responses — speak a summary, full text shown in UI
  const speakText = text.length > 600
    ? text.substring(0, 600).trimEnd() + '…'
    : text;

  const id = randomBytes(8).toString('hex');
  const aiffPath = join(AUDIO_DIR, `${id}.aiff`);
  const wavPath  = join(AUDIO_DIR, `${id}.wav`);

  // Step 1: Generate AIFF via say
  await execAsync('say', ['-v', ACTIVE_VOICE, '-r', String(RATE), '-o', aiffPath, speakText], {
    timeout: 30000
  });

  // Step 2: Convert AIFF → WAV (16-bit PCM, 22050 Hz — universally browser-compatible)
  await execAsync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@22050', aiffPath, wavPath], {
    timeout: 10000
  });

  // Step 3: Clean up AIFF immediately
  unlink(aiffPath).catch(() => {});

  // Step 4: Auto-delete WAV after 90 seconds
  setTimeout(() => unlink(wavPath).catch(() => {}), 90_000);

  return `${id}.wav`;
}
