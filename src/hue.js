// Philips Hue Bridge wrapper — native fetch only, no extra dependencies.
// Requires HUE_BRIDGE_IP and HUE_API_KEY in environment.

// ── Color name → { hue, sat } ─────────────────────────────────────────────────
// hue: 0-65535, sat: 0-254
const COLOR_MAP = {
  red:        { hue: 0,     sat: 254 },
  orange:     { hue: 6553,  sat: 254 },
  yellow:     { hue: 10922, sat: 254 },
  lime:       { hue: 18000, sat: 254 },
  green:      { hue: 21845, sat: 254 },
  teal:       { hue: 29000, sat: 254 },
  cyan:       { hue: 32767, sat: 254 },
  azure:      { hue: 38000, sat: 254 },
  blue:       { hue: 43690, sat: 254 },
  indigo:     { hue: 46000, sat: 254 },
  violet:     { hue: 48000, sat: 254 },
  purple:     { hue: 48500, sat: 254 },
  magenta:    { hue: 54613, sat: 254 },
  rose:       { hue: 58000, sat: 220 },
  pink:       { hue: 56000, sat: 200 },
  white:      { hue: 0,     sat: 0   },
  warm_white: { hue: 0,     sat: 0   },
};

// ── Color temperature name → mired (1,000,000 / Kelvin) ───────────────────────
const COLOR_TEMP_MAP = {
  warm:     454, // ~2200K candlelight
  neutral:  284, // ~3500K reading
  cool:     222, // ~4500K focus
  daylight: 153, // ~6500K energising
};

// ── Bridge HTTP helpers ────────────────────────────────────────────────────────
function bridges() {
  const list = [];
  const ip1 = process.env.HUE_BRIDGE_IP?.trim();
  const key1 = process.env.HUE_API_KEY?.trim();
  if (ip1 && key1) list.push(`https://${ip1}/api/${key1}`);
  const ip2 = process.env.HUE_BRIDGE_IP2?.trim();
  const key2 = process.env.HUE_API_KEY2?.trim();
  if (ip2 && key2) list.push(`https://${ip2}/api/${key2}`);
  if (!list.length) throw new Error('Hue not configured. Add HUE_BRIDGE_IP and HUE_API_KEY to .env.');
  return list;
}

// Newer Hue bridges use self-signed TLS certs.
// undici Agent with rejectUnauthorized:false is the correct way for Node.js built-in fetch.
import { Agent } from 'undici';
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

async function hueGet(base, path) {
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(5000),
    dispatcher: insecureAgent,
  });
  if (!res.ok) throw new Error(`Hue HTTP ${res.status} on GET ${path}`);
  return res.json();
}

async function huePut(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
    dispatcher: insecureAgent,
  });
  if (!res.ok) throw new Error(`Hue HTTP ${res.status} on PUT ${path}`);
  return res.json();
}

// Fetch from all bridges and merge results
async function hueGetAll(path) {
  const results = await Promise.all(bridges().map(b => hueGet(b, path).catch(() => ({}))));
  return Object.assign({}, ...results);
}

// ── Fuzzy name match ──────────────────────────────────────────────────────────
function fuzzyMatch(target, candidates) {
  const q = target.toLowerCase();
  return (
    candidates.find(c => c.name.toLowerCase() === q) ||
    candidates.find(c => c.name.toLowerCase().startsWith(q)) ||
    candidates.find(c => c.name.toLowerCase().includes(q)) ||
    null
  );
}

// ── State payload builder ─────────────────────────────────────────────────────
function buildState({ on, brightness, color, color_temp }) {
  const state = {};

  if (typeof on === 'boolean') state.on = on;

  if (typeof brightness === 'number') {
    state.bri = Math.max(1, Math.min(254, Math.round((brightness / 100) * 254)));
    if (brightness > 0 && state.on === undefined) state.on = true;
  }

  if (color) {
    const key = color.toLowerCase().replace(/\s+/g, '_');
    if (COLOR_MAP[key]) {
      const { hue: h, sat: s } = COLOR_MAP[key];
      if (s === 0) {
        state.sat = 0;
        state.ct  = COLOR_TEMP_MAP.neutral;
      } else {
        state.hue = h;
        state.sat = s;
      }
      if (state.on === undefined) state.on = true;
    } else if (/^#?[0-9a-f]{6}$/i.test(color)) {
      // Hex → CIE xy (Wide RGB D65 gamut)
      const hex = color.replace('#', '');
      let r = parseInt(hex.slice(0,2), 16) / 255;
      let g = parseInt(hex.slice(2,4), 16) / 255;
      let b = parseInt(hex.slice(4,6), 16) / 255;
      r = r > 0.04045 ? Math.pow((r+0.055)/1.055, 2.4) : r/12.92;
      g = g > 0.04045 ? Math.pow((g+0.055)/1.055, 2.4) : g/12.92;
      b = b > 0.04045 ? Math.pow((b+0.055)/1.055, 2.4) : b/12.92;
      const X = r*0.664511 + g*0.154324 + b*0.162028;
      const Y = r*0.283881 + g*0.668433 + b*0.047685;
      const Z = r*0.000088 + g*0.072310 + b*0.986039;
      const sum = X + Y + Z;
      if (sum > 0) state.xy = [+(X/sum).toFixed(4), +(Y/sum).toFixed(4)];
      if (state.on === undefined) state.on = true;
    } else {
      return { error: `Unknown color "${color}". Use a name (red, blue, warm_white…) or hex (#ff6600).` };
    }
  }

  if (color_temp) {
    const mired = COLOR_TEMP_MAP[color_temp.toLowerCase()];
    if (!mired) return { error: `Unknown color_temp "${color_temp}". Use: warm, neutral, cool, daylight.` };
    state.ct = mired;
    if (state.on === undefined) state.on = true;
  }

  return state;
}

// ── Exported tool handlers ────────────────────────────────────────────────────

export async function hueList() {
  const [lights, groups] = await Promise.all([hueGetAll('/lights'), hueGetAll('/groups')]);

  const lightList = Object.entries(lights).map(([id, l]) => ({
    id, name: l.name,
    on: l.state.on,
    reachable: l.state.reachable,
    brightness: l.state.bri != null ? Math.round((l.state.bri / 254) * 100) : null,
  }));

  const roomList = Object.entries(groups)
    .filter(([, g]) => g.type === 'Room' || g.type === 'Zone')
    .map(([id, g]) => ({ id, name: g.name, any_on: g.state.any_on, all_on: g.state.all_on }));

  return JSON.stringify({ lights: lightList, rooms: roomList }, null, 2);
}

export async function hueControl({ target, on, brightness, color, color_temp }) {
  if (!target) return 'Error: target is required.';

  const state = buildState({ on, brightness, color, color_temp });
  if (state.error) return state.error;
  if (Object.keys(state).length === 0) return 'No changes specified.';

  // Search all bridges
  for (const base of bridges()) {
    const [lights, groups] = await Promise.all([
      hueGet(base, '/lights').catch(() => ({})),
      hueGet(base, '/groups').catch(() => ({})),
    ]);

    const rooms = Object.entries(groups)
      .filter(([, g]) => g.type === 'Room' || g.type === 'Zone')
      .map(([id, g]) => ({ id, name: g.name }));
    const room = fuzzyMatch(target, rooms);
    if (room) {
      await huePut(base, `/groups/${room.id}/action`, state);
      return `Applied to room "${room.name}": ${JSON.stringify(state)}`;
    }

    const lightCandidates = Object.entries(lights).map(([id, l]) => ({ id, name: l.name }));
    const light = fuzzyMatch(target, lightCandidates);
    if (light) {
      await huePut(base, `/lights/${light.id}/state`, state);
      return `Applied to light "${light.name}": ${JSON.stringify(state)}`;
    }
  }

  return `No light or room matching "${target}". Use hue_list to see names.`;
}

export async function hueScene({ action, name, room }) {
  if (action === 'list') {
    const scenes = await hueGetAll('/scenes');
    const list = Object.entries(scenes).map(([id, s]) => ({ id, name: s.name, group: s.group }));
    return JSON.stringify(list, null, 2);
  }

  if (action === 'activate') {
    if (!name) return 'Error: name is required to activate a scene.';

    for (const base of bridges()) {
      const scenes = await hueGet(base, '/scenes').catch(() => ({}));
      let candidates = Object.entries(scenes).map(([id, s]) => ({ id, name: s.name, group: s.group, base }));

      if (room) {
        const groups = await hueGet(base, '/groups').catch(() => ({}));
        const groupMatch = fuzzyMatch(room, Object.entries(groups).map(([id, g]) => ({ id, name: g.name })));
        if (groupMatch) {
          const filtered = candidates.filter(c => c.group === groupMatch.id);
          if (filtered.length) candidates = filtered;
        }
      }

      const scene = fuzzyMatch(name, candidates);
      if (scene) {
        await huePut(base, `/groups/${scene.group}/action`, { scene: scene.id });
        return `Scene "${scene.name}" activated.`;
      }
    }
    return `No scene matching "${name}". Use action "list" to see available scenes.`;
  }

  return 'Error: action must be "list" or "activate".';
}

// ── Bridge discovery + pairing ────────────────────────────────────────────────
export async function discoverAndPair() {
  let bridgeIp = process.env.HUE_BRIDGE_IP?.trim();

  if (!bridgeIp) {
    const res = await fetch('https://discovery.meethue.com/', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('Bridge discovery failed.');
    const bridges = await res.json();
    if (!bridges.length) throw new Error('No Hue bridges found on the network.');
    bridgeIp = bridges[0].internalipaddress;
  }

  const pairRes = await fetch(`https://${bridgeIp}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicetype: 'giles#mac' }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await pairRes.json();

  if (data[0]?.error) {
    const desc = data[0].error.description ?? '';
    if (desc.includes('button')) throw new Error('Link button not pressed. Press the button on top of the Hue bridge and try again within 30 seconds.');
    throw new Error(`Bridge error: ${desc}`);
  }

  const apiKey = data[0]?.success?.username;
  if (!apiKey) throw new Error('Unexpected bridge response: ' + JSON.stringify(data));
  return { bridgeIp, apiKey };
}
