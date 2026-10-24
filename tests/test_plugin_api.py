import sys, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboard"))
import plugin_api as p  # noqa: E402
from fastapi import HTTPException  # noqa: E402


class Sanitizer(unittest.TestCase):
    def test_strips_scripts_handlers_and_js_links(self):
        out = p.sanitize_html('<p onclick="x()">hi<script>alert(1)</script></p><a href="javascript:alert(1)">x</a><iframe src="https://e"></iframe><style>*{}</style>')
        self.assertEqual(out, "<p>hi</p><a>x</a>")

    def test_keeps_safe_links_and_marks_repo_images(self):
        out = p.sanitize_html('<a href="https://github.com/a/b"><img src="https://github.com/o/r/blob/abc/docs/x.png?raw=true" alt="shot"></a>')
        self.assertIn('href="https://github.com/a/b"', out)
        self.assertIn('rel="noreferrer noopener"', out)
        self.assertIn('data-gh-src="https://github.com/o/r/blob/abc/docs/x.png?raw=true"', out)
        self.assertNotIn(" src=", out)

    def test_public_images_keep_src_and_http_images_dropped(self):
        self.assertIn('src="https://private-user-images.githubusercontent.com/1/x.png?jwt=a"',
                      p.sanitize_html('<img src="https://private-user-images.githubusercontent.com/1/x.png?jwt=a">'))
        self.assertEqual(p.sanitize_html('<img src="http://e/x.png">'), "")

    def test_escapes_text_and_closes_tags(self):
        self.assertEqual(p.sanitize_html("<b>a &lt;x&gt;"), "<b>a &lt;x&gt;</b>")

    def test_task_list_checkbox(self):
        out = p.sanitize_html('<input type="checkbox" checked onclick="x"><input type="text" value="a">')
        self.assertEqual(out, '<input type="checkbox" disabled checked>')


class Urls(unittest.TestCase):
    def test_image_api_path(self):
        self.assertEqual(p.image_api_path("https://github.com/o/r/blob/abc123/docs/a%20b.png?raw=true"),
                         "repos/o/r/contents/docs/a%20b.png?ref=abc123")
        self.assertEqual(p.image_api_path("https://raw.githubusercontent.com/o/r/main/x.png"),
                         "repos/o/r/contents/x.png?ref=main")

    def test_image_api_path_rejects_other_hosts_and_traversal(self):
        for u in ["https://evil.com/o/r/blob/a/x.png", "http://github.com/o/r/blob/a/x.png",
                  "https://github.com/o/r/blob/a/../../x.png", "https://github.com/o/r/issues/1"]:
            self.assertIsNone(p.image_api_path(u), u)

    def test_parse_remote(self):
        self.assertEqual(p.parse_remote("git@github.com:Murali-lns/x.git\n"), "Murali-lns/x")
        self.assertEqual(p.parse_remote("https://github.com/o/r"), "o/r")
        self.assertIsNone(p.parse_remote("https://gitlab.com/o/r.git"))

    def test_sniff(self):
        self.assertEqual(p.sniff_mime(b"\x89PNG\r\n\x1a\nxxxx"), "image/png")
        self.assertIsNone(p.sniff_mime(b"<html>"))


class Validation(unittest.TestCase):
    def test_repo_and_number(self):
        for bad in ["", "a", "a/b/c", "../x", "a b/c"]:
            with self.assertRaises(HTTPException):
                p.check_repo(bad)
        with self.assertRaises(HTTPException):
            p.check_number(0)

    def test_line_comment_validation(self):
        ok = p._line_comment({"path": "src/a.ts", "line": 3, "side": "RIGHT", "body": " fix "})
        self.assertEqual(ok, {"path": "src/a.ts", "line": 3, "side": "RIGHT", "body": "fix"})
        for bad in [{"path": "../x", "line": 1, "body": "a"}, {"path": "a", "line": 0, "body": "a"},
                    {"path": "a", "line": 1, "side": "UP", "body": "a"}, {"path": "a", "line": 1, "body": "  "}]:
            with self.assertRaises(HTTPException):
                p._line_comment(bad)


class Writes(unittest.TestCase):
    def test_review_posts_expected_payload(self):
        with mock.patch.object(p, "rest", return_value={"html_url": "u", "state": "APPROVED"}) as r:
            res = p.review({"repo": "o/r", "number": 5, "event": "APPROVE", "body": "lgtm", "commit_id": "a" * 40,
                            "comments": [{"path": "x.py", "line": 2, "side": "RIGHT", "body": "nit"}]})
        self.assertTrue(res["ok"])
        method, path, payload = r.call_args.args
        self.assertEqual((method, path), ("POST", "repos/o/r/pulls/5/reviews"))
        self.assertEqual(payload["event"], "APPROVE")
        self.assertEqual(payload["comments"][0]["path"], "x.py")

    def test_review_rejects_bad_event_and_empty_request_changes(self):
        with self.assertRaises(HTTPException):
            p.review({"repo": "o/r", "number": 5, "event": "MERGE"})
        with self.assertRaises(HTTPException):
            p.review({"repo": "o/r", "number": 5, "event": "REQUEST_CHANGES", "body": ""})

    def test_line_comment_requires_head_sha(self):
        with self.assertRaises(HTTPException):
            p.line_comment({"repo": "o/r", "number": 1, "path": "a", "line": 1, "body": "x", "commit_id": "main"})

    def test_gh_called_without_shell(self):
        done = mock.Mock(returncode=0, stdout=b"{}", stderr=b"")
        with mock.patch.object(p, "gh_path", return_value="/bin/gh"), mock.patch.object(p.subprocess, "run", return_value=done) as run:
            p.rest("GET", "repos/o/r")
        args, kwargs = run.call_args
        self.assertIsInstance(args[0], list)
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["env"]["GH_PROMPT_DISABLED"], "1")

    def test_missing_gh_is_503(self):
        with mock.patch.object(p, "gh_path", return_value=None):
            with self.assertRaises(HTTPException) as cm:
                p.run_gh(["api", "user"])
        self.assertEqual(cm.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
