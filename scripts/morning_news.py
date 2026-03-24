#!/usr/bin/env python3
"""
New Orleans Morning — Daily news digest in the spirit of CBS Sunday Morning,
A Sunday Journal, and the literary tradition of New Orleans.

Curates human-interest and cultural stories (heavy New Orleans tilt),
weaves in original poetry in the style of Jim Metcalf, and opens with
a Lafcadio Hearn quote, then emails a beautiful HTML digest.

Uses Ollama (local AI) + DuckDuckGo search. No cloud API required.
"""

import os
import json
import time
import smtplib
import argparse
import requests
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

# ── Configuration ─────────────────────────────────────────────────────────────
RECIPIENT_EMAIL  = os.environ.get("NEWS_RECIPIENT", "kevinmkolb@gmail.com")
SENDER_EMAIL     = os.environ.get("NEWS_SENDER", "")
SENDER_PASSWORD  = os.environ.get("NEWS_PASSWORD", "")
SMTP_HOST        = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT        = int(os.environ.get("SMTP_PORT", "587"))
JSON_OUTPUT_PATH = os.environ.get("NOM_JSON_PATH", "/tmp/nom_today.json")
OLLAMA_URL       = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/chat")
OLLAMA_MODEL     = os.environ.get("MORNING_MODEL", "llama3.1:8b")
# ─────────────────────────────────────────────────────────────────────────────

HEARN_QUOTES = [
    {"text": "Times are not good here. The city is crumbling into ashes... but it is better to live here in sackcloth and ashes than to own the whole state of Ohio.", "source": "Inventing New Orleans"},
    {"text": "Woo the muse of the odd.", "source": "Lafcadio Hearn's America"},
    {"text": "The image we have of New Orleans as beautiful and mysterious, dangerous and decaying — that is Lafcadio Hearn's invention as much as the city's own.", "source": "Creole Sketches"},
    {"text": "We owe more to our illusions than to our knowledge.", "source": "Glimpses of Unfamiliar Japan"},
    {"text": "Literary success of any enduring kind is made by refusing to do what publishers want, by refusing to write what the public wants.", "source": "Books and Habits"},
    {"text": "The poet or the story-teller who cannot give the reader a little ghostly pleasure at times never can be either a really great writer or a great thinker.", "source": "Books and Habits"},
    {"text": "If it were not for mosquitoes, we should all become terribly lazy in this climate. We should waste our time snoring upon sofas... Idleness is the mother of all vices.", "source": "Daily City Item, New Orleans"},
    {"text": "There is a greater happiness possible than to be lord of heaven and earth; that is the happiness of being truly loved.", "source": "Books and Habits"},
    {"text": "All good work is done the way ants do things — a little at a time.", "source": "Books and Habits"},
    {"text": "The Shadow-maker shapes forever.", "source": "Lafcadio Hearn"},
]

SYSTEM_PROMPT = """You are the senior writer and producer of "New Orleans Morning" —
a daily digest in the spiritual tradition of two great Sunday morning institutions:

1. CBS SUNDAY MORNING — warm, unhurried, human-interest, culturally rich.
2. JIM METCALF'S "A SUNDAY JOURNAL" — the New Orleans answer to that show.
   Metcalf was a Peabody Award-winning journalist and poet at WWL-TV who wrote
   like Robert Frost talked about New Orleans. Understated, precise, infatuated with words.
3. LAFCADIO HEARN — who prowled the French Quarter from 1877–1888 and virtually
   invented the notion of New Orleans as idea and symbol.

CURATION PRIORITIES: New Orleans stories first, then Gulf South, then American arts/culture.
AVOID: partisan politics, crime for crime's sake, stock prices, celebrity gossip.
WRITING VOICE: Warm. Slightly literary. Never breathless. A little poetic.
You write like Jim Metcalf talked — as if each word was chosen on purpose."""


# ── Search ────────────────────────────────────────────────────────────────────

def gather_news():
    """Search DuckDuckGo for New Orleans and human-interest stories."""
    try:
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
    except ImportError:
        print("   [!] ddgs not installed. Run: pip3 install ddgs")
        return []

    queries = [
        "New Orleans news today",
        "New Orleans arts music food culture",
        "New Orleans Saints Pelicans Tulane",
        "Louisiana human interest story this week",
        "New Orleans restaurant chef food scene",
        "American arts nature human interest story",
    ]

    all_results = []
    with DDGS() as ddgs:
        for query in queries:
            try:
                results = list(ddgs.news(query, max_results=3))
                all_results.extend(results)
                time.sleep(1.5)
            except Exception as e:
                print(f"   [!] Search error for '{query}': {e}")

    return all_results


def format_search_results(results):
    if not results:
        return "No search results available. Write from your knowledge of New Orleans."
    lines = []
    for r in results[:18]:
        lines.append(
            f"HEADLINE: {r.get('title', '')}\n"
            f"SOURCE: {r.get('source', '')}\n"
            f"DATE: {r.get('date', '')}\n"
            f"SUMMARY: {r.get('body', r.get('excerpt', ''))}"
        )
    return "\n\n---\n\n".join(lines)


# ── Ollama ────────────────────────────────────────────────────────────────────

def ollama_chat(user_content, system_content):
    r = requests.post(
        OLLAMA_URL,
        json={
            "model": OLLAMA_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": system_content},
                {"role": "user",   "content": user_content},
            ],
        },
        timeout=300,
    )
    r.raise_for_status()
    return r.json()["message"]["content"]


def parse_json_from_response(text):
    """Extract JSON from model output, handling markdown code fences."""
    clean = text.strip()
    if "```" in clean:
        parts = clean.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            try:
                return json.loads(part)
            except Exception:
                continue
    # Try raw parse
    try:
        return json.loads(clean)
    except Exception:
        # Find first { and last }
        start = clean.find("{")
        end   = clean.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(clean[start:end])
    raise ValueError("Could not parse JSON from model response")


# ── Main fetch ────────────────────────────────────────────────────────────────

def fetch_and_curate_stories(dry_run=False):
    today   = datetime.now().strftime("%A, %B %d, %Y")
    day_idx = datetime.now().timetuple().tm_yday % len(HEARN_QUOTES)
    hearn   = HEARN_QUOTES[day_idx]

    if dry_run:
        print("   [DRY RUN] Returning mock data.")
        return _mock_data(today, hearn)

    print("   Searching the web for stories...")
    results   = gather_news()
    news_text = format_search_results(results)
    print(f"   Found {len(results)} search results.")

    prompt = f"""Today is {today}.

Here are today's news search results:

{news_text}

Using these results as your source material, produce today's New Orleans Morning digest.
Select the 5–7 most interesting, human-interest-focused stories.
Weight heavily toward New Orleans. Discard anything political, criminal, or financial.

Also write ONE short original poem in the style of Jim Metcalf —
spare, understated, 12–16 lines, finding the profound in something ordinary and New Orleans.

Return ONLY a valid JSON object. No markdown. No preamble. No explanation. Just the JSON.

{{
  "date": "{today}",
  "hearn_quote": {{
    "text": "{hearn['text']}",
    "source": "{hearn['source']}"
  }},
  "anchor_open": "2-3 sentence Sunday morning opening in the Metcalf/Pauley voice.",
  "metcalf_poem": {{
    "title": "Poem title in Metcalf's style",
    "lines": ["line 1", "line 2", "...up to 16 lines"]
  }},
  "stories": [
    {{
      "id": 1,
      "category": "NEW ORLEANS",
      "headline": "Headline as it would appear on screen",
      "tease": "One-sentence poetic tease",
      "body": "Full 2-3 paragraph story. Separate paragraphs with double newline.",
      "kicker": "Warm closing line",
      "source_hint": "Source name"
    }}
  ],
  "closing": "2-3 sentence warm sign-off in Jane Pauley's voice"
}}

Categories must be one of: NEW ORLEANS, LOUISIANA, ARTS & CULTURE, MUSIC, FOOD, NATURE, HUMAN INTEREST, SPORTS"""

    print(f"   Asking {OLLAMA_MODEL} to write the digest...")
    raw = ollama_chat(prompt, SYSTEM_PROMPT)

    try:
        data = parse_json_from_response(raw)
        print(f"   Got {len(data.get('stories', []))} stories.")
        return data
    except Exception as e:
        print(f"   [!] JSON parse failed: {e}. Using mock data.")
        return _mock_data(today, hearn)


def _mock_data(today, hearn):
    return {
        "date": today,
        "hearn_quote": hearn,
        "anchor_open": "Good morning from New Orleans, where the river is wide and the coffee is strong. It's a morning that smells like rain and possibility. We're glad you're up.",
        "metcalf_poem": {
            "title": "Morning on the Bayou",
            "lines": [
                "The herons stand like questions",
                "in the shallow morning water,",
                "patient as old priests",
                "at the edge of something holy.",
                "",
                "I have watched them all my life",
                "and still don't know the answer,",
                "but I think the asking",
                "is the point.",
                "",
                "The water doesn't hurry.",
                "The heron doesn't move.",
                "And the morning,",
                "slow and certain,",
                "comes anyway."
            ]
        },
        "stories": [
            {
                "id": 1,
                "category": "NEW ORLEANS",
                "headline": "The Tremé Tuba Player Who Teaches for Free",
                "tease": "On Sundays, the music is free. It always has been.",
                "body": "Every Sunday morning, weather permitting and sometimes not, Antoine Batiste drags his tuba to the corner of St. Claude and Ursulines and plays for whoever is walking by.\n\n'Music is not a product,' he says. 'It's a conversation. You don't charge for a conversation.'\n\nHe'll be back next Sunday.",
                "kicker": "The best music in New Orleans has always been free.",
                "source_hint": "The Lens"
            }
        ],
        "closing": "That's our morning. The coffee's still warm and the day is still young. Take it easy out there. New Orleans will wait for you."
    }


# ── TTS Script ────────────────────────────────────────────────────────────────

def generate_tts_script(data):
    lines = [f"New Orleans Morning. {data['date']}.", ""]
    lines.append(f"Lafcadio Hearn once wrote: {data['hearn_quote']['text']}")
    lines += ["", data['anchor_open'], ""]
    poem = data['metcalf_poem']
    lines.append(f"This morning's poem: {poem['title']}.")
    lines.append("")
    for line in poem['lines']:
        lines.append(line if line else "")
    lines.append("")
    for story in data['stories']:
        lines += [f"{story['headline']}.", story['tease'], ""]
        for para in story['body'].split('\n\n'):
            if para.strip():
                lines.append(para.strip())
        lines += [story['kicker'], ""]
    lines.append(data['closing'])
    return "\n".join(lines)


# ── HTML Email ────────────────────────────────────────────────────────────────

def render_html_email(data):
    CATEGORY_COLORS = {
        "NEW ORLEANS":    "#C8A951",
        "LOUISIANA":      "#5B8A5A",
        "ARTS & CULTURE": "#8B6B9E",
        "MUSIC":          "#C75B3A",
        "FOOD":           "#D4884A",
        "NATURE":         "#4A7B6F",
        "HUMAN INTEREST": "#4A6B9E",
        "SPORTS":         "#1A3A6B",
    }

    poem = data['metcalf_poem']
    poem_lines_html = "".join(
        f'<span style="display:block;min-height:1em;">{ln}</span>'
        for ln in poem['lines']
    )

    stories_html = ""
    for i, story in enumerate(data['stories']):
        color  = CATEGORY_COLORS.get(story.get('category', ''), "#6B5B45")
        source = story.get('source_hint', '')
        paras  = "".join(
            f'<p style="font-family:Georgia,serif;font-size:14.5px;color:#2C2416;margin-bottom:13px;line-height:1.85;">{p}</p>'
            for p in story['body'].split('\n\n') if p.strip()
        )
        stories_html += f"""
        <div style="padding:{'40px' if i==0 else '32px'} 0;border-bottom:1px solid #E8E0D0;">
          <div style="display:inline-block;background:{color};color:#FDFAF4;font-family:Georgia,serif;
                      font-size:9px;letter-spacing:3px;text-transform:uppercase;padding:3px 10px;
                      border-radius:2px;margin-bottom:14px;">{story['category']}</div>
          <h2 style="font-family:Georgia,serif;font-size:{'28px' if i==0 else '22px'};font-weight:bold;
                     color:#1A0F00;line-height:1.25;margin:0 0 12px;">{story['headline']}</h2>
          <p style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#6B5B45;
                    margin-bottom:16px;line-height:1.65;">{story['tease']}</p>
          {paras}
          <p style="font-family:Georgia,serif;font-size:13.5px;font-style:italic;color:#8A6A3A;
                    margin-top:14px;padding-left:14px;border-left:2px solid #C8A951;line-height:1.6;">
            ❧ {story['kicker']}</p>
          {'<p style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:#AFA090;margin-top:10px;font-family:Georgia,serif;">' + source + '</p>' if source else ''}
        </div>"""

    hearn = data['hearn_quote']
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>New Orleans Morning — {data['date']}</title>
</head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:Georgia,'Times New Roman',serif;color:#2C2416;">
<div style="max-width:680px;margin:0 auto;background:#FDFAF4;box-shadow:0 4px 40px rgba(26,15,0,0.12);">

  <div style="background:radial-gradient(ellipse at 50% 0%,#3D2200 0%,#1A0F00 70%);padding:52px 40px 38px;text-align:center;">
    <div style="font-family:Georgia,serif;font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#C8A951;margin-bottom:8px;">A Morning Broadcast</div>
    <div style="font-family:Georgia,serif;font-size:38px;font-weight:bold;color:#FDFAF4;line-height:1.1;margin-bottom:6px;">New Orleans Morning</div>
    <div style="font-family:Georgia,serif;font-size:12px;color:#A89060;letter-spacing:2px;text-transform:uppercase;">{data['date']}</div>
  </div>

  <div style="background:#1A0E00;padding:22px 40px;text-align:center;border-bottom:1px solid #3A2800;">
    <p style="font-family:Georgia,serif;font-size:13px;font-style:italic;color:#A89060;margin:0;line-height:1.7;">&ldquo;{hearn['text']}&rdquo;</p>
    <p style="font-family:Georgia,serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6A5030;margin:8px 0 0;">— Lafcadio Hearn, {hearn['source']}</p>
  </div>

  <div style="background:#2C1800;padding:28px 40px;border-left:4px solid #C8A951;">
    <p style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#D4B87A;line-height:1.8;margin:0;">{data['anchor_open']}</p>
    <p style="margin-top:10px;font-size:10px;font-style:normal;letter-spacing:2px;text-transform:uppercase;color:#8A6A3A;font-family:Georgia,serif;">— New Orleans Morning</p>
  </div>

  <div style="padding:36px 40px;background:#FDFAF4;border-bottom:2px solid #E8E0D0;">
    <div style="font-family:Georgia,serif;font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#C8A951;margin-bottom:12px;">This Morning's Poem</div>
    <div style="font-family:Georgia,serif;font-size:18px;font-weight:400;font-style:italic;color:#1A0F00;margin-bottom:18px;">{poem['title']}</div>
    <div style="font-family:Georgia,serif;font-size:14px;color:#3A2C1C;line-height:1.9;border-left:2px solid #E8E0D0;padding-left:20px;">{poem_lines_html}</div>
    <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#AFA090;margin-top:16px;font-family:Georgia,serif;">In the tradition of Jim Metcalf · A Sunday Journal · WWL-TV New Orleans</div>
  </div>

  <div style="padding:0 40px;">{stories_html}</div>

  <div style="background:#1A0F00;padding:36px 40px;text-align:center;">
    <p style="font-family:Georgia,serif;font-size:15px;font-style:italic;color:#D4B87A;line-height:1.8;margin-bottom:16px;">{data['closing']}</p>
    <div style="font-family:Georgia,serif;font-size:10px;color:#6A5030;letter-spacing:3px;text-transform:uppercase;">New Orleans Morning</div>
  </div>

  <div style="padding:16px 40px;text-align:center;border-top:1px solid #E0D8C8;background:#F5F0E8;">
    <p style="font-size:10px;color:#AFA090;letter-spacing:1px;font-family:Georgia,serif;">In the tradition of A Sunday Journal &amp; CBS Sunday Morning · Powered by GILES</p>
  </div>

</div>
</body>
</html>"""


def send_email(html_content, subject, dry_run=False):
    if dry_run:
        out = "/tmp/nom_preview.html"
        with open(out, "w") as f:
            f.write(html_content)
        print(f"   [DRY RUN] Preview → {out}")
        return
    if not SENDER_EMAIL or not SENDER_PASSWORD:
        raise ValueError("Set NEWS_SENDER and NEWS_PASSWORD env vars.")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"New Orleans Morning <{SENDER_EMAIL}>"
    msg["To"]      = RECIPIENT_EMAIL
    msg.attach(MIMEText(html_content, "html"))
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.ehlo(); s.starttls()
        s.login(SENDER_EMAIL, SENDER_PASSWORD)
        s.sendmail(SENDER_EMAIL, RECIPIENT_EMAIL, msg.as_string())
    print(f"   ✓ Email sent to {RECIPIENT_EMAIL}")


def main():
    parser = argparse.ArgumentParser(description="New Orleans Morning news digest")
    parser.add_argument("--dry-run",      action="store_true")
    parser.add_argument("--preview-only", action="store_true")
    parser.add_argument("--json-only",    action="store_true")
    parser.add_argument("--json-path",    default=JSON_OUTPUT_PATH)
    args = parser.parse_args()

    print(f"\n🌅 New Orleans Morning — {datetime.now().strftime('%A, %B %d, %Y %I:%M %p')}")

    data = fetch_and_curate_stories(dry_run=args.dry_run)

    with open(args.json_path, "w") as f:
        json.dump(data, f, indent=2)
    print(f"   ✓ JSON → {args.json_path}")

    tts_path = args.json_path.replace(".json", "_tts.txt")
    with open(tts_path, "w") as f:
        f.write(generate_tts_script(data))
    print(f"   ✓ TTS script → {tts_path}")

    if args.json_only:
        print("   Done. Good morning. ☕\n")
        return

    html    = render_html_email(data)
    subject = f"🌅 New Orleans Morning — {data['date']}"

    if args.preview_only or args.dry_run:
        out = "/tmp/nom_preview.html"
        with open(out, "w") as f:
            f.write(html)
        print(f"   ✓ Preview → {out}")
    else:
        send_email(html, subject)

    print("   Done. Good morning. ☕\n")


if __name__ == "__main__":
    main()
