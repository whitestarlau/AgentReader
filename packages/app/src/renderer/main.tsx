import { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { PdfViewer } from "./components/PdfViewer.tsx";
import { EpubViewer } from "./components/EpubViewer.tsx";
import { ChatPanel } from "./components/ChatPanel.tsx";
import { type Annotation } from "./components/AnnotationLayer.tsx";
import { type Selection, SELECTION_LABEL } from "./selection.ts";
import { loadReadingPage } from "./reading.ts";
import { Settings } from "./components/Settings.tsx";
import { Icon } from "./components/Icons.tsx";
import { TitleBar } from "./components/shell/TitleBar.tsx";
import { ActivityBar } from "./components/shell/ActivityBar.tsx";
import { SideBar } from "./components/shell/SideBar.tsx";
import { EditorTabs } from "./components/shell/EditorTabs.tsx";
import { StatusBar } from "./components/shell/StatusBar.tsx";
import { Welcome } from "./components/shell/Welcome.tsx";
import { Resizer } from "./components/shell/Resizer.tsx";
import type {
  ActivityView,
  AiConfig,
  CustomProvider,
  DocMeta,
  PermissionDecision,
  PermissionRequest,
  SkillImportResult,
  SkillRuntimeInfo,
  SkillsPayload,
  SkillTrustPayload,
  WebSearchTestResult,
} from "./types.ts";
import "./styles.css";

declare global {
  interface Window {
    api: {
      listLibrary: () => Promise<DocMeta[]>;
      importDoc: () => Promise<DocMeta | null>;
      removeDoc: (id: string) => Promise<boolean>;
      getAnnotations: (id: string) => Promise<Annotation[]>;
      saveAnnotations: (id: string, data: unknown) => Promise<void>;
      getOcr: (id: string) => Promise<Record<string, string>>;
      saveOcr: (id: string, page: number, text: string) => Promise<void>;
      getDocPath: (id: string) => Promise<string | null>;
      readFile: (path: string) => Promise<Uint8Array>;
      chat: (docId: string, convId: string, prompt: string, history: unknown, page?: number, persistUser?: boolean) => Promise<{ ok?: boolean; error?: string; content?: string; title?: string; userId?: string }>;
      stopChat: (docId: string, convId: string) => Promise<boolean>;
      editChat: (docId: string, convId: string, messageId: string, content: string) => Promise<{ ok: boolean; error?: string; rows?: unknown[] }>;
      getChats: (docId: string, convId: string) => Promise<{ role: string; content: string }[]>;
      appendChat: (docId: string, convId: string, e: unknown) => Promise<void>;
      listConversations: (docId: string) => Promise<{ id: string; title: string }[]>;
      createConversation: (docId: string, title?: string) => Promise<{ id: string; title: string }>;
      deleteConversation: (docId: string, convId: string) => Promise<unknown>;
      renameConversation: (docId: string, convId: string, title: string) => Promise<unknown>;
      getSettings: () => Promise<Record<string, string>>;
      saveSettings: (s: unknown) => Promise<void>;
      getAiConfig: () => Promise<AiConfig>;
      saveAiConfig: (text: string) => Promise<{ ok: boolean; errors: string[] }>;
      openAiConfig: () => Promise<string>;
      setModel: (ref: string) => Promise<boolean>;
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
      getReading: (docId: string) => Promise<{ page: number | null; location: string | null }>;
      saveReading: (docId: string, patch: { page?: number; location?: string }) => Promise<void>;
      onChatDelta: (cb: (d: string) => void) => () => void;
      onChatReasoning: (cb: (d: string) => void) => () => void;
      onChatDone: (cb: (d: string) => void) => () => void;
      onToolCall: (cb: (d: unknown) => void) => () => void;
      onToolResult: (cb: (d: unknown) => void) => () => void;
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
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [zoom, setZoom] = useState(1.2);
  const [ocrJob, setOcrJob] = useState<{ running: boolean; page: number; total: number; progress: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);

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
      return;
    }
    const ext = docsRef.current.find((d) => d.id === selected)?.ext;
    // EPUB pages come from epub.js location generation (reported by the viewer),
    // so reset stale values from the previously opened document.
    if (ext === "epub") setPage(1);
    setTotal(0);
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

  const openDoc = (id: string) => {
    setOpenDocs((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setSelected(id);
    // Reflect the stored reading position right away (the viewer restores it too).
    const ext = docs.find((d) => d.id === id)?.ext;
    if (ext !== "epub") {
      const saved = loadReadingPage(id);
      if (saved) setPage(saved);
    }
  };

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

  const onTextSelected = (t: string, p: number, r?: Annotation["rect"]) => {
    setSelection({ text: t, page: p, kind: "highlight" });
    setPage(p);
    if (t) {
      addAnn({ id: crypto.randomUUID(), page: p, type: "highlight", rect: r ?? { x: 0, y: 0.2, w: 1, h: 0.05 }, text: t, color: "#ffeb3b88" });
      setChatOpen(true);
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
              docs={docs}
              selectedId={selected}
              annotations={anns}
              page={page}
              onImport={importDoc}
              onOpenDoc={openDoc}
              onRemoveDoc={removeDoc}
              onJumpToPage={setPage}
              onDeleteAnnotation={deleteAnn}
              onClearAnnotations={() => { if (confirm("清空当前文档的所有标注？")) persist([]); }}
            />
            <Resizer onResize={(dx) => setSidebarWidth((w) => clamp(w + dx, 180, 460))} />
          </>
        )}

        <main className="editor">
          <EditorTabs
            docs={openDocList}
            activeId={selected}
            onActivate={setSelected}
            onClose={closeTab}
            actions={
              <>
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
                onPageChange={setPage}
                onTotalChange={setTotal}
                onTextSelected={(t) => {
                  setSelection({ text: t, page, kind: "highlight" });
                  setChatOpen(true);
                }}
              />
            ) : (
              <PdfViewer
                docId={selected}
                page={page}
                onPageChange={setPage}
                annotations={anns}
                ocrLang={ocrLang}
                onZoomChange={setZoom}
                onOcrJob={setOcrJob}
                onTotalChange={setTotal}
                onAnnotationCreate={(a) => {
                  addAnn(a);
                  if (a.text) setSelection({ text: a.text, page: a.page, kind: "rect" });
                }}
                onAnnotationUpdate={updateAnn}
                onAnnotationDelete={deleteAnn}
                onRectSelect={(t, p, kind) => {
                  if (t) {
                    setSelection({ text: t, page: p, kind });
                    setChatOpen(true);
                  }
                }}
                onTextSelected={onTextSelected}
              />
            )
          ) : (
            <Welcome docs={docs} onOpenDoc={openDoc} onImport={importDoc} onOpenSettings={() => setShowSettings(true)} />
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
              <ChatPanel selection={selection} docId={selected} page={page} />
            </aside>
          </>
        )}
      </div>

      <StatusBar
        doc={selectedDoc}
        page={page}
        total={total}
        zoom={zoom}
        selectionLabel={selection?.text ? `${SELECTION_LABEL[selection.kind]} · P${selection.page}` : null}
        ocr={ocrJob}
        model={ai?.defaultModel ?? undefined}
        models={ai?.models ?? []}
        onSelectModel={(ref) => { window.api.setModel(ref).then(loadAiConfig).catch(() => {}); }}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((v) => !v)}
      />

      {showSettings && <Settings docId={selected} onClose={() => setShowSettings(false)} onSaved={() => { loadSettings(); loadAiConfig(); }} />}

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
