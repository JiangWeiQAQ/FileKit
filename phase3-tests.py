import base64
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT / "python"))
import runpy

bridge = type("Bridge", (), runpy.run_path(str(ROOT / "python" / "bridge.py")))

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9mQAAAABJRU5ErkJggg==")
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"


def call(action, files, options, expected=True):
    old = os.environ.get("SCRIPTING_QUERY_PARAMETERS")
    os.environ["SCRIPTING_QUERY_PARAMETERS"] = json.dumps({"action": action, "files": files, "options": options})
    try:
        result = bridge.main()
    finally:
        if old is None:
            del os.environ["SCRIPTING_QUERY_PARAMETERS"]
        else:
            os.environ["SCRIPTING_QUERY_PARAMETERS"] = old
    assert result["success"] is expected, result
    return result


def write_docx(path):
    document = f'''<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:a="{A}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>
<w:p><w:r><w:t>hello DOCX world</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p>
<w:sectPr/></w:body></w:document>'''
    relations = f'''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{REL}"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'''
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", document)
        archive.writestr("word/_rels/document.xml.rels", relations)
        archive.writestr("word/media/image1.png", PNG)


def write_pptx(path):
    slide = f'''<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>hello PPTX</a:t></a:r></a:p></p:txBody></p:sp>
<p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>
</p:spTree></p:cSld></p:sld>'''
    relations = f'''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{REL}"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'''
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("ppt/slides/slide1.xml", slide)
        archive.writestr("ppt/slides/_rels/slide1.xml.rels", relations)
        archive.writestr("ppt/media/image1.png", PNG)


def main():
    from openpyxl import Workbook
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        output = root / "Outputs"
        output.mkdir()
        options = {"outputDirectory": str(output)}

        docx = root / "sample.docx"
        write_docx(docx)
        assert "hello DOCX" in call("docx-extract-text", [str(docx)], options)["data"]["text"]
        assert len(call("docx-extract-images", [str(docx)], options)["files"]) == 1
        replaced = call("docx-replace-text", [str(docx)], {**options, "find": "DOCX", "replace": "Word"})["files"][0]
        assert "hello Word" in call("docx-extract-text", [replaced], options)["data"]["text"]

        pptx = root / "sample.pptx"
        write_pptx(pptx)
        assert "Slide 1" in call("pptx-extract-text", [str(pptx)], options)["data"]["text"]
        assert len(call("pptx-extract-images", [str(pptx)], options)["files"]) == 1
        replaced = call("pptx-replace-text", [str(pptx)], {**options, "find": "PPTX", "replace": "Slides"})["files"][0]
        assert "hello Slides" in call("pptx-extract-text", [replaced], options)["data"]["text"]

        xlsx = root / "sample.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "数据"
        sheet.append(["name", "value"])
        sheet.append(["A", 1])
        sheet.append([None, None])
        workbook.create_sheet("第二页").append(["x"])
        workbook.save(xlsx)
        assert call("xlsx-info", [str(xlsx)], options)["data"]["sheetCount"] == 2
        assert call("xlsx-export-csv", [str(xlsx)], {**options, "sheetName": "数据", "allSheets": False})["files"]
        cleaned = call("xlsx-clean-blank", [str(xlsx)], options)["files"][0]
        assert call("xlsx-info", [cleaned], options)["success"]

        assert call("not-real", [str(docx)], options, expected=False)["files"] == []
    print("phase3.1-tests: 10/10 passed")


if __name__ == "__main__":
    main()
