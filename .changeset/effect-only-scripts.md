---
"opencode-drive": major
---

Make the script API Effect-only. Script setup and run callbacks, UI, LLM, filesystem, server, and client operations now return Effects; LLM serve handlers return Streams; and script cancellation uses Effect interruption without a Promise compatibility shim.
