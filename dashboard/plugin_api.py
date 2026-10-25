"""PR Studio backend: GitHub pull-request data and review actions via the user's gh CLI.

Mounted at /api/plugins/hermes-pr-studio/. Every GitHub call shells out to the
logged-in `gh` binary with an argument list (never a shell string). The plugin
never reads gh's token or any credential file; gh attaches auth itself.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import time
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

GH_TIMEOUT = 30
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PATCH_CHARS = 200_000
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
REVIEW_EVENTS = {"APPROVE", "REQUEST_CHANGES", "COMMENT"}
SIDES = {"LEFT", "RIGHT"}

# --------------------------------------------------------------------------- gh


def gh_path() -> str | None:
    found = shutil.which("gh")
    if found:
        return found
    for cand in ("~/.local/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"):
        p = Path(os.path.expanduser(cand))
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


def run_gh(args: list[str], stdin: bytes | None = None, timeout: int = GH_TIMEOUT) -> bytes:
    exe = gh_path()
    if not exe:
        raise HTTPException(503, "GitHub CLI (gh) is not installed or not on PATH")
    env = {**os.environ, "GH_PROMPT_DISABLED": "1", "GH_PAGER": "cat", "NO_COLOR": "1", "GH_NO_UPDATE_NOTIFIER": "1"}
    try:
        done = subprocess.run(
            [exe, *args], input=stdin, capture_output=True, timeout=timeout, env=env,
            stdin=None if stdin is not None else subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, "gh timed out") from exc
    if done.returncode != 0:
        msg = (done.stderr or done.stdout).decode("utf-8", "replace").strip()[-600:]
        status = 401 if "auth login" in msg or "authentication" in msg.lower() else 502
        raise HTTPException(status, msg or f"gh exited {done.returncode}")
    return done.stdout


def gh_json(args: list[str], stdin: bytes | None = None) -> Any:
    out = run_gh(args, stdin=stdin)
    try:
        return json.loads(out or b"null")
    except json.JSONDecodeError as exc:
        raise HTTPException(502, "gh returned invalid JSON") from exc


def graphql(query: str, variables: dict[str, Any]) -> dict:
    payload = json.dumps({"query": query, "variables": variables}).encode()
    data = gh_json(["api", "graphql", "--input", "-"], stdin=payload)
    if data.get("errors"):
        raise HTTPException(502, "; ".join(e.get("message", "?") for e in data["errors"])[:600])
    return data.get("data") or {}


def rest(method: str, path: str, body: dict | None = None) -> Any:
    args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    stdin = None
    if body is not None:
        args += ["--input", "-"]
        stdin = json.dumps(body).encode()
    return gh_json(args, stdin=stdin)


def check_repo(repo: str) -> tuple[str, str]:
    repo = (repo or "").strip()
    if not REPO_RE.match(repo) or ".." in repo:
        raise HTTPException(400, "repo must look like owner/name")
    owner, name = repo.split("/", 1)
    return owner, name


def check_number(number: int) -> int:
    if not isinstance(number, int) or number < 1 or number > 10_000_000:
        raise HTTPException(400, "invalid PR number")
    return number


# --------------------------------------------------------------------- sanitizer

ALLOWED_TAGS = {
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "code",
    "pre", "blockquote", "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td",
    "details", "summary", "span", "div", "input", "kbd", "sup", "sub", "g-emoji", "picture", "source",
}
VOID_TAGS = {"br", "hr", "img", "input", "source"}
DROP_WITH_CONTENT = {"script", "style", "iframe", "object", "embed", "template", "svg", "math", "noscript", "form", "textarea", "select", "button"}
GH_IMAGE_RE = re.compile(r"^https://(github\.com/[^/]+/[^/]+/(blob|raw)/|raw\.githubusercontent\.com/)")


def safe_url(url: str | None, schemes: tuple[str, ...] = ("https", "http", "mailto")) -> str | None:
    if not url:
        return None
    url = url.strip()
    scheme = urlparse(url).scheme.lower()
    if scheme not in schemes:
        return None
    return url


class _Sanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.drop_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in DROP_WITH_CONTENT:
            if tag not in VOID_TAGS:
                self.drop_depth += 1
            return
        if self.drop_depth or tag not in ALLOWED_TAGS:
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        kept: list[tuple[str, str]] = []
        if tag == "a":
            href = safe_url(a.get("href"))
            if href:
                kept += [("href", href), ("target", "_blank"), ("rel", "noreferrer noopener")]
        elif tag == "img":
            src = safe_url(a.get("src"), ("https",))
            if not src:
                return
            if GH_IMAGE_RE.match(src):
                kept.append(("data-gh-src", src))  # private-capable: frontend loads via /image
            else:
                kept.append(("src", src))
            for k in ("alt", "width", "height", "title"):
                if a.get(k):
                    kept.append((k, a[k][:200]))
            kept.append(("loading", "lazy"))
        elif tag == "source":
            return  # <picture> falls back to its <img>
        elif tag == "input":
            if a.get("type") != "checkbox":
                return
            kept += [("type", "checkbox"), ("disabled", "")]
            if "checked" in a:
                kept.append(("checked", ""))
        elif tag in ("td", "th") and a.get("align") in ("left", "right", "center"):
            kept.append(("align", a["align"]))
        elif tag == "details" and "open" in a:
            kept.append(("open", ""))
        attr_s = "".join(f' {k}="{escape(v, quote=True)}"' if v else f" {k}" for k, v in kept)
        self.out.append(f"<{tag}{attr_s}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS and self.stack and self.stack[-1] == tag.lower():
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in DROP_WITH_CONTENT:
            self.drop_depth = max(0, self.drop_depth - 1)
            return
        if self.drop_depth or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                t = self.stack.pop()
                self.out.append(f"</{t}>")
                if t == tag:
                    break

    def handle_data(self, data: str) -> None:
        if not self.drop_depth:
            self.out.append(escape(data, quote=False))

    def result(self) -> str:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_html(html: str | None) -> str:
    if not html:
        return ""
    s = _Sanitizer()
    s.feed(html)
    s.close()
    return s.result()


# ------------------------------------------------------------------- endpoints

_cache: dict[str, tuple[float, Any]] = {}


def cached(key: str, ttl: float, fn):
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    val = fn()
    _cache[key] = (time.monotonic(), val)
    return val


@router.get("/status")
def status():
    exe = gh_path()
    if not exe:
        return {"gh": False, "login": None, "error": "GitHub CLI (gh) is not installed"}
    try:
        login = cached("login", 300, lambda: run_gh(["api", "user", "--jq", ".login"]).decode().strip())
        return {"gh": True, "login": login, "error": None}
    except HTTPException as exc:
        return {"gh": True, "login": None, "error": exc.detail}


def parse_remote(url: str) -> str | None:
    url = url.strip()
    m = re.match(r"^(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$", url)
    return m.group(1) if m and REPO_RE.match(m.group(1)) else None


@router.get("/repo-from-cwd")
def repo_from_cwd(cwd: str = Query("")):
    p = Path(os.path.expanduser(cwd or "")).resolve() if cwd else None
    if not p or not p.is_dir():
        return {"repo": None}
    git = shutil.which("git")
    if not git:
        return {"repo": None}
    try:
        done = subprocess.run([git, "-C", str(p), "remote", "get-url", "origin"], capture_output=True, timeout=5,
                              stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return {"repo": None}
    if done.returncode != 0:
        return {"repo": None}
    return {"repo": parse_remote(done.stdout.decode("utf-8", "replace"))}


@router.get("/repos")
def repos():
    def load():
        out: list[str] = []
        mine = gh_json(["repo", "list", "--limit", "60", "--json", "nameWithOwner"])
        out += [r["nameWithOwner"] for r in mine or []]
        try:
            orgs = gh_json(["api", "user/orgs", "--jq", "[.[].login]"]) or []
        except HTTPException:
            orgs = []
        for org in orgs[:10]:
            try:
                rs = gh_json(["repo", "list", org, "--limit", "40", "--json", "nameWithOwner"])
                out += [r["nameWithOwner"] for r in rs or []]
            except HTTPException:
                continue
        return sorted(set(out), key=str.lower)

    return {"repos": cached("repos", 300, load)}


PR_LIST_Q = """
query($owner:String!,$name:String!,$states:[PullRequestState!]){
  repository(owner:$owner,name:$name){
    pullRequests(first:40,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{ number title isDraft state updatedAt additions deletions headRefName baseRefName reviewDecision url
        author{login avatarUrl}
        comments{totalCount}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}} }
    }
  }
}"""


def _rollup(pr: dict) -> str | None:
    nodes = ((pr.get("commits") or {}).get("nodes") or [])
    roll = (nodes[0].get("commit") or {}).get("statusCheckRollup") if nodes else None
    return (roll or {}).get("state")


@router.get("/pulls")
def pulls(repo: str, state: str = "OPEN"):
    owner, name = check_repo(repo)
    states = {"OPEN": ["OPEN"], "CLOSED": ["CLOSED"], "MERGED": ["MERGED"], "ALL": ["OPEN", "CLOSED", "MERGED"]}.get(state.upper())
    if not states:
        raise HTTPException(400, "state must be OPEN, CLOSED, MERGED or ALL")
    data = graphql(PR_LIST_Q, {"owner": owner, "name": name, "states": states})
    repo_node = data.get("repository")
    if not repo_node:
        raise HTTPException(404, f"repository {repo} not found or not accessible")
    items = []
    for pr in repo_node["pullRequests"]["nodes"]:
        pr["checks"] = _rollup(pr)
        pr["commentCount"] = pr.pop("comments", {}).get("totalCount", 0)
        pr.pop("commits", None)
        items.append(pr)
    return {"pulls": items}


PR_FIELDS = """number title isDraft state updatedAt additions deletions headRefName baseRefName reviewDecision url
        author{login avatarUrl}
        repository{nameWithOwner}
        comments{totalCount}
        commits(last:1){nodes{commit{statusCheckRollup{state}}}}"""

# Three searches in one round trip, grouped the way a review queue reads:
# what waits on you, what you opened, and everything else you're part of.
INBOX_GROUPS = (
    ("review", "Needs your review", "review-requested:@me"),
    ("mine", "Your pull requests", "author:@me"),
    ("involved", "Involves you", "involves:@me"),
)
INBOX_Q = "query{" + "".join(
    f'{key}:search(query:"is:pr is:open archived:false {filt} sort:updated-desc",type:ISSUE,first:40)'
    f"{{nodes{{... on PullRequest{{ {PR_FIELDS} }}}}}}"
    for key, _, filt in INBOX_GROUPS
) + "}"


def _flatten_pr(pr: dict) -> dict:
    pr["checks"] = _rollup(pr)
    pr["commentCount"] = (pr.pop("comments", None) or {}).get("totalCount", 0)
    pr["repo"] = (pr.pop("repository", None) or {}).get("nameWithOwner")
    pr.pop("commits", None)
    return pr


def build_inbox(data: dict) -> list[dict]:
    """Group search results; a PR appears only in the first group that holds it."""
    seen: set[tuple[str, int]] = set()
    groups = []
    for key, label, _ in INBOX_GROUPS:
        items = []
        for pr in ((data.get(key) or {}).get("nodes") or []):
            if not pr or "number" not in pr:
                continue
            pr = _flatten_pr(pr)
            ident = (pr["repo"], pr["number"])
            if ident in seen:
                continue
            seen.add(ident)
            items.append(pr)
        groups.append({"id": key, "label": label, "pulls": items})
    return groups


@router.get("/inbox")
def inbox():
    return {"groups": cached("inbox", 20, lambda: build_inbox(graphql(INBOX_Q, {})))}


PR_Q = """
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number title url state isDraft createdAt updatedAt bodyHTML body
      additions deletions changedFiles headRefName baseRefName headRefOid reviewDecision mergeable
      author{login avatarUrl}
      comments(first:100){nodes{ id databaseId bodyHTML body createdAt url author{login avatarUrl} }}
      reviews(first:60){nodes{ id databaseId state bodyHTML body submittedAt url author{login avatarUrl} }}
      commits(last:100){nodes{commit{ oid abbreviatedOid messageHeadline committedDate url
        author{name user{login avatarUrl}} statusCheckRollup{state} }}}
      statusCheckRollup: commits(last:1){nodes{commit{statusCheckRollup{ state
        contexts(first:60){nodes{
          __typename
          ... on CheckRun{ name status conclusion detailsUrl startedAt completedAt }
          ... on StatusContext{ context state targetUrl description }
        }} }}}}
    }
  }
}"""


@router.get("/pull")
def pull(repo: str, number: int):
    owner, name = check_repo(repo)
    check_number(number)
    data = graphql(PR_Q, {"owner": owner, "name": name, "number": number})
    pr = (data.get("repository") or {}).get("pullRequest")
    if not pr:
        raise HTTPException(404, f"PR #{number} not found in {repo}")
    pr["bodyHTML"] = sanitize_html(pr.get("bodyHTML"))
    comments = pr.pop("comments")["nodes"]
    reviews = pr.pop("reviews")["nodes"]
    for c in comments + reviews:
        c["bodyHTML"] = sanitize_html(c.get("bodyHTML"))
    timeline = [{"kind": "comment", "at": c["createdAt"], **c} for c in comments]
    timeline += [{"kind": "review", "at": r.get("submittedAt") or "", **r} for r in reviews
                 if r.get("body") or r.get("state") in ("APPROVED", "CHANGES_REQUESTED")]
    timeline.sort(key=lambda x: x["at"] or "")
    pr["timeline"] = timeline
    pr["commits"] = [n["commit"] for n in pr["commits"]["nodes"]]
    roll_nodes = pr.pop("statusCheckRollup")["nodes"]
    roll = (roll_nodes[0]["commit"].get("statusCheckRollup") if roll_nodes else None) or {}
    checks = []
    for c in (roll.get("contexts") or {}).get("nodes") or []:
        if c.get("__typename") == "CheckRun":
            checks.append({"name": c["name"], "state": (c.get("conclusion") or c.get("status") or "").upper(),
                           "url": c.get("detailsUrl")})
        else:
            checks.append({"name": c.get("context"), "state": (c.get("state") or "").upper(),
                           "url": c.get("targetUrl"), "description": c.get("description")})
    pr["checks"] = {"state": roll.get("state"), "items": checks}
    return pr


@router.get("/files")
def files(repo: str, number: int):
    owner, name = check_repo(repo)
    check_number(number)
    out = []
    budget = MAX_PATCH_CHARS
    for page in (1, 2, 3):
        rows = rest("GET", f"repos/{owner}/{name}/pulls/{number}/files?per_page=100&page={page}") or []
        for f in rows:
            patch = f.get("patch")
            truncated = False
            if patch and len(patch) > budget:
                patch, truncated = None, True
            elif patch:
                budget -= len(patch)
            out.append({"filename": f["filename"], "status": f["status"], "additions": f["additions"],
                        "deletions": f["deletions"], "previous_filename": f.get("previous_filename"),
                        "patch": patch, "truncated": truncated or (f.get("patch") is None and f["changes"] > 0)})
        if len(rows) < 100:
            break
    return {"files": out}


THREADS_Q = """
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100){nodes{ id isResolved isOutdated path line originalLine startLine diffSide
      comments(first:50){nodes{ id databaseId body bodyHTML createdAt url diffHunk author{login avatarUrl} }} }}
  }}
}"""


@router.get("/threads")
def threads(repo: str, number: int):
    owner, name = check_repo(repo)
    check_number(number)
    data = graphql(THREADS_Q, {"owner": owner, "name": name, "number": number})
    pr = (data.get("repository") or {}).get("pullRequest")
    if not pr:
        raise HTTPException(404, "PR not found")
    out = []
    for t in pr["reviewThreads"]["nodes"]:
        cs = t.pop("comments")["nodes"]
        for c in cs:
            c["bodyHTML"] = sanitize_html(c.get("bodyHTML"))
        t["comments"] = cs
        out.append(t)
    return {"threads": out}


def _body(text: Any) -> str:
    text = (text if isinstance(text, str) else "").strip()
    if not text:
        raise HTTPException(400, "comment body is empty")
    if len(text) > 60_000:
        raise HTTPException(400, "comment is too long")
    return text


@router.post("/comment")
def comment(body: dict):
    owner, name = check_repo(body.get("repo", ""))
    number = check_number(body.get("number"))
    res = rest("POST", f"repos/{owner}/{name}/issues/{number}/comments", {"body": _body(body.get("body"))})
    return {"ok": True, "url": res.get("html_url")}


def _line_comment(c: dict) -> dict:
    path = c.get("path")
    if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
        raise HTTPException(400, "invalid file path")
    line = c.get("line")
    if not isinstance(line, int) or line < 1:
        raise HTTPException(400, "invalid line")
    side = c.get("side", "RIGHT")
    if side not in SIDES:
        raise HTTPException(400, "side must be LEFT or RIGHT")
    out = {"path": path, "line": line, "side": side, "body": _body(c.get("body"))}
    start = c.get("start_line")
    if isinstance(start, int) and 0 < start < line:
        out["start_line"], out["start_side"] = start, side
    return out


@router.post("/line-comment")
def line_comment(body: dict):
    owner, name = check_repo(body.get("repo", ""))
    number = check_number(body.get("number"))
    commit_id = body.get("commit_id")
    if not isinstance(commit_id, str) or not re.fullmatch(r"[0-9a-f]{40}", commit_id):
        raise HTTPException(400, "commit_id must be the PR head SHA")
    payload = {**_line_comment(body), "commit_id": commit_id}
    res = rest("POST", f"repos/{owner}/{name}/pulls/{number}/comments", payload)
    return {"ok": True, "url": res.get("html_url")}


@router.post("/reply")
def reply(body: dict):
    owner, name = check_repo(body.get("repo", ""))
    number = check_number(body.get("number"))
    cid = body.get("comment_id")
    if not isinstance(cid, int) or cid < 1:
        raise HTTPException(400, "invalid comment_id")
    res = rest("POST", f"repos/{owner}/{name}/pulls/{number}/comments/{cid}/replies", {"body": _body(body.get("body"))})
    return {"ok": True, "url": res.get("html_url")}


@router.post("/review")
def review(body: dict):
    owner, name = check_repo(body.get("repo", ""))
    number = check_number(body.get("number"))
    event = body.get("event")
    if event not in REVIEW_EVENTS:
        raise HTTPException(400, "event must be APPROVE, REQUEST_CHANGES or COMMENT")
    text = (body.get("body") or "").strip() if isinstance(body.get("body"), str) else ""
    if event == "REQUEST_CHANGES" and not text and not body.get("comments"):
        raise HTTPException(400, "request changes needs a summary or at least one comment")
    payload: dict[str, Any] = {"event": event}
    if text:
        payload["body"] = text
    comments = body.get("comments") or []
    if not isinstance(comments, list) or len(comments) > 100:
        raise HTTPException(400, "invalid comments")
    if comments:
        payload["comments"] = [_line_comment(c) for c in comments]
    commit_id = body.get("commit_id")
    if isinstance(commit_id, str) and re.fullmatch(r"[0-9a-f]{40}", commit_id):
        payload["commit_id"] = commit_id
    res = rest("POST", f"repos/{owner}/{name}/pulls/{number}/reviews", payload)
    return {"ok": True, "url": res.get("html_url"), "state": res.get("state")}


def image_api_path(url: str) -> str | None:
    """Map a GitHub repo-file image URL to a contents API path, or None."""
    p = urlparse(url)
    if p.scheme != "https":
        return None
    parts = [unquote(x) for x in p.path.split("/") if x]
    if p.netloc == "github.com" and len(parts) >= 5 and parts[2] in ("blob", "raw"):
        owner, name, ref, rel = parts[0], parts[1], parts[3], parts[4:]
    elif p.netloc == "raw.githubusercontent.com" and len(parts) >= 4:
        owner, name, ref, rel = parts[0], parts[1], parts[2], parts[3:]
    else:
        return None
    if not REPO_RE.match(f"{owner}/{name}") or any(x in ("..", ".") for x in rel) or not re.fullmatch(r"[\w./-]{1,200}", ref):
        return None
    return f"repos/{owner}/{name}/contents/{quote('/'.join(rel))}?ref={quote(ref)}"


def sniff_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    head = data[:512].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in head):
        return "image/svg+xml"
    return None


@router.get("/image")
def image(url: str):
    api = image_api_path(url)
    if not api:
        raise HTTPException(400, "only GitHub repository file images are proxied")

    def load():
        data = run_gh(["api", "-H", "Accept: application/vnd.github.raw", api], timeout=40)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "image too large")
        mime = sniff_mime(data)
        if not mime:
            raise HTTPException(415, "not an image")
        return {"dataUrl": f"data:{mime};base64,{base64.b64encode(data).decode()}"}

    return cached(f"img:{api}", 600, load)


WATCH_FIELDS = "number title state updatedAt headRefOid reviewDecision url comments{totalCount} reviews{totalCount} commits(last:1){nodes{commit{statusCheckRollup{state}}}}"


@router.get("/watch")
def watch(items: str = Query("")):
    keys = [k for k in items.split(",") if k][:25]
    parsed = []
    for k in keys:
        m = re.fullmatch(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d{1,8})", k)
        if not m:
            raise HTTPException(400, f"bad watch key {k!r}")
        parsed.append((k, m.group(1), m.group(2), int(m.group(3))))
    if not parsed:
        return {"items": {}}
    var_defs, sel, variables = [], [], {}
    for i, (_, owner, name, num) in enumerate(parsed):
        var_defs += [f"$o{i}:String!", f"$n{i}:String!", f"$p{i}:Int!"]
        variables.update({f"o{i}": owner, f"n{i}": name, f"p{i}": num})
        sel.append(f"w{i}: repository(owner:$o{i},name:$n{i}){{ pullRequest(number:$p{i}){{ {WATCH_FIELDS} }} }}")
    data = graphql(f"query({','.join(var_defs)}){{ {' '.join(sel)} }}", variables)
    out = {}
    for i, (key, *_rest) in enumerate(parsed):
        pr = ((data.get(f"w{i}") or {}).get("pullRequest"))
        if not pr:
            continue
        out[key] = {"title": pr["title"], "state": pr["state"], "head": pr["headRefOid"], "updatedAt": pr["updatedAt"],
                    "review": pr["reviewDecision"], "checks": _rollup(pr), "url": pr["url"],
                    "comments": pr["comments"]["totalCount"], "reviews": pr["reviews"]["totalCount"]}
    return {"items": out}
