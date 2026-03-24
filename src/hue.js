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
function bridgeBase() {
  const ip  = process.env.HUE_BRIDGE_IP?.trim();
  const key = process.env.HUE_API_KEY?.trim();
  if (!ip || !key) throw new Error(
    'Hue not configured. POST /api/hue/pair (press the bridge button first).'
  );
  return `http://${ip}/api/${key}`;
}

async function hueGet(path) {
  const res = await fetch(`${bridgeBase()}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Hue HTTP ${res.status} on GET ${path}`);
  return res.json();
}

async function huePut(path, body) {
  const res = await fetch(`${bridgeBase()}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Hue HTTP ${res.status} on PUT ${path}`);
  return res.json();
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
  const [lights, groups] = await Promise.all([hueGet('/lights'), hueGet('/groups')]);

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

  const [lights, groups] = await Promise.all([hueGet('/lights'), hueGet('/groups')]);

  // Try room first
  const rooms = Object.entries(groups)
    .filter(([, g]) => g.type === 'Room' || g.type === 'Zone')
    .map(([id, g]) => ({ id, name: g.name }));
  const room = fuzzyMatch(target, rooms);
  if (room) {
    await huePut(`/groups/${room.id}/action`, state);
    return `Applied to room "${room.name}": ${JSON.stringify(state)}`;
  }

  // Try individual light
  const lightCandidates = Object.entries(lights).map(([id, l]) => ({ id, name: l.name }));
  const light = fuzzyMatch(target, lightCandidates);
  if (light) {
    await huePut(`/lights/${light.id}/state`, state);
    return `Applied to light "${light.name}": ${JSON.stringify(state)}`;
  }

  return `No light or room matching "${target}". Use hue_list to see names.`;
}

export async function hueScene({ action, name, room }) {
  const scenes = await hueGet('/scenes');

  if (action === 'list') {
    const list = Object.entries(scenes).map(([id, s]) => ({ id, name: s.name, group: s.group }));
    return JSON.stringify(list, null, 2);
  }

  if (action === 'activate') {
    if (!name) return 'Error: name is required to activate a scene.';
    let candidates = Object.entries(scenes).map(([id, s]) => ({ id, name: s.name, group: s.group }));

    if (room) {
      const groups = await hueGet('/groups');
      const groupMatch = fuzzyMatch(room, Object.entries(groups).map(([id, g]) => ({ id, name: g.name })));
      if (groupMatch) {
        const filtered = candidates.filter(c => c.group === groupMatch.id);
        if (filtered.length) candidates = filtered;
      }
    }

    const scene = fuzzyMatch(name, candidates);
    if (!scene) return `No scene matching "${name}". Use action "list" to see available scenes.`;
    await huePut(`/groups/${scene.group}/action`, { scene: scene.id });
    return `Scene "${scene.name}" activated.`;
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

  const pairRes = await fetch(`http://${bridgeIp}/api`, {
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
