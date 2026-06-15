#!/usr/bin/env python3
"""
Company Hub — Interact with every role and position in the company.

Usage:
    python3 company.py                    # Launch interactive company hub
    python3 company.py --list             # Show company directory only
    ANTHROPIC_API_KEY=sk-... python3 company.py
"""

import os
import re
import sys
from pathlib import Path

# ── Department display order ───────────────────────────────────────────────────
DEPARTMENTS = [
    ("leadership",         "👑  Leadership"),
    ("engineering",        "🔧  Engineering"),
    ("design",             "🎨  Design"),
    ("marketing",          "📢  Marketing"),
    ("product",            "📦  Product"),
    ("project-management", "📋  Project Management"),
    ("studio-operations",  "🏢  Studio Operations"),
    ("testing",            "🧪  Testing"),
    ("bonus",              "⭐  Bonus"),
]

# ── Parsing ────────────────────────────────────────────────────────────────────

def parse_agent(path: Path) -> dict | None:
    """
    Extract name, one-liner description, and system prompt from an agent .md file.
    Supports two file formats:
      1. YAML frontmatter  (--- … --- body)
      2. Markdown headings (# Name / ## Description / ## System Prompt)
    """
    text = path.read_text()

    # ── Format 1: YAML frontmatter ─────────────────────────────────────────────
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            yaml_block = parts[1]
            system_prompt = parts[2].strip()

            m = re.search(r"^name:\s*(.+)$", yaml_block, re.MULTILINE)
            name = m.group(1).strip() if m else path.stem

            m = re.search(r"^description:\s*(.+)", yaml_block, re.MULTILINE | re.DOTALL)
            if m:
                raw = m.group(1).strip()
                first_line = raw.split("\\n")[0].strip().strip('"').strip("'")
                first_line = re.sub(r"^Use this agent when\s+", "", first_line, flags=re.IGNORECASE)
                tagline = first_line[:60].rstrip(", ") + ("…" if len(first_line) > 60 else "")
            else:
                tagline = ""

            return {"name": name, "tagline": tagline, "system_prompt": system_prompt}

    # ── Format 2: Markdown headings ────────────────────────────────────────────
    # Name comes from the first H1
    name_m = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
    name = name_m.group(1).strip() if name_m else path.stem
    # Convert "Content Creator" → "content-creator"
    name_slug = name.lower().replace(" ", "-")

    # Description: text under "## Description" up to the next "##"
    desc_m = re.search(r"^##\s+Description\s*\n(.*?)(?=^##|\Z)", text, re.MULTILINE | re.DOTALL)
    if desc_m:
        desc_text = desc_m.group(1).strip()
        first_sent = re.split(r"[.\n]", desc_text)[0].strip()
        tagline = first_sent[:60].rstrip(", ") + ("…" if len(first_sent) > 60 else "")
    else:
        tagline = ""

    # System prompt: text under "## System Prompt" to end of file
    sys_m = re.search(r"^##\s+System Prompt\s*\n(.*)", text, re.MULTILINE | re.DOTALL)
    system_prompt = sys_m.group(1).strip() if sys_m else text.strip()

    return {"name": name_slug, "tagline": tagline, "system_prompt": system_prompt}


def load_company(base: Path) -> list[tuple[str, list[dict]]]:
    """Return [(dept_label, [agent, …]), …] in display order."""
    company = []
    for dir_name, label in DEPARTMENTS:
        dept_path = base / dir_name
        if not dept_path.exists():
            continue
        agents = []
        for md in sorted(dept_path.glob("*.md")):
            agent = parse_agent(md)
            if agent:
                agents.append(agent)
        if agents:
            company.append((label, agents))
    return company


# ── Display ────────────────────────────────────────────────────────────────────

BAR = "─" * 70

def display_directory(company: list) -> list[dict]:
    """Print the org-chart table and return the flat ordered list of agents."""
    print(f"\n{'═' * 70}")
    print("                      🏢  COMPANY HUB")
    print("          Talk to any of the 38 specialist positions")
    print(f"{'═' * 70}")

    all_agents: list[dict] = []
    n = 1
    for dept_label, agents in company:
        print(f"\n  {dept_label}")
        print(f"  {BAR}")
        for agent in agents:
            role = agent["name"].replace("-", " ").title()
            tag  = agent["tagline"]
            row  = f"  [{n:2d}]  {role:<28}  {tag}"
            print(row[:70])
            all_agents.append(agent)
            n += 1

    print(f"\n{'═' * 70}")
    return all_agents


# ── API key ────────────────────────────────────────────────────────────────────

def get_api_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    print("\n  ⚠  ANTHROPIC_API_KEY not found in environment.")
    print("     You can set it with:  export ANTHROPIC_API_KEY=sk-...")
    try:
        key = input("\n  Paste your API key (or press Enter to quit): ").strip()
    except (KeyboardInterrupt, EOFError):
        key = ""
    return key or None


# ── Chat ───────────────────────────────────────────────────────────────────────

def chat_with_role(agent: dict, client) -> str:
    """
    Interactive conversation with the selected role.
    Returns "switch" to go back to the directory, or "quit" to exit.
    """
    import anthropic

    role = agent["name"].replace("-", " ").title()
    history: list[dict] = []

    print(f"\n{'═' * 70}")
    print(f"  Now talking to:  {role}")
    print(f"{'─' * 70}")
    print("  Commands:  switch · clear · quit")
    print(f"{'═' * 70}\n")

    while True:
        # Prompt
        try:
            raw = input(f"  You         → ").strip()
        except (KeyboardInterrupt, EOFError):
            print()
            return "quit"

        if not raw:
            continue

        cmd = raw.lower()
        if cmd == "quit":
            return "quit"
        if cmd == "switch":
            return "switch"
        if cmd == "clear":
            history = []
            print(f"\n  [Conversation with {role} cleared.]\n")
            continue

        history.append({"role": "user", "content": raw})

        # Streaming response
        print(f"\n  {role:<12} → ", end="", flush=True)
        full = ""
        try:
            with client.messages.stream(
                model="claude-opus-4-8",
                max_tokens=1024,
                system=agent["system_prompt"],
                messages=history,
            ) as stream:
                for chunk in stream.text_stream:
                    # Indent continuation lines to align with the first line
                    chunk_out = chunk.replace("\n", "\n" + " " * 17)
                    print(chunk_out, end="", flush=True)
                    full += chunk
        except anthropic.AuthenticationError:
            print("\n\n  ❌  Invalid API key. Please check ANTHROPIC_API_KEY.\n")
            return "quit"
        except Exception as exc:
            print(f"\n\n  ❌  Error: {exc}\n")
            history.pop()
            continue

        print("\n")
        history.append({"role": "assistant", "content": full})


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    base = Path(__file__).parent
    list_only = "--list" in sys.argv

    company = load_company(base)
    if not company:
        print("  Error: No agent .md files found. Run from the repo root.")
        sys.exit(1)

    if list_only:
        display_directory(company)
        print()
        return

    # Need the API client only for interactive mode
    try:
        import anthropic
    except ImportError:
        print("  Error: anthropic package not installed.")
        print("         Run:  pip install anthropic")
        sys.exit(1)

    api_key = get_api_key()
    if not api_key:
        print("\n  Exiting — no API key provided.\n")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    while True:
        all_agents = display_directory(company)
        total = len(all_agents)

        print(f"\n  Select a position [1–{total}]  or  'q' to quit: ", end="")
        try:
            choice = input().strip()
        except (KeyboardInterrupt, EOFError):
            print("\n\n  Goodbye! 👋\n")
            break

        if choice.lower() in ("q", "quit", "exit"):
            print("\n  Goodbye! 👋\n")
            break

        try:
            idx = int(choice) - 1
        except ValueError:
            print(f"  Enter a number 1–{total} or 'q'.")
            continue

        if not (0 <= idx < total):
            print(f"  Enter a number 1–{total} or 'q'.")
            continue

        result = chat_with_role(all_agents[idx], client)
        if result == "quit":
            print("\n  Goodbye! 👋\n")
            break
        # "switch" → loop back to directory


if __name__ == "__main__":
    main()
