# Swin2SR 4x model provenance

- Source: `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr`
- Revision: `5265ec378455585b81765de45c266b3be324d912`
- Upstream: https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr
- Purpose: local `q8` image-to-image inference for the 4x enhancement path

## Included files

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `config.json` | 837 | `96dd766fe3e4139fc1b5cc3eb940e940bd97ad28072168bd015f05cafd818994` |
| `preprocessor_config.json` | 152 | `cbc36266fcc93d5bc1e9ca69bcc648ae9d268918ad14cd3507216740f129cc4d` |
| `quantize_config.json` | 1,138 | `98b82eb2ee37ab72eda96f9c31a1098573395005d935b2f49c12cd2b656e9eb4` |
| `onnx/model_quantized.onnx` | 21,438,622 | `9e9bae06e1c280a1f2f5ab093312ee1ec39186afc8912259bb9e3de838f85fb8` |

Only the files required by the `q8` browser pipeline are vendored. Other precision variants are intentionally excluded.
