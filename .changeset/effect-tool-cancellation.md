---
"opencode-drive": major
---

Remove the tool handler `AbortSignal`. Foreground session interruption, transport disconnects, and Drive shutdown now surface uniformly as Effect interruption, and controller shutdown awaits handler finalizers. Detached background shell handlers remain active after launch and are interrupted during Drive shutdown.
