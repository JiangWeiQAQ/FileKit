import posixpath
import re
import zipfile
from pathlib import Path
from typing import Any, Dict, List
from xml.etree import ElementTree as ET

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"a": A, "r": R}


def _open(path: str) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(path, "r")
    except zipfile.BadZipFile as error:
        raise ValueError("PPTX 文件损坏或不是有效的 Office ZIP 文件。") from error


def _xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        return ET.fromstring(archive.read(name))
    except KeyError as error:
        raise ValueError(f"不是有效 PPTX：缺少 {name}。") from error
    except ET.ParseError as error:
        raise ValueError(f"PPTX XML 损坏：{name}。") from error


def _slide_names(archive: zipfile.ZipFile) -> List[str]:
    names = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    if not names:
        raise ValueError("不是有效 PPTX：未找到幻灯片 XML。")
    return sorted(names, key=lambda name: int(re.search(r"slide(\d+)\.xml$", name).group(1)))


def _slide_data(archive: zipfile.ZipFile) -> List[Dict[str, Any]]:
    slides = []
    for index, name in enumerate(_slide_names(archive), start=1):
        root = _xml(archive, name)
        texts = []
        for paragraph in root.findall(".//a:p", NS):
            text = "".join(node.text or "" for node in paragraph.findall(".//a:t", NS)).strip()
            if text:
                texts.append(text)
        slides.append({"slide": index, "name": name, "text": "\n".join(texts), "textCount": len(texts)})
    return slides


def _relationships(archive: zipfile.ZipFile, slide_name: str) -> Dict[str, str]:
    relation_name = posixpath.join(posixpath.dirname(slide_name), "_rels", posixpath.basename(slide_name) + ".rels")
    if relation_name not in archive.namelist():
        return {}
    root = _xml(archive, relation_name)
    result = {}
    slide_directory = posixpath.dirname(slide_name)
    for relation in root.findall(f"{{{REL}}}Relationship"):
        relation_id = relation.get("Id")
        target = relation.get("Target")
        if relation_id and target and not target.startswith("/"):
            result[relation_id] = posixpath.normpath(posixpath.join(slide_directory, target))
    return result


def _images(archive: zipfile.ZipFile) -> List[Dict[str, Any]]:
    images = []
    seen = set()
    for slide_index, slide_name in enumerate(_slide_names(archive), start=1):
        root = _xml(archive, slide_name)
        relationships = _relationships(archive, slide_name)
        for blip in root.findall(".//a:blip", NS):
            target = relationships.get(blip.get(f"{{{R}}}embed", ""))
            if target and target.startswith("ppt/media/") and target in archive.namelist() and target not in seen:
                seen.add(target)
                images.append({"slide": slide_index, "name": target})
    return images


def info(path: str) -> Dict[str, Any]:
    with _open(path) as archive:
        slides = _slide_data(archive)
        return {"slideCount": len(slides), "textShapeCount": sum(slide["textCount"] for slide in slides), "imageCount": len(_images(archive))}


def extract_text(path: str, create_output: Any) -> Dict[str, Any]:
    with _open(path) as archive:
        slides = _slide_data(archive)
        text = "\n\n".join(f"Slide {slide['slide']}\n{slide['text']}" for slide in slides)
        data = {"text": text, "slides": [{key: value for key, value in slide.items() if key != "name"} for slide in slides], **info(path)}
    output = create_output(Path(path).stem, "text", "txt")
    Path(output).write_text(text + "\n", encoding="utf-8")
    return {"success": True, "message": "PPTX 文字已提取。", "files": [output], "data": data}


def extract_images(path: str, create_output: Any) -> Dict[str, Any]:
    files: List[str] = []
    with _open(path) as archive:
        for index, image in enumerate(_images(archive), start=1):
            extension = Path(image["name"]).suffix.lstrip(".").lower() or "bin"
            output = create_output(Path(path).stem, f"slide_{image['slide']}_image_{index}", extension)
            Path(output).write_bytes(archive.read(image["name"]))
            files.append(output)
    return {"success": True, "message": f"已提取 {len(files)} 张 PPTX 图片。", "files": files, "data": {"imageCount": len(files)}}


def count_matches(path: str, find: str) -> Dict[str, Any]:
    if not find:
        return {"success": False, "message": "查找文字不能为空。", "files": [], "data": None}
    with _open(path) as archive:
        count = sum((node.text or "").count(find) for slide in _slide_names(archive) for node in _xml(archive, slide).findall(".//a:t", NS))
    return {"success": True, "message": f"找到 {count} 处单个文字 run 匹配。", "files": [], "data": {"matchCount": count, "matchScope": "singleRun"}}


def replace_text(path: str, find: str, replace: str, create_output: Any) -> Dict[str, Any]:
    if not find:
        return {"success": False, "message": "查找文字不能为空。", "files": [], "data": None}
    changed: Dict[str, bytes] = {}
    count = 0
    with _open(path) as archive:
        for name in _slide_names(archive):
            root = _xml(archive, name)
            changed_here = False
            for node in root.findall(".//a:t", NS):
                if node.text and find in node.text:
                    count += node.text.count(find)
                    node.text = node.text.replace(find, replace)
                    changed_here = True
            if changed_here:
                changed[name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    if not count:
        return {"success": True, "message": "未找到单个文字 run 内的匹配，未生成新文件。", "files": [], "data": {"matchCount": 0, "matchScope": "singleRun"}}
    output = create_output(Path(path).stem, "replaced", "pptx")
    with zipfile.ZipFile(path, "r") as original, zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target:
        for item in original.infolist():
            target.writestr(item, changed.get(item.filename, original.read(item.filename)))
    return {"success": True, "message": f"已替换 {count} 处单个文字 run 匹配；原文件未修改。", "files": [output], "data": {"matchCount": count, "matchScope": "singleRun"}}
