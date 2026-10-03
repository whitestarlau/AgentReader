# AgentReader

English | [简体中文](README.zh.md)

A desktop AI document reader with PDF / EPUB import, reading, **highlight / rectangle selection**, and AI chat. Inspired by `Reference/pi` — small but complete.

## Features

- **Library**: import-based management under `library/{hash}/`, one folder per document (original file + `doc.json` + `annotations.json` + `chats.jsonl`)
- **Reading**: PDF.js `canvas + textLayer` with paging / zoom / text selection; EPUB (v0.2)
- **Annotation**: text highlight + modifier-drag rectangle selection (macOS `⌥`, other platforms `Alt`), persisted as normalized coordinates
- **AI chat**: sidebar, auto-injects the current selection as a citation, graded context (selection / chapter / full-text RAG), streaming output
- **Multi-provider**: reimplements `pi-ai`'s `Model / Context / StreamFn`, OpenAI-compatible endpoints

## Tech stack

- Electron + Vite + React + TypeScript
- `packages/ai`: multi-provider abstraction (OpenAI-compatible)
- `packages/agent`: AgentLoop + `SessionManager` (JSONL)
- `packages/app`: main process (IPC / library / vector / OCR) + renderer (PDF / annotations / chat)

## Quick start

```bash
nvm use 22.23.2        # requires Node >=22.19.0
npm install            # a proxy/mirror is needed to download the Electron binary
# proxy example: https_proxy=http://127.0.0.1:7890 npm install
# mirror example: ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm install

npm run dev            # Electron + Vite
# renderer only (no Electron):
npm run dev:web --workspace=@agentreader/app
```

Set the API key: after launch, open `Settings` in the sidebar and fill in `Base URL / Model / API Key`.

## Docs

- `docs/requirements.md` requirements
- `docs/plan.md` plan
- `docs/progress.md` progress log
- `Reference/pi` reference project (gitignored, not committed)

## Layout

```
AgentReader/
├── docs/
├── packages/
│   ├── ai/         # multi-provider
│   ├── agent/      # AgentLoop + sessions
│   └── app/        # Electron main / renderer / preload
└── Reference/      # reference (ignored)
```

## Roadmap

- Phase 1 MVP: PDF + annotations + sidebar chat + library
- Phase 2: EPUB + RAG + multi-provider
- Phase 3: dual-track OCR (scanned documents) + export + extensions
