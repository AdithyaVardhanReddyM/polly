"""The apps Polly offers to connect, all through Composio.

The slugs are Composio toolkit slugs. `auth` says what connecting involves:

    oauth    sign in on the provider's site (Composio's managed OAuth app)
    api_key  paste a key on Composio's connect page; Polly never sees it
    none     nothing to connect; the toolkit works as it is
    custom   needs your own OAuth app, set up as an auth config in Composio

Web search is not here: it is Tavily, called directly (`research/tavily.py`),
and every agent has it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Auth = Literal["oauth", "api_key", "none", "custom"]
Category = Literal["work", "chat", "dev", "data", "social", "business"]

CATEGORIES: tuple[tuple[Category, str], ...] = (
    ("work", "Productivity"),
    ("chat", "Communication"),
    ("dev", "Developer"),
    ("data", "Analytics"),
    ("social", "Social"),
    ("business", "Sales"),
)


@dataclass(frozen=True)
class Integration:
    slug: str
    name: str
    category: Category
    description: str
    auth: Auth = "oauth"


def _i(slug: str, name: str, category: Category, description: str, auth: Auth = "oauth"):
    return Integration(slug, name, category, description, auth)


CATALOG: tuple[Integration, ...] = (
    # ---------- productivity ----------
    _i("googledocs", "Google Docs", "work", "Create, read and edit documents"),
    _i("googlesheets", "Google Sheets", "work", "Read and update spreadsheets"),
    _i("googleslides", "Google Slides", "work", "Build and edit presentations"),
    _i("googledrive", "Google Drive", "work", "Find, read and organise files"),
    _i("googlecalendar", "Google Calendar", "work", "Events, availability and scheduling"),
    _i("googletasks", "Google Tasks", "work", "Task lists and to-dos"),
    _i("notion", "Notion", "work", "Pages, databases and comments"),
    _i("linear", "Linear", "work", "Issues, projects and cycles"),
    _i("jira", "Jira", "work", "Issues, sprints and boards"),
    _i("confluence", "Confluence", "work", "Spaces and pages"),
    _i("asana", "Asana", "work", "Tasks, projects and teams"),
    _i("trello", "Trello", "work", "Boards, lists and cards"),
    _i("clickup", "ClickUp", "work", "Tasks, docs and goals"),
    _i("airtable", "Airtable", "work", "Bases, tables and records"),
    _i("todoist", "Todoist", "work", "Tasks and projects"),
    _i("dropbox", "Dropbox", "work", "Files and folders"),
    _i("google_maps", "Google Maps", "work", "Places, routes and distances"),
    # ---------- communication ----------
    _i("gmail", "Gmail", "chat", "Read, search, draft and send email"),
    _i("slack", "Slack", "chat", "Channels, threads and messages"),
    _i("googlemeet", "Google Meet", "chat", "Create meetings and fetch recordings"),
    _i("discord", "Discord", "chat", "Servers, channels and messages"),
    _i("microsoft_teams", "Microsoft Teams", "chat", "Chats, channels and meetings"),
    _i("outlook", "Outlook", "chat", "Email and calendar on Microsoft 365"),
    _i("zoom", "Zoom", "chat", "Meetings and recordings"),
    _i("calendly", "Calendly", "chat", "Booking links and scheduled events"),
    # ---------- developer ----------
    _i("github", "GitHub", "dev", "Repositories, pull requests and issues"),
    _i("gitlab", "GitLab", "dev", "Projects, merge requests and pipelines"),
    _i("sentry", "Sentry", "dev", "Errors, issues and releases"),
    _i("vercel", "Vercel", "dev", "Deployments, projects and domains", "api_key"),
    _i("supabase", "Supabase", "dev", "Projects, databases and functions"),
    _i("neon", "Neon", "dev", "Serverless Postgres projects and branches", "api_key"),
    _i("cloudflare", "Cloudflare", "dev", "Zones, DNS and workers", "api_key"),
    _i("figma", "Figma", "dev", "Files, frames and comments"),
    # ---------- analytics ----------
    _i("posthog", "PostHog", "data", "Product analytics, flags and insights", "api_key"),
    _i("google_analytics", "Google Analytics", "data", "Reports on traffic and audiences"),
    _i("datadog", "Datadog", "data", "Metrics, monitors and logs", "api_key"),
    _i("amplitude", "Amplitude", "data", "Events, cohorts and charts", "api_key"),
    # ---------- social ----------
    _i("twitter", "X (Twitter)", "social", "Posts, timelines and search", "custom"),
    _i("linkedin", "LinkedIn", "social", "Share posts and read your profile"),
    _i("youtube", "YouTube", "social", "Search videos, channels and playlists"),
    _i("reddit", "Reddit", "social", "Subreddits, posts and comments"),
    _i("hackernews", "Hacker News", "social", "Front page, stories and comments", "none"),
    # ---------- sales ----------
    _i("stripe", "Stripe", "business", "Customers, payments and subscriptions"),
    _i("hubspot", "HubSpot", "business", "Contacts, companies and deals"),
    _i("salesforce", "Salesforce", "business", "Accounts, leads and opportunities"),
    _i("apollo", "Apollo", "business", "Find and enrich people and companies", "api_key"),
    _i("intercom", "Intercom", "business", "Conversations and contacts"),
)

SLUGS = frozenset(i.slug for i in CATALOG)


def get(slug: str) -> Integration | None:
    return next((i for i in CATALOG if i.slug == slug), None)
