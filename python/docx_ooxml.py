import posixpath
import shutil
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Tuple
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W, "r": R}


def _xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        return ET.fromstring(archive.read(name))
    except KeyError as error:
        raise ValueError(f"不是有效 DOCX：缺少 {name}。") from error
    except ET.ParseError as error:
        raise ValueError(f"DOCX XML 损坏：{name}。") from error


def _paragraph(element: ET.Element) -> Tuple[str, str]:
    style = element.find("./w:pPr/w:pStyle", NS)
    style_name = style.get(f"{{{W}}}val", "") if style is not None else ""
    text = "".join(node.text or "" for node in element.findall(".//w:t", NS)).strip()
    return text, style_name


def _blocks(root: ET.Element) -> List[Dict[str, Any]]:
    body = root.find("w:body", NS)
    if body is None:
        raise ValueError("不是有效 DOCX：缺少正文。")
    blocks: List[Dict[str, Any]] = []
    for child in body:
        if child.tag == f"{{{W}}}p":
            text, style = _paragraph(child)
            if text:
                blocks.append({"type": "paragraph", "style": style, "text": text})
        elif child.tag == f"{{{W}}}tbl":
            rows = []
            for row in child.findall("w:tr", NS):
                cells = []
                for cell in row.findall("w:tc", NS):
                    cells.append("\n".join(text for text, _ in (_paragraph(p) for p in cell.findall("w:p", NS)) if text))
                rows.append(cells)
            blocks.append({"type": "table", "rows": rows})
    return blocks


def _text(blocks: List[Dict[str, Any]]) -> str:
    result: List[str] = []
    for block in blocks:
        if block["type"] == "paragraph":
            prefix = "# " if str(block["style"]).lower().startswith("heading") else ""
            result.append(prefix + str(block["text"]))
        else:
            result.extend(" | ".join(row) for row in block["rows"])
    return "\n\n".join(result)


def _relationships(archive: zipfile.ZipFile) -> Dict[str, str]:
    name = "word/_rels/document.xml.rels"
    if name not in archive.namelist():
        return {}
    root = _xml(archive, name)
    result = {}
    for relation in root.findall(f"{{{REL}}}Relationship"):
        target = relation.get("Target")
        relation_id = relation.get("Id")
        if relation_id and target and not target.startswith("/"):
            result[relation_id] = posixpath.normpath(posixpath.join("word", target))
    return result


def _image_parts(archive: zipfile.ZipFile, root: ET.Element) -> List[str]:
    relationships = _relationships(archive)
    parts = []
    seen = set()
    for blip in root.findall(".//a:blip", {**NS, "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}):
        relation_id = blip.get(f"{{{R}}}embed")
        target = relationships.get(relation_id or "")
        if target and target.startswith("word/media/") and target in archive.namelist() and target not in seen:
            seen.add(target)
            parts.append(target)
    return parts


def _open(path: str) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path, "r")
    except zipfile.BadZipFile as error:
        raise ValueError("DOCX 文件损坏或不是有效的 Office ZIP 文件。") from error


def info(path: str) -> Dict[str, Any]:
    with _open(path) as archive:
        root = _xml(archive, "word/document.xml")
        blocks = _blocks(root)
        return {"paragraphCount": sum(1 for block in blocks if block["type"] == "paragraph"), "tableCount": sum(1 for block in blocks if block["type"] == "table"), "imageCount": len(_image_parts(archive, root))}


def extract_text(path: str, create_output: Any) -> Dict[str, Any]:
    with _open(path) as archive:
        blocks = _blocks(_xml(archive, "word/document.xml"))
        data = {"text": _text(blocks), "blocks": blocks, **info(path)}
    output = create_output(Path(path).stem, "text", "txt")
    Path(output).write_text(data["text"] + "\n", encoding="utf-8")
    return {"success": True, "message": "DOCX 文字已提取。", "files": [output], "data": data}


def extract_images(path: str, create_output: Any) -> Dict[str, Any]:
    files: List[str] = []
    with _open(path) as archive:
        root = _xml(archive, "word/document.xml")
        for index, name in enumerate(_image_parts(archive, root), start=1):
            extension = Path(name).suffix.lstrip(".").lower() or "bin"
            output = create_output(Path(path).stem, f"image_{index}", extension)
            Path(output).write_bytes(archive.read(name))
            files.append(output)
    return {"success": True, "message": f"已提取 {len(files)} 张 DOCX 图片。", "files": files, "data": {"imageCount": len(files)}}


def _runs(root: ET.Element) -> List[ET.Element]:
    return root.findall(".//w:r", NS)


def count_matches(path: str, find: str) -> Dict[str, Any]:
    if not find:
        return {"success": False, "message": "查找文字不能为空。", "files": [], "data": None}
    with _open(path) as archive:
        root = _xml(archive, "word/document.xml")
        count = sum((node.text or "").count(find) for run in _runs(root) for node in run.findall("w:t", NS))
    return {"success": True, "message": f"找到 {count} 处单个文字 run 匹配。", "files": [], "data": {"matchCount": count, "matchScope": "singleRun"}}


def _write_replaced(source: str, output: str, xml_bytes: bytes) -> None:
    with zipfile.ZipFile(source, "r") as original, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for item in original.infolist():
            target.writestr(item, xml_bytes if item.filename == "word/document.xml" else original.read(item.filename))


def replace_text(path: str, find: str, replace: str, create_output: Any) -> Dict[str, Any]:
    if not find:
        return {"success": False, "message": "查找文字不能为空。", "files": [], "data": None}
    with _open(path) as archive:
        root = _xml(archive, "word/document.xml")
    count = 0
    for run in _runs(root):
        for node in run.findall("w:t", NS):
            if node.text and find in node.text:
                count += node.text.count(find)
                node.text = node.text.replace(find, replace)
    if not count:
        return {"success": True, "message": "未找到单个文字 run 内的匹配，未生成新文件。", "files": [], "data": {"matchCount": 0, "matchScope": "singleRun"}}
    output = create_output(Path(path).stem, "replaced", "docx")
    _write_replaced(path, output, ET.tostring(root, encoding="utf-8", xml_declaration=True))
    return {"success": True, "message": f"已替换 {count} 处单个文字 run 匹配；原文件未修改。", "files": [output], "data": {"matchCount": count, "matchScope": "singleRun"}}
