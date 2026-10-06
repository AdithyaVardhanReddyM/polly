"""Lenses: what kind of work an app is for, and the actions that fit it.

Picked from the bundle id, the page URL and the window title, with no model
call, so the notch can show sensible chips the moment the user switches
apps. The brain then refines the chips from what is actually on screen.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlparse

from polly_server.copilot.context import Snapshot


@dataclass(frozen=True)
class Chip:
    id: str
    label: str
    agentic: bool = False

    def dump(self) -> dict:
        return {"id": self.id, "label": self.label, "agentic": self.agentic}


@dataclass(frozen=True)
class Lens:
    id: str
    # How the brain should help in this kind of app.
    guidance: str
    chips: tuple[Chip, ...] = field(default_factory=tuple)


LENSES: dict[str, Lens] = {
    lens.id: lens
    for lens in (
        Lens(
            "email",
            "Email. Help read threads fast and write replies in the user's voice. When the "
            "user is writing a reply, a draft or a completion of what they started is the "
            "most useful hint.",
            (
                Chip("summarize_thread", "Summarize thread"),
                Chip("draft_reply", "Draft reply", agentic=True),
                Chip("action_items", "Find action items"),
            ),
        ),
        Lens(
            "spreadsheet",
            "Spreadsheet. Help with formulas (exact syntax for this app, real cell "
            "references from the visible grid), errors, and what the numbers say.",
            (
                Chip("analyze_selected", "Analyze selected"),
                Chip("solve_errors", "Solve errors"),
                Chip("describe_improve", "Describe and improve"),
                Chip("write_formula", "Write a formula", agentic=True),
            ),
        ),
        Lens(
            "pdf",
            "A PDF or form. Help understand it, and fill or clear its form fields from what "
            "Polly knows about the user.",
            (
                Chip("summarize", "Summarize"),
                Chip("fill_form", "Fill form", agentic=True),
                Chip("clear_form", "Clear form"),
            ),
        ),
        Lens(
            "chat",
            "Team chat. Catch requests and commitments aimed at the user (to-dos), "
            "summarize busy conversations, and draft replies.",
            (
                Chip("summarize_chat", "Summarize conversation"),
                Chip("draft_reply", "Draft reply", agentic=True),
                Chip("find_todos", "Find my to-dos"),
            ),
        ),
        Lens(
            "document",
            "Writing a document. Help improve, continue or proofread the user's writing.",
            (
                Chip("summarize", "Summarize"),
                Chip("improve_writing", "Improve writing", agentic=True),
                Chip("proofread", "Proofread", agentic=True),
            ),
        ),
        Lens(
            "code",
            "Code or a terminal. Explain what is on screen, spot bugs and errors, suggest fixes.",
            (
                Chip("explain", "Explain this"),
                Chip("find_bugs", "Find bugs"),
                Chip("fix_error", "Fix the error", agentic=True),
            ),
        ),
        Lens(
            "browser",
            "A web page. Help the user get what they came for: summaries, key points, "
            "answers about the page.",
            (
                Chip("summarize_page", "Summarize page"),
                Chip("key_points", "Key points"),
                Chip("explain", "Explain this"),
            ),
        ),
        Lens(
            "generic",
            "Help with whatever the user is doing in this app.",
            (
                Chip("explain_screen", "Explain this"),
                Chip("summarize", "Summarize"),
            ),
        ),
    )
}

_BY_BUNDLE: dict[str, str] = {
    # email
    "com.apple.mail": "email",
    "com.microsoft.Outlook": "email",
    "com.readdle.smartemail-Mac": "email",
    "com.superhuman.electron": "email",
    "com.mimestream.Mimestream": "email",
    # spreadsheets
    "com.microsoft.Excel": "spreadsheet",
    "com.apple.iWork.Numbers": "spreadsheet",
    # PDFs
    "com.adobe.Acrobat.Pro": "pdf",
    "com.adobe.Reader": "pdf",
    "net.sourceforge.skim-app.skim": "pdf",
    # chat
    "com.tinyspeck.slackmacgap": "chat",
    "com.hnc.Discord": "chat",
    "com.microsoft.teams2": "chat",
    "com.microsoft.teams": "chat",
    "com.apple.MobileSMS": "chat",
    "net.whatsapp.WhatsApp": "chat",
    "ru.keepcoder.Telegram": "chat",
    "org.telegram.desktop": "chat",
    "com.linear": "chat",
    # documents
    "com.microsoft.Word": "document",
    "com.apple.iWork.Pages": "document",
    "com.apple.Notes": "document",
    "com.apple.TextEdit": "document",
    "md.obsidian": "document",
    "notion.id": "document",
    "com.craft.craft": "document",
    "net.shinyfrog.bear": "document",
    # code
    "com.microsoft.VSCode": "code",
    "com.todesktop.230313mzl4w4u92": "code",
    "com.apple.dt.Xcode": "code",
    "dev.zed.Zed": "code",
    "com.apple.Terminal": "code",
    "com.googlecode.iterm2": "code",
    "dev.warp.Warp-Stable": "code",
    "com.mitchellh.ghostty": "code",
}

_BY_HOST: tuple[tuple[str, str, str], ...] = (
    # (host suffix, path prefix, lens)
    ("mail.google.com", "", "email"),
    ("outlook.live.com", "", "email"),
    ("outlook.office.com", "", "email"),
    ("outlook.office365.com", "", "email"),
    ("app.superhuman.com", "", "email"),
    ("mail.proton.me", "", "email"),
    ("mail.yahoo.com", "", "email"),
    ("docs.google.com", "/spreadsheets", "spreadsheet"),
    ("docs.google.com", "/document", "document"),
    ("app.slack.com", "", "chat"),
    ("discord.com", "/channels", "chat"),
    ("teams.microsoft.com", "", "chat"),
    ("web.whatsapp.com", "", "chat"),
    ("web.telegram.org", "", "chat"),
    ("notion.so", "", "document"),
    ("github.com", "", "code"),
)

BROWSERS = {
    "com.google.Chrome",
    "com.google.Chrome.canary",
    "com.apple.Safari",
    "company.thebrowser.Browser",
    "com.brave.Browser",
    "com.microsoft.edgemac",
    "org.mozilla.firefox",
    "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera",
    "app.zen-browser.zen",
}


def detect(snapshot: Snapshot) -> Lens:
    bundle = snapshot.app.bundleId
    title = snapshot.window.title.casefold()
    url = (snapshot.url or "").casefold()

    if url:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        for suffix, path, lens in _BY_HOST:
            if (host == suffix or host.endswith("." + suffix)) and parsed.path.startswith(path):
                return LENSES[lens]
        if parsed.path.endswith(".pdf"):
            return LENSES["pdf"]

    if bundle in _BY_BUNDLE:
        return LENSES[_BY_BUNDLE[bundle]]
    if bundle == "com.apple.Preview" and (
        title.endswith(".pdf") or (snapshot.document or "").casefold().endswith(".pdf")
    ):
        return LENSES["pdf"]
    if bundle.startswith("com.jetbrains."):
        return LENSES["code"]
    if bundle in BROWSERS:
        return LENSES["browser"]
    return LENSES["generic"]


def label(snapshot: Snapshot) -> str:
    """ "Gmail · Meeting with Maria": the site or app, then what the window is about."""
    app = snapshot.app.name or "This app"
    title = snapshot.window.title.strip()
    host = snapshot.host.removeprefix("www.")
    if host:
        site = {
            "mail.google.com": "Gmail",
            "docs.google.com": "Google Docs",
            "app.slack.com": "Slack",
            "discord.com": "Discord",
            "outlook.live.com": "Outlook",
            "outlook.office.com": "Outlook",
            "notion.so": "Notion",
            "github.com": "GitHub",
        }.get(host, host)
        # Browsers end titles with the site or browser name; keep the first part.
        for sep in (" - ", " — ", " | ", " · "):
            if sep in title:
                title = title.split(sep)[0]
                break
        return f"{site} · {title}" if title and title.casefold() != site.casefold() else site
    if title and title.casefold() != app.casefold():
        return f"{app} · {title}"
    return app


def chip_label(chip_id: str) -> str | None:
    for lens in LENSES.values():
        for chip in lens.chips:
            if chip.id == chip_id:
                return chip.label
    return None
