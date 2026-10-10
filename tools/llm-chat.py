#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["pyyaml"]
# ///
"""llm-chat —— 读取 YAML 消息历史，调用 OpenAI 兼容 LLM 并流式输出回复。

YAML 文件根节点是消息列表，每项含 role / content：
    - role: system
      content: 你是一个乐于助人的 AI 助手
    - role: user
      content: 今天天气怎么样
    - role: assistant
      content: 今天天气不错
    - role: user
      content: 明天呢？

默认启用模型 thinking，思考过程以灰色输出到 stderr，最终回复输出到 stdout
（无颜色、可直接管道）。用 --no-thinking 关闭 thinking。

用法：
  uv run tools/llm-chat.py messages.yaml
  cat messages.yaml | uv run tools/llm-chat.py -          # 从 stdin 读
  uv run tools/llm-chat.py messages.yaml --model deepseek-v4-pro --temperature 0.7
  uv run tools/llm-chat.py messages.yaml --no-thinking

配置（优先级：CLI 参数 > 环境变量 LLM_API_KEY > tools/auth.json > 内置默认）：
  tools/auth.json: {"api_key": "...", "base_url": "...", "model": "..."}
"""

import argparse
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

import yaml

AUTH_FILE = Path(__file__).resolve().parent / "auth.json"
API_KEY_ENV = "LLM_API_KEY"
DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_MODEL = "deepseek-flash"
VALID_ROLES = {"system", "user", "assistant"}
REASONING_FIELDS = ("reasoning_content", "reasoning", "reasoning_text")
GRAY = "\033[90m"
RESET = "\033[0m"
REQUEST_TIMEOUT = 300


def fail(message: str, code: int = 1) -> "NoReturn":  # noqa: F821
    """Print an error to stderr and exit with the given code."""
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def load_auth_file() -> dict:
    """Read tools/auth.json; return {} when it is absent."""
    if not AUTH_FILE.is_file():
        return {}
    try:
        data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        fail(f"无法读取 {AUTH_FILE}: {exc}")
    return data if isinstance(data, dict) else {}


def resolve_config(args: argparse.Namespace) -> dict:
    """Merge CLI args, LLM_API_KEY env var, auth.json and built-in defaults."""
    auth = load_auth_file()

    api_key = args.api_key or os.environ.get(API_KEY_ENV) or auth.get("api_key")
    base_url = args.base_url or auth.get("base_url") or DEFAULT_BASE_URL
    model = args.model or auth.get("model") or DEFAULT_MODEL

    if not api_key:
        fail(
            f"缺少 API key。请设置环境变量 {API_KEY_ENV}，"
            f"或在 {AUTH_FILE} 中填写 api_key。"
        )

    config = {
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
        "thinking": args.thinking,
    }
    if args.temperature is not None:
        config["temperature"] = args.temperature
    if args.max_tokens is not None:
        config["max_tokens"] = args.max_tokens
    return config


def load_messages(source: str) -> list[dict]:
    """Parse and validate the YAML message history."""
    if source == "-":
        text, label = sys.stdin.read(), "<stdin>"
    else:
        path = Path(source)
        if not path.is_file():
            fail(f"YAML 文件不存在: {source}", 2)
        text, label = path.read_text(encoding="utf-8"), source

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        fail(f"{label}: YAML 解析失败: {exc}", 2)

    if not isinstance(data, list) or not data:
        fail(f"{label}: 根节点必须是非空的 YAML 列表", 2)

    messages: list[dict] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            fail(f"{label}: 第 {index} 条消息必须是含 role/content 的映射", 2)
        role, content = item.get("role"), item.get("content")
        if role not in VALID_ROLES:
            fail(
                f"{label}: 第 {index} 条消息的 role 非法: {role!r}"
                f"（允许 {'/'.join(sorted(VALID_ROLES))}）",
                2,
            )
        if not isinstance(content, str):
            fail(f"{label}: 第 {index} 条消息的 content 必须是字符串", 2)
        messages.append({"role": role, "content": content})
    return messages


def thinking_rule(label: str = "") -> str:
    """A horizontal rule sized to the terminal, optionally with a label."""
    width = shutil.get_terminal_size((60, 24)).columns
    if not label:
        return "─" * width
    prefix = f"── {label} "
    return prefix + "─" * max(0, width - len(prefix))


def build_payload(config: dict, messages: list[dict]) -> dict:
    """Assemble the /chat/completions request body."""
    thinking = config["thinking"]
    # DeepSeek 要求开启 thinking 时，历史 assistant 消息必须带 reasoning_content 字段。
    prepared = []
    for message in messages:
        if thinking and message["role"] == "assistant":
            message = {"reasoning_content": "", **message}
        prepared.append(message)

    payload = {
        "model": config["model"],
        "messages": prepared,
        "stream": True,
        "thinking": {"type": "enabled" if thinking else "disabled"},
    }
    for key in ("temperature", "max_tokens"):
        if key in config:
            payload[key] = config[key]
    return payload


def stream_chat(config: dict, messages: list[dict]) -> None:
    """POST /chat/completions and stream thinking (stderr, gray) + reply (stdout)."""
    url = config["base_url"].rstrip("/") + "/chat/completions"
    payload = build_payload(config, messages)

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {config['api_key']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    gray, reset = (GRAY, RESET) if sys.stderr.isatty() else ("", "")
    thinking_open = False

    def close_thinking() -> None:
        nonlocal thinking_open
        if thinking_open:
            sys.stderr.write("\n" + thinking_rule() + reset + "\n")
            sys.stderr.flush()
            thinking_open = False

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    reasoning = next(
                        (delta[f] for f in REASONING_FIELDS
                         if isinstance(delta.get(f), str) and delta[f]),
                        None,
                    )
                    if reasoning and config["thinking"]:
                        if not thinking_open:
                            sys.stderr.write(gray + thinking_rule("thinking") + "\n")
                            thinking_open = True
                        sys.stderr.write(reasoning)
                        sys.stderr.flush()
                    content = delta.get("content")
                    if content:
                        close_thinking()
                        sys.stdout.write(content)
                        sys.stdout.flush()
    except urllib.error.HTTPError as exc:
        fail(f"HTTP {exc.code}: {parse_error_body(exc)}")
    except urllib.error.URLError as exc:
        fail(f"网络请求失败: {exc.reason}")
    finally:
        close_thinking()
        sys.stdout.write("\n")
        sys.stdout.flush()


def parse_error_body(exc: urllib.error.HTTPError) -> str:
    """Extract a readable message from an HTTP error response body."""
    try:
        body = exc.read().decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - best effort only
        return exc.reason or "unknown error"
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        return body.strip() or (exc.reason or "unknown error")
    error = parsed.get("error")
    if isinstance(error, dict):
        return error.get("message") or json.dumps(error, ensure_ascii=False)
    return parsed.get("message") or json.dumps(parsed, ensure_ascii=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="从 YAML 消息历史调用 OpenAI 兼容 LLM 并流式输出回复。",
        epilog="示例: uv run tools/llm-chat.py messages.yaml --model deepseek-v4-pro",
    )
    parser.add_argument(
        "yaml_file", nargs="?", default="-",
        help="消息历史 YAML 文件，'-' 或省略表示从 stdin 读取",
    )
    parser.add_argument("--base-url", help="覆盖 base_url")
    parser.add_argument("--model", help="覆盖模型 id")
    parser.add_argument("--api-key", help="覆盖 API key")
    parser.add_argument("--temperature", type=float, help="采样温度")
    parser.add_argument("--max-tokens", type=int, help="最大生成 token 数")
    parser.add_argument(
        "--thinking", action=argparse.BooleanOptionalAction, default=True,
        help="启用模型 thinking（默认启用；用 --no-thinking 关闭）",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    config = resolve_config(args)
    messages = load_messages(args.yaml_file)
    stream_chat(config, messages)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        sys.stdout.flush()
        raise SystemExit(130)
