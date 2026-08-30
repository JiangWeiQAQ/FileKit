import csv
import json
import os
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import quote, unquote


class PlainTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self._ignored_depth += 1
        if tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"} and self._ignored_depth:
            self._ignored_depth -= 1
        if tag in {"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._ignored_depth:
            self.parts.append(data)


def read_text(path: str) -> str:
    for encoding in ("utf-8-sig", "utf-8", "utf-16", "gb18030"):
        try:
            with open(path, "r", encoding=encoding, newline="") as source:
                return source.read()
        except UnicodeDecodeError:
            continue
    raise ValueError("无法识别文本编码；请转换为 UTF-8 后重试。")


def text_output_path(input_path: str, suffix: str, extension: str, create_output: Any) -> str:
    return create_output(Path(input_path).stem, suffix, extension)


def write_text(path: str, content: str) -> None:
    with open(path, "w", encoding="utf-8", newline="") as target:
        target.write(content)


def json_format(path: str, create_output: Any, minify: bool = False) -> Dict[str, Any]:
    source = read_text(path)
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        return {"success": False, "message": f"JSON 无效：第 {error.lineno} 行、第 {error.colno} 列：{error.msg}", "files": [], "data": {"line": error.lineno, "column": error.colno}}
    content = json.dumps(value, ensure_ascii=False, separators=(",", ":") if minify else None, indent=None if minify else 2)
    output = text_output_path(path, "minified" if minify else "formatted", "json", create_output)
    write_text(output, content + ("" if minify else "\n"))
    return {"success": True, "message": "JSON 已压缩。" if minify else "JSON 已格式化。", "files": [output], "data": {"text": content}}


def json_validate(path: str) -> Dict[str, Any]:
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        return {"success": False, "message": f"JSON 无效：第 {error.lineno} 行、第 {error.colno} 列：{error.msg}", "files": [], "data": {"line": error.lineno, "column": error.colno}}
    return {"success": True, "message": "JSON 格式有效。", "files": [], "data": {"type": type(value).__name__}}


def csv_to_json(path: str, create_output: Any) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))
    output = text_output_path(path, "from_csv", "json", create_output)
    content = json.dumps(rows, ensure_ascii=False, indent=2) + "\n"
    write_text(output, content)
    return {"success": True, "message": f"已转换 {len(rows)} 行 CSV 为 JSON。", "files": [output], "data": {"text": content, "rowCount": len(rows)}}


def json_to_csv(path: str, create_output: Any) -> Dict[str, Any]:
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as error:
        return {"success": False, "message": f"JSON 无效：第 {error.lineno} 行、第 {error.colno} 列：{error.msg}", "files": [], "data": None}
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        return {"success": False, "message": "仅支持由对象组成的规则 JSON 数组。", "files": [], "data": None}
    keys: List[str] = []
    for row in value:
        for key, item in row.items():
            if not isinstance(item, (str, int, float, bool, type(None))):
                return {"success": False, "message": "JSON 对象的值只能是字符串、数字、布尔值或 null。", "files": [], "data": None}
            if key not in keys:
                keys.append(key)
    output = text_output_path(path, "to_csv", "csv", create_output)
    with open(output, "w", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(value)
    return {"success": True, "message": f"已转换 {len(value)} 条 JSON 记录为 CSV。", "files": [output], "data": {"rowCount": len(value), "columns": keys}}


def html_to_text(path: str, create_output: Any) -> Dict[str, Any]:
    parser = PlainTextParser()
    parser.feed(read_text(path))
    text = re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()
    output = text_output_path(path, "text", "txt", create_output)
    write_text(output, text + "\n")
    return {"success": True, "message": "HTML 已提取为纯文本。", "files": [output], "data": {"text": text}}


def transform_text(path: str, action: str, create_output: Any) -> Dict[str, Any]:
    text = read_text(path)
    if action == "text-base64-encode":
        content, suffix = __import__("base64").b64encode(text.encode("utf-8")).decode("ascii"), "base64"
    elif action == "text-base64-decode":
        try:
            content = __import__("base64").b64decode(text.strip(), validate=True).decode("utf-8")
        except Exception as error:
            return {"success": False, "message": f"Base64 解码失败：{error}", "files": [], "data": None}
        suffix = "decoded"
    elif action == "text-url-encode":
        content, suffix = quote(text, safe=""), "url_encoded"
    elif action == "text-url-decode":
        content, suffix = unquote(text), "url_decoded"
    elif action == "text-deduplicate-lines":
        seen = set()
        lines = []
        for line in text.splitlines():
            if line not in seen:
                seen.add(line)
                lines.append(line)
        content, suffix = "\n".join(lines), "deduplicated"
    else:
        raise ValueError(f"未知文本操作：{action}")
    output = text_output_path(path, suffix, "txt", create_output)
    write_text(output, content)
    return {"success": True, "message": "文本处理完成。", "files": [output], "data": {"text": content}}
