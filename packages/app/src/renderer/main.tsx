import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PdfViewer } from "./components/PdfViewer.tsx";
import { EpubViewer } from "./components/EpubViewer.tsx";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { type Annotation } from "./components/AnnotationLayer.tsx";
import { type Selection, SELECTION_LABEL } from "./selection.ts";
import { loadReadingPage } from "./reading.ts";
import { Settings, type SectionId } from "./components/Settings.tsx";
import { Icon } from "./components/Icons.tsx";
import { TitleBar } from "./components/shell/TitleBar.tsx";
import { ActivityBar } from "./components/shell/ActivityBar.tsx";
import { SideBar } from "./components/shell/SideBar.tsx";
import { EditorTabs } from "./components/shell/EditorTabs.tsx";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { Bookshelf } from "./components/shelf/Bookshelf.tsx";
import { deriveShelfDocs } from "./shelf-state.ts";
import { Resizer } from "./components/shell/Resizer.tsx";
import type { ExportRequest, ExportResult } from "../shared/chat-export.ts";
import type {
  TtsInfo,
  TtsModelProgress,
  TtsModelsPayload,
  TtsSynthesizeReply,
  TtsSynthesizeRequest,
  TtsVoiceGroup,
} from "../shared/tts.ts";
import type {
  ActivityView,
  AiConfig,
  CustomProvider,
  DocMeta,
  DocSearchResult,
  OutlineItem,
  PermissionDecision,
  PermissionRequest,
  SkillImportResult,
  SkillRuntimeInfo,
  SkillsPayload,
  SkillTrustPayload,
  WebSearchTestResult,
} from "./types.ts";
import type {
  BookListResult,
  BookOpResult,
  SyncConfigureInput,
  SyncConfigureResult,
  SyncBookOpResult,
  SyncLibraryEntry,
  SyncPresetInfo,
  SyncProbeResult,
  SyncResolveResult,
  SyncRunResult,
  SyncStatus,
  SyncStatusConflict,
} from "../shared/sync-types.ts";
import "./styles.css";

declare global {
  interface Window {
    api: {
      listLibrary: () => Promise<DocMeta[]>;
      importDoc: () => Promise<DocMeta | null>;
      removeDoc: (id: string) => Promise<boolean>;
      docCover: (docId: string) => Promise<string | null>;
      getAnnotations: (id: string) => Promise<Annotation[]>;
      saveAnnotations: (id: string, data: unknown) => Promise<void>;
      getOcr: (id: string) => Promise<Record<string, string>>;
      saveOcr: (id: string, page: number, text: string) => Promise<void>;
      getDocPath: (id: string) => Promise<string | null>;
      getDocOutline: (id: string) => Promise<{ unit: "page" | "chapter"; numPages: number; chapterLabels: string[]; toc: { label: string; href: string }[] }>;
      searchDoc: (docId: string, query: string, opts?: { limit?: number; chapter?: number; from?: number; to?: number }) => Promise<DocSearchResult>;
      readFile: (path: string) => Promise<Uint8Array>;
      getReaderChapter: (id: string) => Promise<number | null>;
      setReaderChapter: (id: string, chapter: number) => Promise<void>;
      chat: (docId: string, convId: string, prompt: string, history: unknown, page?: number, persistUser?: boolean) => Promise<{ ok?: boolean; error?: string; content?: string; title?: string; userId?: string }>;
      stopChat: (docId: string, convId: string) => Promise<boolean>;
      editChat: (docId: string, convId: string, messageId: string, content: string) => Promise<{ ok: boolean; error?: string; rows?: unknown[] }>;
      getChats: (docId: string, convId: string) => Promise<{ role: string; content: string }[]>;
      appendChat: (docId: string, convId: string, e: unknown) => Promise<void>;
      listConversations: (docId: string) => Promise<{ id: string; title: string }[]>;
      createConversation: (docId: string, title?: string) => Promise<{ id: string; title: string }>;
      deleteConversation: (docId: string, convId: string) => Promise<unknown>;
      renameConversation: (docId: string, convId: string, title: string) => Promise<unknown>;
      exportChat: (req: ExportRequest) => Promise<ExportResult>;
      syncStatus: () => Promise<SyncStatus>;
      syncNow: () => Promise<SyncRunResult>;
      syncConfigure: (input: SyncConfigureInput) => Promise<SyncConfigureResult>;
      syncTest: (input: SyncConfigureInput) => Promise<SyncConfigureResult>;
      syncDisconnect: () => Promise<SyncStatus>;
      syncPickDirectory: () => Promise<string | null>;
      syncPresets: () => Promise<SyncPresetInfo[]>;
      syncProbe: (input: { presetId: string; account: string; secret: string }) => Promise<SyncProbeResult>;
      syncOpenExternal: (url: string) => Promise<boolean>;
      syncReadClipboard: () => Promise<string | null>;
      syncOpenLogin: (presetId: string, url: string) => Promise<boolean>;
      syncConflicts: () => Promise<SyncStatusConflict[]>;
      syncResolve: (id: string, choice: "local" | "remote") => Promise<SyncResolveResult>;
      syncBooksList: () => Promise<BookListResult>;
      syncRemoteLibrary: () => Promise<Array<{ docId: string; title: string; ext: string; size: number; local: boolean }>>;
      syncDocIndex: () => Promise<string[]>;
      syncLibraryState: () => Promise<SyncLibraryEntry[]>;
      syncBookDelete: (docId: string) => Promise<SyncBookOpResult>;
      syncBookUpload: (docId: string) => Promise<BookOpResult>;
      syncBookDownload: (docId: string) => Promise<BookOpResult>;
      onSyncStatus: (cb: (status: SyncStatus) => void) => () => void;
      getSettings: () => Promise<Record<string, string>>;
      saveSettings: (s: unknown) => Promise<void>;
      getAiConfig: () => Promise<AiConfig>;
      saveAiConfig: (text: string) => Promise<{ ok: boolean; errors: string[] }>;
      openAiConfig: () => Promise<string>;
      setModel: (ref: string) => Promise<boolean>;
      setModelOverride: (providerId: string, modelId: string, patch: { contextWindow?: number; maxTokens?: number }) => Promise<boolean>;
      clearModelOverride: (providerId: string, modelId: string) => Promise<boolean>;
      syncModelMetadata: () => Promise<{ ok: boolean; count?: number; updatedAt?: number; error?: string }>;
      setProviderKey: (providerId: string, key: string) => Promise<boolean>;
      refreshModels: (providerId?: string) => Promise<{ provider: string; added?: number; error?: string }[]>;
      listCustomProviders: () => Promise<Record<string, CustomProvider>>;
      saveCustomProvider: (input: { id: string; name?: string; baseUrl: string; models: string[] }) => Promise<{ ok: boolean; id?: string; error?: string }>;
      removeCustomProvider: (id: string) => Promise<boolean>;
      setWebSearch: (patch: { enabled?: boolean; backend?: string; maxResults?: number }) => Promise<boolean>;
      testWebSearch: (query?: string) => Promise<WebSearchTestResult>;
      listSkills: () => Promise<SkillsPayload>;
      importSkill: () => Promise<SkillImportResult>;
      deleteSkill: (name: string) => Promise<SkillsPayload>;
      getDocSkills: (docId: string) => Promise<string[]>;
      setDocSkills: (docId: string, enabled: string[]) => Promise<boolean>;
      getSkillTrust: () => Promise<SkillTrustPayload>;
      setSkillTrust: (name: string, trusted: boolean) => Promise<string[]>;
      setSkillExecution: (enabled: boolean) => Promise<boolean>;
      getSkillRuntime: () => Promise<SkillRuntimeInfo>;
      onPermissionRequest: (cb: (req: PermissionRequest) => void) => () => void;
      replyPermission: (id: string, decision: PermissionDecision) => Promise<boolean>;
      ttsInfo: () => Promise<TtsInfo>;
      ttsVoices: () => Promise<{ groups: TtsVoiceGroup[] }>;
      ttsSynthesize: (req: TtsSynthesizeRequest) => Promise<TtsSynthesizeReply>;
      ttsSpeak: (req: TtsSynthesizeRequest) => Promise<TtsSynthesizeReply>;
      ttsModelsList: () => Promise<TtsModelsPayload>;
      ttsModelDownload: (id: string) => Promise<{ ok: boolean; message?: string }>;
      ttsModelCancel: (id: string) => Promise<boolean>;
      ttsModelRemove: (id: string) => Promise<boolean>;
      ttsModelActivate: (id: string) => Promise<boolean>;
      onTtsModelProgress: (cb: (p: TtsModelProgress) => void) => () => void;
      ttsCacheClear: () => Promise<{ freedBytes: number }>;
      ttsCacheSize: () => Promise<number>;
      getReading: (docId: string) => Promise<{ page: number | null; location: string | null }>;
      saveReading: (docId: string, patch: { page?: number; location?: string }) => Promise<void>;
      onChatDelta: (cb: (d: string) => void) => () => void;
      onChatReasoning: (cb: (d: string) => void) => () => void;
      onChatDone: (cb: (d: string) => void) => () => void;
      onChatNotice: (cb: (d: string) => void) => () => void;
      onChatUsage: (cb: (d: { used: number; max: number; model: string; estimated: boolean }) => void) => () => void;
      onToolCall: (cb: (d: unknown) => void) => () => void;
      onToolResult: (cb: (d: unknown) => void) => () => void;
      onMenuCommand: (cb: (cmd: string) => void) => () => void;
    };
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function App() {
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [openDocs, setOpenDocs] = useState<string[]>([]);
  const selectedDoc = docs.find((d) => d.id === selected) ?? null;
  const isEpub = selectedDoc?.ext === "epub";
  const [selection, setSelection] = useState<Selection | null>(null);
  const [ocrLang, setOcrLang] = useState("chi_sim+eng");
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [anns, setAnns] = useState<Annotation[]>([]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [page, setPage] = useState(1);
  const [gotoChapter, setGotoChapter] = useState<{ chapter: number; href?: string; label?: string; token: number } | null>(null);
  // Which outline row the user just jumped to. Several TOC entries can share a
  // spine chapter, so page equality alone highlights the first one (often the
  // previous chapter's tail) instead of the entry that was clicked.
  const [outlineFocus, setOutlineFocus] = useState<{ href: string; page: number } | null>(null);
  const outlineFocusRef = useRef<{ href: string; page: number; armed: boolean } | null>(null);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1.2);
  const [ocrJob, setOcrJob] = useState<{ running: boolean; page: number; total: number; progress: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [remoteDocs, setRemoteDocs] = useState<DocMeta[]>([]);
  const [libraryState, setLibraryState] = useState<SyncLibraryEntry[]>([]);
  const [syncRefresh, setSyncRefresh] = useState(0);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  // 菜单「新建对话」信号：递增 token，ChatPanel 监听后新建。
  const [newChatToken, setNewChatToken] = useState(0);
  // 菜单「导出对话」信号：同样用 token，避免把菜单事件直接耦合到 ChatPanel。
  const [exportChatToken, setExportChatToken] = useState(0);

  // shell layout state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<ActivityView>("explorer");
  const [chatOpen, setChatOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [chatWidth, setChatWidth] = useState(360);

  const annsRef = useRef<Annotation[]>([]);
  const selectedRef = useRef<string | null>(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const docsRef = useRef<DocMeta[]>([]);
  docsRef.current = docs;

  useEffect(() => { window.api.listLibrary().then(setDocs); }, []);

  // 状态栏的同步灯：订阅主进程推送，首次挂载主动拉一次
  useEffect(() => {
    void window.api.syncStatus().then(setSyncStatus).catch(() => {});
    return window.api.onSyncStatus(setSyncStatus);
  }, []);

  // 云端书目：只在「已配置且刚同步完」时刷新，避免每次渲染都打请求
  useEffect(() => {
    if (!syncStatus?.configured) {
      setRemoteDocs([]);
      setLibraryState([]);
      return;
    }
    let cancelled = false;
    void Promise.all([window.api.syncRemoteLibrary(), window.api.syncLibraryState()])
      .then(([books, states]) => {
        if (cancelled) return;
        setRemoteDocs(
          books
            .filter((book) => !book.local)
            .map((book) => ({ id: book.docId, title: book.title, ext: book.ext, cloud: true })),
        );
        setLibraryState(states);
      })
      .catch(() => {});
  }, [syncStatus?.configured, syncStatus?.lastSyncAt, syncRefresh]);

  /** 书库列表 = 本地书 + 只在云端的书（后者点开时先下载），并带上同步状态 */
  const libraryDocs = useMemo(
    () =>
      deriveShelfDocs({
        docs,
        remoteOnlyDocs: remoteDocs,
        libraryState,
        pendingDocs: syncStatus?.pending.docs ?? [],
      }),
    [docs, remoteDocs, libraryState, syncStatus?.pending.docs],
  );
  const loadSettings = useCallback(() => {
    window.api.getSettings().then((s) => {
      if (s.ocrLang) setOcrLang(s.ocrLang);
    }).catch(() => {});
  }, []);
  const loadAiConfig = useCallback(() => {
    window.api.getAiConfig().then(setAi).catch(() => {});
  }, []);
  useEffect(() => { loadSettings(); loadAiConfig(); }, [loadSettings, loadAiConfig]);

  useEffect(
    () =>
      window.api.onPermissionRequest((req) => {
        setPermission(req);
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setChatOpen((v) => !v);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!selected) {
      setTotal(0);
      setPage(1);
      setOutline([]);
      return;
    }
    const ext = docsRef.current.find((d) => d.id === selected)?.ext;
    // EPUB pages come from epub.js location generation (reported by the viewer),
    // so reset stale values from the previously opened document. PDFs resume
    // their own persisted page instead of inheriting the previous document's.
    setTotal(0);
    setOutline([]);
    // A pending citation / external jump belongs to the document it was made in.
    setSelection(null);
    setGotoChapter(null);
    outlineFocusRef.current = null;
    setOutlineFocus(null);
    setPage(ext === "epub" ? 1 : (loadReadingPage(selected) ?? 1));
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    window.api.getAnnotations(selected).then((a) => {
      annsRef.current = a;
      setAnns(a);
    });
  }, [selected]);

  // Keep a live mirror so async callbacks (e.g. rect OCR finishing later)
  // merge into the latest annotation list instead of a stale render closure.
  const persist = (next: Annotation[]) => {
    annsRef.current = next;
    setAnns(next);
    if (selectedRef.current) window.api.saveAnnotations(selectedRef.current, next);
  };
  const addAnn = (a: Annotation) => persist([...annsRef.current, a]);
  const updateAnn = (id: string, patch: Partial<Annotation>) => persist(annsRef.current.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const deleteAnn = (id: string) => persist(annsRef.current.filter((a) => a.id !== id));

  const importDoc = async () => {
    const d = await window.api.importDoc();
    if (d) {
      setDocs((x) => [...x, d]);
      openDoc(d.id);
    }
  };

  const openCloudDoc = async (id: string) => {
    const result = await window.api.syncBookDownload(id);
    if (!result.ok) {
      setSyncStatus(await window.api.syncStatus().catch(() => syncStatus));
      return;
    }
    const list = await window.api.listLibrary();
    setDocs(list);
    setRemoteDocs((prev) => prev.filter((entry) => entry.id !== id));
    setSyncRefresh((n) => n + 1);
    openDoc(id);
  };

  const deleteCloudDoc = async (doc: DocMeta) => {
    if (!confirm(`从云端删除《${doc.title}》？\n原书与笔记都会被删除，本地文件不受影响。`)) return;
    const result = await window.api.syncBookDelete(doc.id);
    if (!result.ok) {
      alert(`删除失败：${result.error.title}\n${result.error.detail}`);
      return;
    }
    setRemoteDocs((prev) => prev.filter((entry) => entry.id !== doc.id));
    setSyncRefresh((n) => n + 1);
  };

  const openDoc = (rawId: string) => {
    const id = rawId;
    if (remoteDocs.some((entry) => entry.id === id)) {
      void openCloudDoc(id);
      return;
    }
    return openDocLocal(id);
  };

  const openDocLocal = (id: string) => {
    setOpenDocs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSelected(id);
    // Reflect the stored reading position right away (the viewer restores it too).
    const ext = docs.find((d) => d.id === id)?.ext;
    if (ext !== "epub") setPage(loadReadingPage(id) ?? 1);
  };

  // 菜单命令（主进程 app:menu 事件）。用 ref 保存最新处理函数，订阅只建立一次，
  // 避免闭包里读到旧的 docs/selected。
  const menuHandlerRef = useRef<(cmd: string) => void>(() => {});
  useEffect(() => {
    menuHandlerRef.current = (cmd: string) => {
      if (cmd === "settings") setShowSettings(true);
      else if (cmd === "import") void importDoc();
      else if (cmd === "toggle-sidebar") setSidebarOpen((v) => !v);
      else if (cmd === "toggle-chat") setChatOpen((v) => !v);
      else if (cmd === "new-chat") setNewChatToken(Date.now());
      else if (cmd === "export-chat") {
        if (!selected) return;
        setChatOpen(true);
        setExportChatToken((value) => value + 1);
      }
    };
  });
  useEffect(() => window.api.onMenuCommand((cmd) => menuHandlerRef.current(cmd)), []);

  const closeTab = (id: string) => {
    const idx = openDocs.indexOf(id);
    const next = openDocs.filter((x) => x !== id);
    setOpenDocs(next);
    if (selected === id) setSelected(next[idx] ?? next[idx - 1] ?? null);
  };

  const removeDoc = async (d: DocMeta) => {
    if (!confirm(`删除《${d.title}》？\n本地副本、标注、对话与 OCR 缓存将一并删除，不可恢复。`)) return;
    try {
      await window.api.removeDoc(d.id);
    } catch (e) {
      alert(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setDocs((prev) => prev.filter((x) => x.id !== d.id));
    setOpenDocs((prev) => prev.filter((x) => x !== d.id));
    if (selectedRef.current === d.id) {
      annsRef.current = [];
      setAnns([]);
      setSelection(null);
      setPage(1);
      setSelected(null);
    }
  };

  const selectView = (view: ActivityView) => {
    if (sidebarOpen && sidebarView === view) setSidebarOpen(false);
    else {
      setSidebarView(view);
      setSidebarOpen(true);
    }
  };

  const openOutline = () => {
    setSidebarView("outline");
    setSidebarOpen(true);
  };

  // Drop the outline focus once navigation moves to another chapter. Arm it
  // only after the jump's own page update, otherwise setting it from the old
  // chapter would clear immediately.
  useEffect(() => {
    const focus = outlineFocusRef.current;
    if (!focus) return;
    if (!focus.armed) {
      if (page === focus.page) focus.armed = true;
      return;
    }
    if (page !== focus.page) {
      outlineFocusRef.current = null;
      setOutlineFocus(null);
    }
  }, [outlineFocus, page]);

  // Jump to a page (PDF) or chapter (EPUB) from annotations/search/outline.
  // EPUB outline entries can carry an exact `href#anchor`; keep it so a chapter
  // that starts mid-file lands on its heading instead of the file start.
  const jumpToLocator = (n: number, href?: string, label?: string) => {
    if (isEpub) {
      if (href) {
        const focus = { href, page: n, armed: false };
        outlineFocusRef.current = focus;
        setOutlineFocus({ href, page: n });
      } else {
        outlineFocusRef.current = null;
        setOutlineFocus(null);
      }
      setGotoChapter({ chapter: n, href, label, token: Date.now() });
    } else {
      setPage(n);
    }
  };

  const openDocList = openDocs
    .map((id) => docs.find((d) => d.id === id))
    .filter((d): d is DocMeta => Boolean(d));

  return (
    <div className="app">
      <TitleBar
        doc={selectedDoc}
        leftOpen={sidebarOpen}
        chatOpen={chatOpen}
        onToggleLeft={() => setSidebarOpen((v) => !v)}
        onToggleChat={() => setChatOpen((v) => !v)}
        onOpenSettings={() => setShowSettings(true)}
      />

      <div className="shell-body">
        <ActivityBar
          view={sidebarView}
          sidebarOpen={sidebarOpen}
          secondaryOpen={chatOpen}
          annotationCount={anns.length}
          onSelectView={selectView}
          onToggleChat={() => setChatOpen((v) => !v)}
          onOpenSettings={() => setShowSettings(true)}
        />

        {sidebarOpen && (
          <>
            <SideBar
              view={sidebarView}
              width={sidebarWidth}
              docs={libraryDocs}
              selectedId={selected}
              annotations={anns}
              outline={outline}
              page={page}
              isEpub={isEpub}
              onImport={importDoc}
              onOpenDoc={openDoc}
              onRemoveDoc={removeDoc}
              onJumpToPage={jumpToLocator}
              activeOutlineHref={outlineFocus?.href ?? null}
              onDeleteAnnotation={deleteAnn}
              onClearAnnotations={() => { if (confirm("清空当前文档的所有标注？")) persist([]); }}
            />
            <Resizer onResize={(dx) => setSidebarWidth((w) => clamp(w + dx, 180, 460))} />
          </>
        )}

        {/* The page fills the editor; the text column is centered INSIDE each
            page (see EpubViewer theme), so toggling a panel only changes the
            in-page margins — the columns themselves stay the same. */}
        <main className="editor">
          <EditorTabs
            docs={openDocList}
            activeId={selected}
            onActivate={setSelected}
            onClose={closeTab}
            actions={
              <>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setSelected(null)}
                  title="返回书架"
                >
                  <Icon name="library" size={15} />
                </button>
                <button type="button" className="icon-btn" onClick={importDoc} title="导入文档">
                  <Icon name="plus" size={15} />
                </button>
              </>
            }
          />

          {selected ? (
            isEpub ? (
              <EpubViewer
                docId={selected}
                annotations={anns}
                onAnnotationCreate={addAnn}
                onAnnotationDelete={deleteAnn}
                onPageChange={setPage}
                onTotalChange={setTotal}
                onOutlineChange={setOutline}
                goto={gotoChapter}
                onTextSelected={(t, p) => {
                  setSelection({ text: t, page: p, kind: "highlight" });
                  setChatOpen(true);
                }}
              />
            ) : (
              <PdfViewer
                key={selected}
                docId={selected}
                page={page}
                onPageChange={setPage}
                annotations={anns}
                ocrLang={ocrLang}
                onZoomChange={setZoom}
                onOcrJob={setOcrJob}
                onTotalChange={setTotal}
                onOutlineChange={setOutline}
                onOpenOutline={openOutline}
                onAnnotationCreate={(a) => {
                  addAnn(a);
                  if (a.text) setSelection({ text: a.text, page: a.page, kind: a.type === "highlight" ? "highlight" : "rect" });
                }}
                onAnnotationUpdate={updateAnn}
                onAnnotationDelete={deleteAnn}
                onRectSelect={(t, p, kind) => {
                  if (t) {
                    setSelection({ text: t, page: p, kind });
                    setChatOpen(true);
                  }
                }}
                onTextSelected={(t, p) => {
                  setSelection({ text: t, page: p, kind: "highlight" });
                  setChatOpen(true);
                }}
              />
            )
          ) : (
            <Bookshelf
              docs={libraryDocs}
              onOpen={openDoc}
              onImport={importDoc}
              onRemove={removeDoc}
              onDeleteCloud={deleteCloudDoc}
            />
          )}
        </main>

        {chatOpen && (
          <>
            <Resizer onResize={(dx) => setChatWidth((w) => clamp(w - dx, 280, 560))} />
            <aside className="secondary" style={{ width: chatWidth, flexBasis: chatWidth }}>
              <div className="secondary-header">
                <Icon name="sparkle" size={13} />
                <span>AI 对话</span>
                <span className="spacer" />
                <button type="button" className="icon-btn" onClick={() => setChatOpen(false)} title="收起对话">
                  <Icon name="close" size={14} />
                </button>
              </div>
              <ChatPanel
                selection={selection}
                docId={selected}
                docTitle={selectedDoc?.title ?? ""}
                page={page}
                isEpub={isEpub}
                annotations={anns}
                outline={outline}
                totalPages={total}
                contextWindow={ai?.models.find((m) => m.ref === ai.defaultModel)?.contextWindow}
                newChatToken={newChatToken}
                exportChatToken={exportChatToken}
              />
            </aside>
          </>
        )}
      </div>

      <StatusBar
        doc={selectedDoc}
        page={page}
        total={total}
        zoom={zoom}
        selectionLabel={selection?.text ? `${SELECTION_LABEL[selection.kind]} · ${isEpub ? `第${selection.page}章` : `P${selection.page}`}` : null}
        ocr={ocrJob}
        model={ai?.defaultModel ?? undefined}
        models={ai?.models ?? []}
        onSelectModel={(ref) => { window.api.setModel(ref).then(loadAiConfig).catch(() => {}); }}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
        sync={
          syncStatus
            ? {
                configured: syncStatus.configured,
                state: syncStatus.state,
                conflicts: syncStatus.conflicts.length,
                pending: (syncStatus.pending.settings ? 1 : 0) + syncStatus.pending.docs.length,
              }
            : undefined
        }
        onOpenSync={() => { setSettingsSection("sync"); setShowSettings(true); }}
      />

      {showSettings && (
        <Settings
          docId={selected}
          initialSection={settingsSection}
          onClose={() => {
            setShowSettings(false);
            setSettingsSection(undefined);
            // 设置页里可能传过原书 / 改过同步配置，回来时刷新书架的同步状态
            setSyncRefresh((n) => n + 1);
          }}
          onSaved={() => { loadSettings(); loadAiConfig(); }}
        />
      )}

      {permission && (
        <div className="modal-backdrop">
          {/* biome-ignore lint/a11y/useSemanticElements: custom modal surface */}
          <div className="modal" role="dialog" aria-modal="true" aria-label="执行确认">
            <div className="modal-header">
              <Icon name="settings" size={15} />
              <span className="modal-title">允许执行技能脚本？</span>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>技能</label>
                <div>{permission.skill}</div>
              </div>
              <div className="field">
                <label>即将执行的命令</label>
                <pre className="perm-command">{permission.command}</pre>
                <span className="hint">目录：{permission.cwd}</span>
              </div>
              <div className="hint">
                该命令以当前用户权限在本机运行，可读写文件与联网。请确认无误后再允许。
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => { window.api.replyPermission(permission.id, "deny"); setPermission(null); }}>
                拒绝
              </button>
              <button type="button" onClick={() => { window.api.replyPermission(permission.id, "once"); setPermission(null); }}>
                允许一次
              </button>
              <button type="button" className="primary" onClick={() => { window.api.replyPermission(permission.id, "always"); setPermission(null); }}>
                始终允许此技能
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
