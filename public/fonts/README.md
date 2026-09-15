# EPUB 楷体标点

`reader-plus-kai-punctuation.ttf` 是 AR PL UKai CN 的三个标点子集，只用于楷体模式的「、」「。」「，」（U+3001、U+3002、U+FF0C）。源字库的横排标点居中，因此将这三个字形向左、向下各移动 288/1024 em，并同步调整左侧边距。笔形、全角字宽、字体行距和竖排替代字形保持不变；正文、CFI 和 EPUB 文件均无需改写。

- 来源：[AR PL UKai CN 0.2.20080216](https://cdn.jsdelivr.net/npm/@fontpkg/ar-pl-u-kai-cn@0.2.20080216/UKaiCN.ttf)
- 原文件 SHA-256：`f7d13bf40ba35f8081c6faffbb79c7a41867971af5b6ba70bff24d7bba99fdf9`
- 原作者：Arphic Technology Co., Ltd.（1994–1999）；Arne Goetje（2003–2007）。
- 修改：Reader Plus，2026-09-06；重命名为 Reader Plus Kai Punctuation，并在字体名称表中记录修改说明。
- 许可证：随附的 [ARPHICPL.txt](ARPHICPL.txt)，原文取自源字体名称表的许可条目，未经修改。

生成使用 FontTools 4.64.0，核心步骤如下（`font` 为源文件的 `TTFont`，禁用时间戳重算）：

```python
options = subset.Options()
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13]
options.name_legacy = True
options.name_languages = ['*']
subsetter = subset.Subsetter(options=options)
subsetter.populate(text='，。、')
subsetter.subset(font)
for name in set(font.getBestCmap().values()):
    glyph = font['glyf'][name]
    glyph.coordinates.translate((-288, -288))
    glyph.recalcBounds(font['glyf'])
    advance, lsb = font['hmtx'][name]
    font['hmtx'][name] = (advance, lsb - 288)
# 更新名称、版权及修改说明后保存，保留原许可证条目。
```

应用通过独立的 `@font-face` 和 `unicode-range` 覆盖这三个字符，使用应用绝对地址以兼容 EPUB 的 iframe/base URL，并纳入字体加载等待和 PWA 预缓存。
