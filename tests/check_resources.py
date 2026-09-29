#!/usr/bin/env python3
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1] / 'app/src/main'
resources = set()
xml_files = list(root.rglob('*.xml'))
for file in xml_files:
    document = ET.parse(file)
    for element in document.iter():
        for value in element.attrib.values():
            if value.startswith('@+id/'):
                resources.add(('id', value.split('/', 1)[1]))
        if file.parent.name == 'values' and element.get('name'):
            resources.add((element.tag, element.get('name')))
for file in (root / 'res').rglob('*'):
    if file.is_file() and file.parent.name != 'values':
        resources.add((file.parent.name.split('-')[0], file.stem))
for file in (root / 'java').rglob('*.java'):
    for kind, name in re.findall(r'(?<![\w.])R\.(\w+)\.(\w+)', file.read_text(encoding='utf-8')):
        assert (kind, name) in resources, f'{file}: missing R.{kind}.{name}'
for file in xml_files:
    for kind, name in re.findall(r'@(?!(?:android:|\+))(\w+)/(\w+)', file.read_text(encoding='utf-8')):
        assert (kind, name) in resources, f'{file}: missing @{kind}/{name}'
print(f'PASS: {len(xml_files)} XML files and all local Java/XML resource references')
