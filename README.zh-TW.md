# 在 Windows Codex 加入 Gemini 模型

[English](README.md)

這是 [Jakevin 原專案](https://github.com/Jakevin/codex-bridge-antigravity) 的 Windows x64 版本。使用自己的 ChatGPT 和 Google 帳號，就能從同一個 Codex 模型選單切換 GPT 與 Antigravity 提供的 Gemini。這個版本包含登入自啟、背景服務自動復原、推理等級切換、對話增量接續、圖片輸入與本機用量頁。檔案和指令操作由 Codex 依目前工作區與審批設定執行。

## 可以貼給 Codex 的提示詞

```text
請在我的 Windows x64 電腦安裝 https://github.com/HolyBearTW/codex-bridge-antigravity 的 Gemini 橋接器，讓 Codex 模型選單同時顯示原生 GPT 與我的 Antigravity 帳號可用的 Gemini。

請先讀 README.zh-TW.md，確認 Git、Node.js 22.15+、Codex 和官方 Antigravity CLI（agy）可用。需要登入時請讓我在官方視窗登入自己的 ChatGPT 或 Google 帳號，再繼續。

請把倉庫 clone 到固定目錄，以我目前的專案作為 -Workspace，執行 scripts/install-windows.ps1。沿用我的 Codex 權限設定。若已設定另一套代理，請先回報衝突並保留原設定。安裝後驗證 /healthz 與 AGY 模型清單，告訴我備份位置，並提醒我重啟 Codex、從模型選單切換 GPT → Gemini → GPT。
```

## 手動安裝

1. 準備 Windows x64、Git、Node.js 22.15 以上。先在本機 Codex Desktop 或 CLI 用自己的 ChatGPT 帳號登入。
2. 安裝官方 `agy`。在工作區啟動 `agy` 並完成 Google 帳號登入，再用 `agy models` 確認有哪些模型可用。[Google Antigravity CLI 安裝說明](https://antigravity.google/docs/getting-started?tab=cli)
3. 在 PowerShell 執行以下命令，把範例工作區換成你要用的既有專案資料夾。安裝後保留這個 clone，排程會從這裡載入程式。

```powershell
git clone https://github.com/HolyBearTW/codex-bridge-antigravity.git
Set-Location codex-bridge-antigravity
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\install-windows.ps1 -Workspace 'C:\Projects\my-project'
```

安裝程式會比對 GitHub Release 中 Windows 啟動器的 SHA-256，將 `CodexAntigravityBridge` 註冊為目前使用者登入時啟動的排程，並在服務健康後寫入 Codex 的本機路由。預設使用 `127.0.0.1:17842`，可用 `-Port` 另選連接埠。啟動器尚無 Authenticode 簽章，也可依英文 README 的指示自行編譯。

## 驗證與使用

```powershell
Invoke-RestMethod http://127.0.0.1:17842/healthz | Select-Object ok, agy_workspace_ok, model_count
node src/cli.mjs doctor
```

看到 `ok` 和 `agy_workspace_ok` 都是 `True`，且 `model_count` 大於零後，重啟 Codex。Desktop 可直接打開模型選單，CLI 可輸入 `/model`。用一段測試對話確認 GPT → Gemini → GPT 的切換。Gemini 名稱、推理等級和額度以 `agy models` 與你的 Google 帳號為準。用量頁位於 `http://127.0.0.1:17842/usage`。

同一聊天切換到 Gemini 時，橋接器會把接續所需的對話內容傳給 Google Antigravity。GPT 請求由原有的 ChatGPT 帳號驗證並送往 OpenAI。這是社群整合，兩邊都使用各自帳號的額度。

## 還原

從原來的 clone 執行以下命令，然後重啟 Codex。

```powershell
node src/cli.mjs disconnect
```

此指令會還原安裝前的 `config.toml` 並移除本專案的背景排程。預設備份位於 `~/.codex-bridge-antigravity/codex/config.toml.before-antigravity`。若安裝後有調整過 Codex 設定，先另存目前的 `config.toml`，還原後可把需要的調整加回。橋接器日誌位於 `~/.codex-bridge-antigravity/logs/`。

[MIT 授權](LICENSE) · [上游專案](https://github.com/Jakevin/codex-bridge-antigravity)
