# AtlasChat Tauri local models

The Tauri app uses a supervised llama.cpp runner for chat and a separate stable-diffusion.cpp runner for Image 1.1. Model downloads and runner archives are pinned to revisions and verified with SHA-256. Downloads resume after interruption. The previous Electron and browser installations have separate data and are unchanged.

| Choice | Weights | Approximate download |
| --- | --- | --- |
| Atlas 7.5 | Qwen3.5-4B, Unsloth Q4_K_M | 2.74 GB |
| Atlas 7.5 Code | Gemma 4 12B agentic, Q4_K_M | 7.38 GB |
| Atlas 7.5 Mini | MiniCPM5-2B, Q4_K_M | 1.56 GB |
| Image 1.1 | Qwen Image 2.1 Turbo: AtomicChat encoder and denoiser, plus Qwen Image 2.1 VAE | 10.16 GB |

The text models use llama.cpp b11429, with Vulkan or Metal where supported and a CPU retry. Image 1.1 uses a separate pinned Windows x64 Vulkan build of stable-diffusion.cpp and generates 512-pixel images using the Turbo eight-step schedule. It requires a compatible Vulkan GPU and substantial system/GPU memory. The model files, runtime and working memory add to the download size. Atlas does not substitute a different model when the requested weights cannot run.

Existing Firefly and Forge chat selections map to Mini. Old messages and saved images remain in their existing storage. Stop cancels a model transfer or an active image process; interrupted transfers can resume.

The current changes have focused automated checks with mocked runners. The new multi-gigabyte downloads, real model replies, real image output, hardware requirements, packaged app and visual behavior have not yet been validated. Historical migration results in TESTING.md concern the older models.

Sources: [Qwen3.5 4B](https://huggingface.co/Qwen/Qwen3.5-4B), [Gemma 4 Code](https://huggingface.co/yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF), [MiniCPM5](https://huggingface.co/openbmb/MiniCPM5-2B), [Image 1.1 encoder and required components](https://huggingface.co/AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF), and [stable-diffusion.cpp Qwen Image 2.1](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md).
