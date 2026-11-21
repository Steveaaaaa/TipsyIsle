# 草莓电台 · Berry FM

TipsyIsle 的一套粉色外观。灵感来自随身电子设备：草莓色透明外壳、奶白按键和薄荷绿小屏。首页的两张原创电台插画会随日夜配色切换。

在 TipsyIsle 里打开「设置 → 阅读与显示 → 浏览外观包」，选择「预览草莓电台」，再点「保存外观」。也可以分享 `草莓电台.tipsy-appearance.json`，让其他玩家从「外观 → 外观包 → 导入外观包」载入。图片和样式都随包提供，可离线加载。

参考：[Nintendo Switch Lite Coral](https://www.nintendo.com/us/store/products/nintendo-switch-lite-coral/) 的粉色机身和浅色按键；[teenage engineering PO‑33](https://teenage.engineering/store/po-33) 的 LCD 和实体控件层次；[Beats Solo Buds 晶透红](https://www.beatsbydre.com.cn/earbuds/solo-buds) 的半透明外壳；[Tamagotchi Paradise Pink Land](https://tamagotchi-official.com/us/series/paradise/item/01_998/) 的粉色与薄荷色搭配。参考只用于设计判断，未将产品图放进外观包。

日夜插画通过已授权的生图 API 使用 `gpt-image-2.6-sunburst` 生成。[完整提示词](./art-direction/)随源文件保留。刻度与图标为本包绘制。修改源文件后，运行 `node examples/appearance/berry-fm/build.mjs` 重新打包。
