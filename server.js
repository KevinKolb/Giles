import 'dotenv/config';
import express from 'express';
import { createReadStream, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chat } from './src/claude.js';
import { buildContext, append, load, clear } from './src/memory.js';
import { discoverAndPair } from './src/hue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, 'public', 'audio');

// Ensure required directories exist
mkdirSync(join(process.env.HOME, '.giles'), { recursive: true });
mkdirSync(AUDIO_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(join(__dirname, 'public')));

// ── Chat ─────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'No message provided' });

  try {
    const messages = await buildContext(message);
    const { reply, toolActivity, audioFile } = await chat(messages);
    await append(message, reply);
    res.json({
      reply,
      toolActivity,
      audioUrl: audioFile ? `/audio/${audioFile}` : null,
    });
  } catch (err) {
    console.error('[chat error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Audio ─────────────────────────────────────────────────────────────────────
app.get('/audio/:file', (req, res) => {
  // Sanitise — only allow hex filenames with .wav extension
  if (!/^[0-9a-f]{16}\.wav$/.test(req.params.file)) {
    return res.status(400).send('Invalid audio filename');
  }
  const filePath = join(AUDIO_DIR, req.params.file);
  res.setHeader('Content-Type', 'audio/wav');
  createReadStream(filePath).on('error', () => res.status(404).send('Not found')).pipe(res);
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  res.json(await load());
});

app.delete('/api/history', async (req, res) => {
  await clear();
  res.json({ ok: true });
});

// ── Hue pairing ───────────────────────────────────────────────────────────────
app.post('/api/hue/pair', async (_req, res) => {
  try {
    const { bridgeIp, apiKey } = await discoverAndPair();

    // Write to .env so values persist across restarts
    const envPath = join(__dirname, '.env');
    let envContent = '';
    try { envContent = await readFile(envPath, 'utf-8'); } catch { /* may not exist */ }

    const cleaned = envContent
      .split('\n')
      .filter(l => !l.startsWith('HUE_BRIDGE_IP=') && !l.startsWith('HUE_API_KEY='))
      .join('\n')
      .trimEnd();
    await writeFile(envPath, `${cleaned}\nHUE_BRIDGE_IP=${bridgeIp}\nHUE_API_KEY=${apiKey}\n`, 'utf-8');

    // Apply immediately without restart
    process.env.HUE_BRIDGE_IP = bridgeIp;
    process.env.HUE_API_KEY   = apiKey;

    res.json({ ok: true, bridgeIp, message: `Paired. Bridge: ${bridgeIp}. Ready immediately.` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000');

function tryListen(port) {
  const server = app.listen(port, () => {
    console.log(`\nGILES online → http://localhost:${port}\n`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 3005) {
      console.warn(`Port ${port} in use, trying ${port + 1}…`);
      tryListen(port + 1);
    } else {
      throw err;
    }
  });
}

tryListen(PORT);
