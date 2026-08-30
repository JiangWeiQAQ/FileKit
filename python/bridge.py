import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List

from docx_ooxml import count_matches as docx_count_matches
from docx_ooxml import extract_images as docx_extract_images
from docx_ooxml import extract_text as docx_extract_text
from docx_ooxml import info as docx_info
from docx_ooxml import replace_text as docx_replace_text
from pptx_ooxml import count_matches as pptx_count_matches
from pptx_ooxml import extract_images as pptx_extract_images
from pptx_ooxml import extract_text as pptx_extract_text
from pptx_ooxml import info as pptx_info
from pptx_ooxml import replace_text as pptx_replace_text
from text_tools import csv_to_json, html_to_text, json_format, json_to_csv, json_validate, transform_text
from xlsx_tools import clean_blank_rows_columns, export_csv, info as xlsx_info


def response(success: bool, message: str, files: List[str] | None = None, data: Any = None) -> Dict[str, Any]:
    return {"success": success, "message": message, "files": files or [], "data": data}


def read_parameters() -> Dict[str, Any]:
    value = json.loads(os.environ.get("SCRIPTING_QUERY_PARAMETERS", "{}"))
    if not isinstance(value, dict):
        raise ValueError("queryParameters must be a JSON object")
    return value


def output_factory(options: Dict[str, Any]) -> Callable[[str, str, str], str]:
    directory = options.get("outputDirectory")
    if not isinstance(directory, str) or not directory:
        raise ValueError("缺少输出目录。")
    output_directory = Path(directory).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)

    def create_output(stem: str, suffix: str, extension: str) -> str:
        safe_stem = "".join(character if character.isalnum() or character in "_-" else "_" for character in stem).strip("_") or "file"
        safe_suffix = "".join(character if character.isalnum() or character in "_-" else "_" for character in suffix).strip("_") or "output"
        safe_extension = extension.lstrip(".").lower()
        candidate = output_directory / f"{safe_stem}_{safe_suffix}.{safe_extension}"
        index = 2
        while candidate.exists():
            candidate = output_directory / f"{safe_stem}_{safe_suffix}_{index}.{safe_extension}"
            index += 1
        return str(candidate)

    return create_output


def single_file(files: List[Any]) -> str:
    if len(files) != 1 or not isinstance(files[0], str) or not files[0]:
        raise ValueError("此操作需要且只需要选择一个文件。")
    path = Path(files[0])
    if not path.is_file():
        raise ValueError(f"输入文件不存在：{path.name}")
    return str(path)


def main() -> Dict[str, Any]:
    params = read_parameters()
    action = params.get("action")
    files = params.get("files", [])
    options = params.get("options", {})
    if not isinstance(action, str) or not isinstance(files, list) or not isinstance(options, dict):
        raise ValueError("action、files 和 options 参数无效。")
    if action == "ping":
        return response(True, "FileKit Python Bridge 已就绪。", data={"action": action, "fileCount": len(files), "options": options})

    path = single_file(files)
    create_output = output_factory(options)
    find = options.get("find", "")
    replace = options.get("replace", "")
    if not isinstance(find, str) or not isinstance(replace, str):
        raise ValueError("查找和替换文字必须是字符串。")

    handlers: Dict[str, Callable[[], Dict[str, Any]]] = {
        "docx-info": lambda: response(True, "DOCX 信息已读取。", data=docx_info(path)),
        "docx-extract-text": lambda: docx_extract_text(path, create_output),
        "docx-extract-images": lambda: docx_extract_images(path, create_output),
        "docx-count-matches": lambda: docx_count_matches(path, find),
        "docx-replace-text": lambda: docx_replace_text(path, find, replace, create_output),
        "xlsx-info": lambda: response(True, "工作簿信息已读取。", data=xlsx_info(path)),
        "xlsx-export-csv": lambda: export_csv(path, options.get("sheetName") if isinstance(options.get("sheetName"), str) else None, bool(options.get("allSheets")), create_output),
        "xlsx-clean-blank": lambda: clean_blank_rows_columns(path, create_output),
        "pptx-info": lambda: response(True, "PPTX 信息已读取。", data=pptx_info(path)),
        "pptx-extract-text": lambda: pptx_extract_text(path, create_output),
        "pptx-extract-images": lambda: pptx_extract_images(path, create_output),
        "pptx-count-matches": lambda: pptx_count_matches(path, find),
        "pptx-replace-text": lambda: pptx_replace_text(path, find, replace, create_output),
        "json-format": lambda: json_format(path, create_output),
        "json-minify": lambda: json_format(path, create_output, minify=True),
        "json-validate": lambda: json_validate(path),
        "csv-to-json": lambda: csv_to_json(path, create_output),
        "json-to-csv": lambda: json_to_csv(path, create_output),
        "html-to-text": lambda: html_to_text(path, create_output),
        "text-base64-encode": lambda: transform_text(path, action, create_output),
        "text-base64-decode": lambda: transform_text(path, action, create_output),
        "text-url-encode": lambda: transform_text(path, action, create_output),
        "text-url-decode": lambda: transform_text(path, action, create_output),
        "text-deduplicate-lines": lambda: transform_text(path, action, create_output),
    }
    handler = handlers.get(action)
    return handler() if handler else response(False, f"尚未实现 Python 操作：{action}")


if __name__ == "__main__":
    try:
        print(json.dumps(main(), ensure_ascii=False, separators=(",", ":")))
    except Exception as error:
        print(json.dumps(response(False, str(error)), ensure_ascii=False, separators=(",", ":")))
