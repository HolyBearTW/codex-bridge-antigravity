# Codex Bridge for Antigravity

[繁體中文安裝指南與 Codex 提示詞](README.zh-TW.md)

This Windows x64 edition of [Jakevin/codex-bridge-antigravity](https://github.com/Jakevin/codex-bridge-antigravity) adds the Gemini models available to your Google Antigravity CLI account to the local Codex model picker, alongside the GPT models available to your signed-in Codex account. The bridge runs on localhost and starts at Windows sign-in.

- Separates native GPT requests from Antigravity requests and supports model changes within a chat.
- Lets Codex execute tool requests using its active workspace and approval settings.
- Maps Codex reasoning levels to AGY model variants and resumes the AGY conversation with incremental context.
- Includes a Windows watchdog and a local Antigravity quota dashboard at `http://127.0.0.1:17842/usage`.

## Windows setup

Install Git, Node.js 22.15 or newer, and [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli). Sign in to both Codex with ChatGPT and `agy` with your own Google account. Run `agy models` to check availability.

```powershell
git clone https://github.com/HolyBearTW/codex-bridge-antigravity.git
Set-Location codex-bridge-antigravity
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\install-windows.ps1 -Workspace 'C:\Projects\my-project'
```

Replace the example workspace with your existing project directory. The installer verifies the SHA-256 of the unsigned Windows launcher, starts the local bridge as a current-user scheduled task, and backs up the user-level Codex configuration before switching its route. Restart Codex after setup to load the merged model list.

Run `Invoke-RestMethod http://127.0.0.1:17842/healthz` to check the bridge and `node src/cli.mjs disconnect` to restore your pre-installation configuration and remove the scheduled task.

Selecting a Gemini model sends the relevant conversation context to Google Antigravity under your Google account. GPT requests use the signed-in ChatGPT account. Model availability and quota depend on each account.

## Development

Run `npm test` from the checkout. To build the Windows launcher locally, open an x64 Visual Studio 2026 Developer PowerShell and run `./scripts/build-windows-launcher.ps1`, then use `node src/cli.mjs setup --cwd <workspace> --agy-path <agy.exe>`.

This community integration is built on the [upstream project](https://github.com/Jakevin/codex-bridge-antigravity) and retains its [MIT license](LICENSE).
