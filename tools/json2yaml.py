#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "pyyaml",
# ]
# ///
"""把 JSON 文件转成等价、便于阅读和修改的 YAML。

为什么不用 ``yaml.safe_dump(data)`` 直接转
------------------------------------------
默认 dump 会把长文本塞成单行带 ``\\n`` 转义、键按字母排序、嵌套结构走 flow style，
结果既难读也难改。本脚本针对「Langfuse 导出的 LLM 对话 input」这类场景做了可读性优化：

- 含换行的字符串 -> YAML block scalar（``|``），保留原始换行与缩进，像正文一样可读；
- 保持 JSON 里的字段原序（``sort_keys=False``），便于按出现顺序定位；
- 嵌套结构展开成缩进块（``default_flow_style=False``），而非内联 ``{}``/``[]``；
- 中文字符不转义（``allow_unicode=True``）；
- 行宽放宽到 1000，避免无换行的长行被硬折行截断（block scalar 内部换行不受影响）。

转换是无损的：YAML 是 JSON 的超集，回读后与原 JSON 逐字相等。

用法
----
    # 单文件，输出到同名 .yaml
    uv run ~/.shell/tools/json2yaml.py data.json

    # 指定输出路径
    uv run ~/.shell/tools/json2yaml.py data.json -o data.yaml

    # 批量转换（支持通配符，每个输入生成同名 .yaml）
    uv run ~/.shell/tools/json2yaml.py clinical-1.json clinical-2.json

    # 从 stdin 读、写 stdout
    cat data.json | uv run ~/.shell/tools/json2yaml.py -

    # 转完后顺便自检 round-trip 是否与原文件相等
    uv run ~/.shell/tools/json2yaml.py data.json --check

依赖：``pyyaml``（已通过 PEP 723 内联元数据声明，交由 uv 自动安装）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml


def _make_dumper() -> yaml.Dumper:
    """构造一个针对可读性优化过的 Dumper."""
    dumper = yaml.Dumper

    # 含换行的字符串用 block scalar (|)，其余保持普通标量。
    def str_representer(dumper: yaml.Dumper, data: str) -> yaml.ScalarNode:
        style = "|" if "\n" in data else None
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)

    # dict 保持插入序（不排序）。
    def dict_representer(dumper: yaml.Dumper, data: dict) -> yaml.MappingNode:
        return dumper.represent_mapping("tag:yaml.org,2002:map", data.items())

    # list 保持原序。
    def list_representer(dumper: yaml.Dumper, data: list) -> yaml.SequenceNode:
        return dumper.represent_sequence("tag:yaml.org,2002:seq", data)

    dumper.add_representer(str, str_representer)
    dumper.add_representer(dict, dict_representer)
    dumper.add_representer(list, list_representer)
    return dumper


def json_to_yaml(data: object) -> str:
    """把已解析的 Python 对象序列化成可读 YAML 字符串."""
    return yaml.dump(
        data,
        Dumper=_make_dumper(),
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
        width=1000,
    )


def load_json(source: str | Path) -> object:
    """从字符串内容或文件路径读取 JSON."""
    text = Path(source).read_text(encoding="utf-8") if isinstance(source, Path) else source
    return json.loads(text)


def convert(src: Path, dst: Path | None = None, check: bool = False) -> Path:
    """转换单个文件，返回写入的目标路径.

    ``dst`` 为 None 时取 ``src`` 同名 ``.yaml``（``-`` 视为 stdin/stdout）.
    """
    if str(src) == "-":
        data = json.load(sys.stdin)
        out_text = json_to_yaml(data)
        sys.stdout.write(out_text)
        return src

    data = load_json(src)
    out_text = json_to_yaml(data)

    if dst is None:
        dst = src.with_suffix(".yaml")
    dst.write_text(out_text, encoding="utf-8")

    if check:
        back = yaml.safe_load(dst.read_text(encoding="utf-8"))
        if back != data:
            # 不直接 assert，给出更友好的提示后以非零退出。
            raise RuntimeError(f"round-trip 校验失败：{src} != {dst}")
    return dst


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 JSON 转成等价、便于阅读和修改的 YAML（长文本走 block scalar、保持字段序）。",
    )
    parser.add_argument("inputs", nargs="+", type=Path,
                        help="输入 JSON 文件路径（多个；``-`` 表示 stdin）")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="输出路径（仅单文件时有效；默认同名 .yaml；``-`` 表示 stdout）")
    parser.add_argument("--check", action="store_true",
                        help="转换后回读 YAML 与原 JSON 比对，不相等则报错退出")
    args = parser.parse_args()

    if args.output is not None and len(args.inputs) > 1:
        parser.error("-o/--output 仅在传入单个输入文件时可用")

    rc = 0
    for src in args.inputs:
        try:
            dst = convert(src, args.output, check=args.check)
        except Exception as e:  # noqa: BLE001 - CLI 脚本，需逐文件报告
            print(f"[FAIL] {src}: {type(e).__name__}: {e}", file=sys.stderr)
            rc = 1
            continue
        if str(src) != "-":
            print(f"[OK]   {src} -> {dst}")
    return rc


if __name__ == "__main__":
    sys.exit(main())