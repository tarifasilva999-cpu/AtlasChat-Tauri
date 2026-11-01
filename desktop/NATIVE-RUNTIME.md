# AtlasChat Tauri local models

The Tauri app uses a supervised llama.cpp runner for chat and a separate stable-diffusion.cpp runner for Image 1.1. Model downloads and runner archives are pinned to revisions and verified with SHA-256. Downloads resume after interruption. The previous Electron and browser installations have separate data and are unchanged.

| Choice | Weights | Approximate download |
| --- | --- | --- |
| Atlas 7.5 | Qwen3.5-4B, Unsloth Q4_K_M | 2.74 GB |
| Atlas 7.5 Code | Gemma 4 12B agentic, Q4_K_M | 7.38 GB |
| Atlas 7.5 Mini | MiniCPM5-2B, Q4_K_M | 1.56 GB |
| Image 1.1 | Qwen Image 2.1 base: Qwen3-VL encoder, Q4_K denoiser, and Qwen Image 2.1 VAE | 10.16 GB |

The text models use llama.cpp b11429, with Vulkan or Metal where supported and a CPU retry. Image 1.1 uses a separate pinned Windows x64 Vulkan build of stable-diffusion.cpp. It generates a 1K first pass with Qwen Image 2.1 base at 40 Euler steps and CFG 6, with aspect ratios from square to portrait and landscape. The 1080p option uses a downloaded 2x ESRGAN model; 4K uses a downloaded 4x RealESRGAN model. For 16:9, the exported sizes are 1920×1080 and 3840×2160; other ratios keep the selected shape. Each upscaler is downloaded only when first selected (about 67 MB). The image is AI-upscaled from the 1K pass and resized to the selected output dimensions; the 4K file has 3840×2160 pixels at 16:9, with fine detail reconstructed by the upscaler. High-resolution images take longer and use more GPU memory. Image generation requires a compatible Vulkan GPU and substantial system/GPU memory. Atlas does not substitute a different model when the requested weights cannot run.

Existing Firefly and Forge chat selections map to Mini. Old messages and saved images remain in their existing storage. Stop cancels a model transfer or an active image process; interrupted transfers can resume.

The source supports the base and optional upscaler pipelines, but the new model downloads, real image quality, 1080p/4K output, hardware requirements and packaged app have not yet been validated on-device. Historical migration results in TESTING.md concern the older models.

Sources: [Qwen3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B), [Gemma 4 Code](https://huggingface.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF), [MiniCPM5](https://huggingface.co/openbmb/MiniCPM5-2B), [Image 1.1 text encoder](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF), [Qwen Image 2.1 base GGUF](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF), [ESRGAN GGUF upscalers](https://huggingface.co/wbruna/upscalers-sdcpp-gguf), and [stable-diffusion.cpp Qwen Image 2.1](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md).
