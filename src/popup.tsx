import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  attentionJobs,
  completedJobs,
  failedRetryCount,
  jobDetail,
  jobIsActive,
  jobName,
  jobProgress,
  liveJobs,
  MODE_LABELS,
  modeBadgeLabel,
  recoverableCount,
  summarizeLiveJobs,
  userFacingError,
  type GopeedConnection,
  type GopeedSettings,
  type QueueJob,
  type QueueState
} from "./ui-model";

interface StateResponse {
  state: QueueState;
  settings: GopeedSettings;
}

interface GopeedResponse {
  connection: GopeedConnection;
  settings: GopeedSettings;
}

interface PopupErrorState {
  message: string;
  transient: boolean;
}

async function callExtension<T extends object = Record<string, never>>(
  message: Record<string, unknown>
): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as T & {
    ok?: boolean;
    error?: string;
  };
  if (!response?.ok) throw new Error(response?.error || "扩展后台未响应");
  return response;
}

async function currentPopoTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((candidate) =>
    /^https:\/\/docs\.popo\.netease\.com\/team\/pc\/[^/]+\/pageDetail\/[a-z0-9]+/i
      .test(candidate.url || "")
  );
  return Number.isInteger(tab?.id) ? tab?.id || null : null;
}

function usePopupPresence(): void {
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: "popo-popup-ui" });
    } catch (error) {
      console.warn("无法同步弹窗显示状态", error);
    }
    return () => {
      try {
        port?.disconnect();
      } catch {
        // Extension reloads can invalidate the port before React unmounts.
      }
    };
  }, []);
}

function usePopupState() {
  const [state, setState] = useState<QueueState>({ jobs: [] });
  const [settings, setSettings] = useState<GopeedSettings>({});
  const [connection, setConnection] = useState<GopeedConnection | null>(null);
  const [error, setError] = useState<PopupErrorState | null>(null);
  const gopeedCheckAt = useRef(0);
  const gopeedChecking = useRef(false);

  const refreshGopeed = useCallback(async (force = false) => {
    if (
      gopeedChecking.current ||
      (!force && Date.now() - gopeedCheckAt.current < 5000)
    ) {
      return;
    }
    gopeedChecking.current = true;
    gopeedCheckAt.current = Date.now();
    try {
      const response = await callExtension<GopeedResponse>({ type: "CHECK_GOPEED" });
      setConnection(response.connection);
      setSettings(response.settings || {});
    } catch (caught) {
      setConnection({
        connected: false,
        error: String(caught instanceof Error ? caught.message : caught)
      });
    } finally {
      gopeedChecking.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await callExtension<StateResponse>({ type: "GET_STATE" });
      setState(response.state || { jobs: [] });
      setSettings(response.settings || {});
      setError((current) => current?.transient ? null : current);
      void refreshGopeed();
    } catch (caught) {
      console.warn("读取扩展状态失败", caught);
      setError({
        message: "暂时无法读取任务，请重新打开扩展。",
        transient: true
      });
    }
  }, [refreshGopeed]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return {
    state,
    settings,
    connection,
    error,
    setError,
    setSettings,
    setConnection,
    refresh,
    refreshGopeed
  };
}

function PopupProgress({ job }: { job: QueueJob }) {
  const percent = jobProgress(job);
  return (
    <div
      className="popup-job-progress"
      data-indeterminate={percent == null ? "true" : undefined}
      role="progressbar"
      aria-label={jobName(job) + " 下载进度"}
      aria-valuemin={percent == null ? undefined : 0}
      aria-valuemax={percent == null ? undefined : 100}
      aria-valuenow={percent == null ? undefined : percent}
    >
      <i style={percent == null ? undefined : { width: percent + "%" }} />
    </div>
  );
}

function TaskCard({
  job,
  activeJobId,
  refresh,
  showError
}: {
  job: QueueJob;
  activeJobId: string | null;
  refresh: () => Promise<void>;
  showError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmingDismiss, setConfirmingDismiss] = useState(false);

  const run = async (message: Record<string, unknown>) => {
    setBusy(true);
    try {
      await callExtension(message);
      setConfirmingDismiss(false);
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    try {
      const sourceTabId = await currentPopoTabId();
      const message: Record<string, unknown> = {
        type: "RESTORE_CANCELLED_JOB",
        jobId: job.id
      };
      if (sourceTabId != null) message.sourceTabId = sourceTabId;
      await run(message);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <article className="popup-queue-item" data-status={job.status}>
      <div className="popup-queue-title">
        <strong className="popup-queue-name" title={jobName(job)}>
          {jobName(job)}
        </strong>
        <span className="popup-queue-status">{MODE_LABELS[job.status]}</span>
      </div>
      <div className="popup-queue-meta">{jobDetail(job)}</div>
      {job.status !== "queued" && <PopupProgress job={job} />}
      {!confirmingDismiss ? (
        <div className="popup-queue-actions">
          {job.id === activeJobId && job.status === "downloading" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run({ type: "PAUSE" })}
            >
              暂停
            </button>
          )}
          {job.id === activeJobId && ["paused", "draining_paused"].includes(job.status) && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run({ type: "RESUME" })}
            >
              继续
            </button>
          )}
          {jobIsActive(job) && !job.cancelRequested && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void run({ type: "CANCEL_JOB", jobId: job.id })}
            >
              停止后续下载
            </button>
          )}
          {job.status === "cancelled" && recoverableCount(job) > 0 && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void restore()}
            >
              继续（{recoverableCount(job)}）
            </button>
          )}
          {job.status === "failed" && failedRetryCount(job) > 0 && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run({ type: "RETRY_JOB", jobId: job.id })}
            >
              重试（{failedRetryCount(job)}）
            </button>
          )}
          {!jobIsActive(job) && (
            <button
              type="button"
              className="remove"
              disabled={busy}
              onClick={() => setConfirmingDismiss(true)}
            >
              移除
            </button>
          )}
        </div>
      ) : (
        <div
          className="popup-remove-confirmation"
          role="group"
          aria-label="确认移除任务"
        >
          <p className="popup-remove-note">只从列表移除，不会删除已下载文件。</p>
          <div className="popup-queue-actions">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void run({ type: "DISMISS_JOB", jobId: job.id })}
            >
              确认移除
            </button>
            <button
              type="button"
              className="remove"
              disabled={busy}
              onClick={() => setConfirmingDismiss(false)}
            >
              返回
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function TaskSection({
  title,
  jobs,
  activeJobId,
  refresh,
  showError
}: {
  title: string;
  jobs: QueueJob[];
  activeJobId: string | null;
  refresh: () => Promise<void>;
  showError: (error: unknown) => void;
}) {
  if (!jobs.length) return null;
  return (
    <section className="popup-task-section">
      <h2>{title}</h2>
      {jobs.map((job) => (
        <TaskCard
          key={job.id}
          job={job}
          activeJobId={activeJobId}
          refresh={refresh}
          showError={showError}
        />
      ))}
    </section>
  );
}

function ServiceSettings({
  connection,
  settings,
  refreshGopeed,
  setConnection,
  setSettings,
  showError
}: {
  connection: GopeedConnection | null;
  settings: GopeedSettings;
  refreshGopeed: (force?: boolean) => Promise<void>;
  setConnection: (connection: GopeedConnection) => void;
  setSettings: (settings: GopeedSettings) => void;
  showError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const selectedPath = String(settings.gopeedDownloadDirOverride || "").trim();
  const status = connection == null
    ? { label: "检查中", state: "checking" }
    : connection.connected
      ? { label: "可用", state: "connected" }
      : { label: "暂不可用", state: "disconnected" };

  const chooseDirectory = async () => {
    setBusy(true);
    try {
      const response = await callExtension<GopeedResponse & { cancelled?: boolean }>({
        type: "CHOOSE_DOWNLOAD_DIRECTORY",
        initialPath: selectedPath
      });
      if (response.cancelled) {
        await refreshGopeed(true);
      } else {
        setSettings(response.settings || {});
        setConnection(response.connection);
      }
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const clearDirectory = async () => {
    setBusy(true);
    try {
      const response = await callExtension<GopeedResponse>({
        type: "SAVE_GOPEED_SETTINGS",
        gopeedEndpoint: settings.gopeedEndpoint || "http://127.0.0.1:9999",
        gopeedToken: settings.gopeedToken || "",
        gopeedDownloadDirOverride: ""
      });
      setSettings(response.settings || {});
      setConnection(response.connection);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="engine-card" data-connected={connection?.connected ? "true" : "false"}>
      {connection?.connected === false && (
        <div className="engine-alert" role="alert">
          <div className="engine-heading">
            <strong>下载服务需要处理</strong>
            <span className="engine-status" data-state="disconnected">不可用</span>
          </div>
          <p>请检查设置，恢复后可以继续下载。</p>
        </div>
      )}
      <details className="engine-settings" open={connection?.connected === false}>
        <summary>设置</summary>
        <div className="engine-settings-body">
          <div className="engine-heading">
            <strong>下载服务</strong>
            <span id="gopeedStatus" className="engine-status" data-state={status.state}>
              {status.label}
            </span>
          </div>
          <p id="gopeedDetail">
            {connection == null
              ? "正在检查。"
              : connection.connected
                ? "运行正常。"
                : "正在恢复，请稍后再试。"}
          </p>
          <div className="folder-picker-setting">
            <span>保存位置</span>
            <output
              id="gopeedDownloadDirOverride"
              data-path={selectedPath}
              title={selectedPath}
            >
              {selectedPath || "默认下载文件夹"}
            </output>
            <div className="folder-picker-actions">
              <button
                id="chooseDownloadDirectoryButton"
                type="button"
                disabled={busy}
                onClick={() => void chooseDirectory()}
              >
                选择位置
              </button>
              <button
                id="clearDownloadDirectoryButton"
                type="button"
                disabled={busy || !selectedPath}
                onClick={() => void clearDirectory()}
              >
                使用默认
              </button>
            </div>
          </div>
        </div>
      </details>
    </section>
  );
}

function PopupApp() {
  usePopupPresence();
  const {
    state,
    settings,
    connection,
    error,
    setError,
    setSettings,
    setConnection,
    refresh,
    refreshGopeed
  } = usePopupState();
  const active = useMemo(() => liveJobs(state), [state]);
  const attention = useMemo(() => attentionJobs(state), [state]);
  const completed = useMemo(() => completedJobs(state).slice(0, 3), [state]);
  const hasOpenTasks = active.length > 0 || attention.length > 0;
  const version = chrome.runtime.getManifest().version_name ||
    chrome.runtime.getManifest().version;

  const showError = useCallback((caught: unknown) => {
    console.warn("扩展操作失败", caught);
    setError({ message: userFacingError(caught), transient: false });
  }, [setError]);

  return (
    <main>
      <header>
        <div className="brand">
          <img
            className="brand-logo"
            src="assets/popo-logo.svg"
            alt=""
            width="36"
            height="36"
          />
          <div>
            <p className="eyebrow">POPO 下载</p>
            <h1>稳定下载助手</h1>
          </div>
        </div>
        {!hasOpenTasks && (
          <span id="modeBadge" className="badge" data-state={modeBadgeLabel(state)}>
            {modeBadgeLabel(state)}
          </span>
        )}
      </header>

      {!hasOpenTasks && (
        <section id="idleCard" className="instruction">
          <span className="download-mark">⇩</span>
          <div>
            <strong>选择要下载的文件夹</strong>
            <p>在 POPO 中，点击文件夹旁的蓝色下载按钮。</p>
          </div>
        </section>
      )}

      {hasOpenTasks && (
        <section id="taskCard" className="task-card">
          <div className="queue-heading">
            <strong>下载任务</strong>
            <span id="queueSummary">{summarizeLiveJobs(active)}</span>
          </div>
          <div id="popupQueueList" className="popup-queue-list">
            <TaskSection
              title="进行中"
              jobs={active}
              activeJobId={state.activeJobId || null}
              refresh={refresh}
              showError={showError}
            />
            <TaskSection
              title="需要处理"
              jobs={attention}
              activeJobId={state.activeJobId || null}
              refresh={refresh}
              showError={showError}
            />
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <details className="recent-completed">
          <summary>最近完成（{completed.length}）</summary>
          <div className="popup-queue-list">
            <TaskSection
              title="最近完成"
              jobs={completed}
              activeJobId={state.activeJobId || null}
              refresh={refresh}
              showError={showError}
            />
          </div>
        </details>
      )}

      <ServiceSettings
        connection={connection}
        settings={settings}
        refreshGopeed={refreshGopeed}
        setConnection={setConnection}
        setSettings={setSettings}
        showError={showError}
      />

      <p id="errorBox" className="error" hidden={!error}>
        {error?.message || ""}
      </p>
      <footer id="versionInfo">版本 {version}</footer>
    </main>
  );
}

const rootElement = document.getElementById("popup-root");
if (!rootElement) throw new Error("Popup React root was not found");
createRoot(rootElement).render(<PopupApp />);
