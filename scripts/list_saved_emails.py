#!/usr/bin/env python3
"""
List Saved Emails — Retrieves a list of emails sent to kevinmkolb+save@gmail.com
Uses standard IMAP to read from Gmail.
"""

import os
import sys
import imaplib
import email
from email.header import decode_header

# ── Load .env ─────────────────────────────────────────────────────────────────
env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                if k not in os.environ:
                    os.environ[k.strip()] = v.strip().strip('"\'')

# ── Configuration ─────────────────────────────────────────────────────────────
# Falls back to standard naming if NEWS_ vars aren't what you use for incoming
EMAIL_ACCOUNT = os.environ.get("NEWS_SENDER") or os.environ.get("GMAIL_USER")
EMAIL_PASS    = os.environ.get("NEWS_PASSWORD") or os.environ.get("GMAIL_APP_PASSWORD")
IMAP_SERVER   = "imap.gmail.com"
TARGET_EMAIL  = "kevinmkolb+save@gmail.com"

# Strip spaces from password (Google often copies them as "abcd efgh ijkl mnop")
if EMAIL_PASS:
    EMAIL_PASS = EMAIL_PASS.replace(" ", "")
# ──────────────────────────────────────────────────────────────────────────────

def clean_header(header_val):
    """Decodes email header text into a readable unicode string."""
    if not header_val:
        return ""
    decoded_fragments = decode_header(header_val)
    header_str = ""
    for frag, enc in decoded_fragments:
        if isinstance(frag, bytes):
            header_str += frag.decode(enc or "utf-8", errors="ignore")
        else:
            header_str += frag
    return header_str

def main():
    if not EMAIL_ACCOUNT or not EMAIL_PASS:
        print("Error: Missing credentials. Please set NEWS_SENDER and NEWS_PASSWORD in your .env file.")
        sys.exit(1)

    pass_len = len(EMAIL_PASS) if EMAIL_PASS else 0
    print(f"Connecting to {IMAP_SERVER} as {EMAIL_ACCOUNT} (Password length: {pass_len})...")
    try:
        mail = imaplib.IMAP4_SSL(IMAP_SERVER)
        mail.login(EMAIL_ACCOUNT, EMAIL_PASS)
    except Exception as e:
        print(f"Failed to connect or login: {e}")
        sys.exit(1)

    mail.select("INBOX")
    print(f"Searching for emails sent to {TARGET_EMAIL}...\n")
    
    status, messages = mail.search(None, f'(TO "{TARGET_EMAIL}")')
    
    if status != "OK":
        print("No messages found.")
        return

    msg_nums = messages[0].split()
    print(f"Found {len(msg_nums)} saved email(s):\n")

    for num in msg_nums:
        res, msg_data = mail.fetch(num, "(RFC822)")
        if res == "OK":
            for response_part in msg_data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    subject = clean_header(msg.get("Subject"))
                    date = clean_header(msg.get("Date"))
                    sender = clean_header(msg.get("From"))
                    
                    print(f"Date:    {date}")
                    print(f"From:    {sender}")
                    print(f"Subject: {subject}")
                    print("-" * 60)

    mail.close()
    mail.logout()

if __name__ == "__main__":
    main()