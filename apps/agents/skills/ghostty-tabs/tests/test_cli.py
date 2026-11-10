"""纯 Python 的安全性/格式化测试（不依赖 Ghostty 界面与剪贴板）。"""

import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

CLI = Path(__file__).resolve().parents[1] / "scripts" / "ghostty-tabs.py"
spec = importlib.util.spec_from_file_location("ghostty_tabs_cli", CLI)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CliTests(unittest.TestCase):
    def invoke(self, *args, value=None):
        output = io.StringIO()
        with patch.object(sys, "argv", [str(CLI), *args]), patch.object(module, "call", return_value=value) as caller:
            with redirect_stdout(output):
                module.main()
        return caller, output.getvalue()

    def test_send_never_submits_by_default(self):
        caller, _ = self.invoke("send", "uuid", "echo safe", value={"submitted": False})
        caller.assert_called_once_with("send", "uuid", "echo safe", "no-submit")

    def test_send_submit_must_be_explicit(self):
        caller, _ = self.invoke("send", "uuid", "echo safe", "--submit", value={"submitted": True})
        caller.assert_called_once_with("send", "uuid", "echo safe", "submit")

    def test_multiline_is_rejected_before_call(self):
        with patch.object(sys, "argv", [str(CLI), "send", "uuid", "echo ok\nrm -rf bad", "--submit"]), patch.object(module, "call") as caller:
            with self.assertRaisesRegex(ValueError, "换行"):
                module.main()
            caller.assert_not_called()

    def test_read_truncates_without_full(self):
        caller, output = self.invoke("read", "uuid", "--lines", "2", value="one\ntwo\nthree\nfour\n")
        caller.assert_called_once_with("read", "uuid", "screen")
        self.assertEqual(output, "three\nfour\n")

    def test_full_json_read(self):
        _, output = self.invoke("--json", "read", "uuid", "--mode", "scrollback", "--full", value="one\ntwo")
        self.assertEqual(json.loads(output), {"terminal_id": "uuid", "mode": "scrollback", "text": "one\ntwo"})


if __name__ == "__main__":
    unittest.main()
