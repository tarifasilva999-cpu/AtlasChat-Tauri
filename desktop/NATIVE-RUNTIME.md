# Atlas native desktop inference

Run the source app using the existing `npm run desktop` command. Close any older
Atlas window first. There is no new development dependency or compilation step.

Electron chat and project coding now use a supervised, native llama.cpp process.
Browser chat continues to use WebLLM. The renderer exchanges messages through a
fixed preload API; it cannot supply executables, model paths, URLs, or commands.
The local server binds only to 127.0.0.1, uses a random session key, and has its
built-in web interface disabled. Chats are not sent to the download hosts.

## First desktop launch

Atlas downloads official precompiled llama.cpp **b11429** binaries and the
selected model into `native-ai` inside Electron's user data directory. These
downloads are separate from the existing browser WebLLM cache. Every archive and
weight file is pinned to a revision and verified using SHA-256 before use.
Interrupted weight downloads resume; a completed transfer does not mean the
model is ready. Atlas first checks the files, starts the process, and confirms
that it produces a short reply.

| Atlas choice | Desktop weights | Download size |
| --- | --- | --- |
| Apex 7.3 | Qwen2.5 7B Instruct, Q4_K_M | 4.68 GB |
| Apex 7.3 UltraCode | Qwen2.5 Coder 7B Instruct, Q4_K_M | 4.68 GB |
| Forge 2.1 | Qwen2.5 1.5B Instruct, Q4_K_M | 1.12 GB |
| Firefly 4.5 | Qwen2.5 0.5B Instruct, Q4_K_M | 0.49 GB |

Sizes above use decimal GB. Both shards of Apex's split model must be present.
No larger Apex model is being promised by this change; it changes how the
existing desktop models execute. Effort levels retain the same weights and
change output budgets and requested context. Native chat honors those budgets
without the old 1,100-token clamp or an unlimited continuation loop.

## Hardware and recovery

Windows x64/ARM64 and Linux x64/ARM64 try Vulkan; macOS x64/ARM64 tries Metal.
The runner chooses how many layers fit on the GPU. If that path cannot start,
Atlas retries the same model with CPU execution. The CPU path may be slower.
Linux artifacts are official Ubuntu builds and require compatible system
libraries. Unsupported architectures produce a visible error.

Context is capped conservatively using real physical RAM: up to 8K below 12 GB,
16K from 12 GB, and 32K from 24 GB. Effort requests smaller windows when applicable.
Atlas reads the runner's actual context after hardware fitting, so a reduced
window is reflected in chat and coding limits. These are capacity heuristics,
not a benchmark or a guarantee that every machine
can load the chosen weights. Atlas does not silently substitute different Apex
weights when memory is insufficient.

Main-process deadlines cover download stalls, setup, model startup, verification,
first-token stalls and the whole reply. Stop aborts downloads or generation and
terminates the inference process. Closing Atlas also terminates the runner. After
a reset, the next Send loads the model again from the verified local files.

The settings information panel reports physical RAM, actual native acceleration,
and the effective context window. Internal diagnostic details are available via
the narrow `inferenceInfo` bridge for debugging.

## Sources and verification

- [Pinned llama.cpp binaries and license (MIT)](https://github.com/ggml-org/llama.cpp/releases/tag/b11429)
- [llama.cpp server protocol](https://github.com/ggml-org/llama.cpp/tree/b11429/tools/server)
- [Official Qwen2.5 7B model](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF)
- [Official Qwen2.5 Coder 7B model](https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF)
- [Official Qwen2.5 1.5B model](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF)
- [Official Qwen2.5 0.5B model](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF)

Focused tests use fake network responses and processes to check resume/integrity,
archive confinement, streamed output, deadlines, cancellation, leases and the
chat/coding adapter. They do not download weights, launch Electron or prove
hardware performance. Native downloads, driver behavior, packaged execution and
visual layout still require a real desktop run.
