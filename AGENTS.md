# POPO repository working agreements

## Extension development and test boundary

- The Git working tree is the only source of truth for Extension code.
- The fixed Dev test output is `D:\POPODevDownloader\Extension`.
- The fixed Stable reference is `E:\新建文件夹\POPOStableDownloader\Extension` and is read-only. Never modify, overwrite, synchronize, or clean it without an explicit release instruction.
- After changing Extension source, run the relevant tests, run `npm run dev:extension:sync`, verify the Dev manifest and extension identity, then ask the user to reload “POPO Dev 下载助手” in Chrome and refresh the POPO page.
- Ordinary Extension JavaScript, CSS, and HTML changes do not require rebuilding an installer.
- Rebuild a Dev package or installer only for Native Host, Agent, installer, registration/configuration, or final release acceptance work.
- Do not stage, commit, push, tag, release, or modify Stable unless the user explicitly authorizes that exact action.
