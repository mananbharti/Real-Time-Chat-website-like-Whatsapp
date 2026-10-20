#!/usr/bin/env python3
"""Build the vendored Unicode 17 catalog from emojibase-data 17.0.0 and Noto v2.051.
Usage: python3 scripts/build-emoji.py /path/to/emojibase-data/package /path/to/noto-emoji
Sources, versions and licenses are recorded in docs/REFERENCE-NOTES.md.
"""
import json
import pathlib
import shutil
import sys
base, noto = map(pathlib.Path, sys.argv[1:3])
root = pathlib.Path(__file__).resolve().parent.parent
out = root / 'public' / 'emoji'
for file in out.glob('*.svg'):
    file.unlink()
entries = []

def add(item, parent=None):
    if 'group' in item:
        code = item['hexcode'].lower().replace('-', '_').replace('_fe0f', '')
        name = 'emoji_u' + code + '.svg'
        source = noto / 'svg' / name
        if not source.exists():
            source = noto / 'third_party' / 'region-flags' / 'waved-svg' / name
        if not source.exists():
            raise ValueError('Missing artwork: ' + item['hexcode'])
        shutil.copyfile(source, out / name)
        entries.append({'emoji': ''.join(chr(int(c, 16)) for c in item['hexcode'].split('-')) if item['type'] == 1 else item['emoji'], 'name': item['label'], 'tags': item.get('tags', []),
                        'group': item['group'], 'order': item.get('order', 0), 
                        'variant': parent is not None, 'asset': name})
    for skin in item.get('skins', []):
        add(skin, item)

for item in json.loads((base / 'en' / 'data.json').read_text()):
    add(item)
entries.sort(key=lambda e: e['order'])
(root / 'public' / 'emoji-data.js').write_text('"use strict";\nconst emojiCatalog = ' + json.dumps(entries, ensure_ascii=False, separators=(',', ':')) + ';\n')
shutil.copyfile(noto / 'svg' / 'LICENSE', out / 'Noto-APACHE-NOTICE.txt')
shutil.copyfile(noto / 'third_party' / 'region-flags' / 'LICENSE', out / 'Flags-LICENSE.txt')
shutil.copyfile(base / 'LICENSE', out / 'Emojibase-LICENSE.txt')
print('Catalog:', len(entries), 'Artwork:', len(list(out.glob('*.svg'))))
