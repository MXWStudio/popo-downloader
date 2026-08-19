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
  networkHealthSummary,
  recoverableCount,
  summarizeLiveJobs,
  userFacingError,
  type GopeedConnection,
  type GopeedSettings,
  type NetworkHealth,
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

interface ConcurrencyResponse {
  state: QueueState;
  settings: GopeedSettings;
}

interface PopupErrorState {
  message: string;
  transient: boolean;
}

interface UpdateStatus {
  state: string;
  currentVersion: string;
  targetVersion: string;
  message: string;
  updatedAt: string;
}

interface UpdateStatusResponse {
  updateStatus: UpdateStatus;
}

interface UpdateDiagnosticsResponse {
  diagnostics: Record<string, unknown>;
}

interface DiagnosticStatus {
  configured: boolean;
  provider: string;
  host: string;
  pendingCount: number;
  lastSentAt: string;
  lastAttemptAt: string;
  lastError: string;
  sent?: number;
}

interface DiagnosticStatusResponse {
  diagnosticStatus: DiagnosticStatus;
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

function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await callExtension<UpdateStatusResponse>({
          type: "GET_UPDATE_STATUS"
        });
        if (!disposed) setStatus(response.updateStatus || null);
      } catch {
        // Update status is supplemental and must not block task controls.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);
  return status;
}

function updateStatusLabel(status: UpdateStatus | null): string {
  if (!status) return "";
  if (["starting", "checking", "downloading", "installing"].includes(status.state)) {
    return status.targetVersion ? ` · 正在更新到 ${status.targetVersion}` : " · 正在检查更新";
  }
  if (status.state === "deferred") return " · 更新已延后";
  if (status.state === "failed") return " · 更新检查失败";
  return "";
}

function UpdateDiagnosticsCard({
  showError
}: {
  showError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<DiagnosticStatus | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await callExtension<DiagnosticStatusResponse>({
        type: "GET_DIAGNOSTIC_STATUS"
      });
      setStatus(response.diagnosticStatus);
    } catch (error) {
      console.warn("读取诊断回传状态失败", error);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const copyDiagnostics = async () => {
    setBusy(true);
    try {
      const response = await callExtension<UpdateDiagnosticsResponse>({
        type: "GET_UPDATE_DIAGNOSTICS"
      });
      await navigator.clipboard.writeText(JSON.stringify(response.diagnostics, null, 2));
      setCopied(true);
    } catch (error) {
      setCopied(false);
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const sendDiagnostics = async () => {
    setBusy(true);
    try {
      const response = await callExtension<DiagnosticStatusResponse>({
        type: "SEND_DIAGNOSTICS"
      });
      setStatus(response.diagnosticStatus);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const statusText = !status
    ? "正在读取诊断状态"
    : status.configured
      ? status.pendingCount > 0
        ? `待发送 ${status.pendingCount} 条`
        : status.lastSentAt
          ? "最近诊断已发送"
          : "自动回传已启用"
      : status.pendingCount > 0
        ? `接收地址待配置，本机已保存 ${status.pendingCount} 条`
        : "接收地址待配置，错误会先保存在本机";

  return (
    <details className="update-diagnostics">
      <summary>诊断与回传</summary>
      <div className="engine-settings-body">
        <p>批量下载停滞、任务丢失和后台异常会自动脱敏并保存；断网时排队，恢复后重试。</p>
        <p className="diagnostic-status" data-configured={status?.configured ? "true" : "false"}>
          {statusText}
        </p>
        {status?.lastError && <p className="diagnostic-error">最近发送：{status.lastError}</p>}
        <div className="diagnostic-actions">
          <button
            id="sendDiagnosticsButton"
            type="button"
            disabled={busy}
            onClick={() => void sendDiagnostics()}
          >
            {busy ? "正在处理" : "立即发送诊断"}
          </button>
          <button
            id="copyUpdateDiagnosticsButton"
            type="button"
            disabled={busy}
            onClick={() => void copyDiagnostics()}
          >
            {copied ? "已复制" : "复制诊断信息"}
          </button>
        </div>
      </div>
    </details>
  );
}

function NetworkNoticeCard({
  health,
  refresh,
  showError
}: {
  health: NetworkHealth;
  refresh: () => Promise<void>;
  showError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (type: "SNOOZE_NETWORK_REMINDER" | "MUTE_NETWORK_REMINDER_TODAY") => {
    setBusy(true);
    try {
      await callExtension({ type });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  const label = health.status === "severe"
    ? "严重低速"
    : health.status === "slow"
      ? "速度偏低"
      : "高发时段";

  return (
    <section className="network-notice-card" role="status">
      <div className="engine-heading">
        <strong>本地网络提醒</strong>
        <span>{label}</span>
      </div>
      <p>{networkHealthSummary(health)}。下载仍在继续，与代理设置无关。</p>
      <div className="popup-queue-actions">
        <button type="button" disabled={busy} onClick={() => void run("SNOOZE_NETWORK_REMINDER")}>
          15 分钟后提醒
        </button>
        <button type="button" disabled={busy} onClick={() => void run("MUTE_NETWORK_REMINDER_TODAY")}>
          今日不再提醒
        </button>
      </div>
    </section>
  );
}

function ServiceSettings({
  connection,
  settings,
  concurrencyLocked,
  refreshGopeed,
  setConnection,
  setSettings,
  showError
}: {
  connection: GopeedConnection | null;
  settings: GopeedSettings;
  concurrencyLocked: boolean;
  refreshGopeed: (force?: boolean) => Promise<void>;
  setConnection: (connection: GopeedConnection) => void;
  setSettings: (settings: GopeedSettings) => void;
  showError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const selectedPath = String(settings.gopeedDownloadDirOverride || "").trim();
  const concurrency = Math.min(5, Math.max(1, Number(settings.concurrency) || 5));
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

  const saveConcurrency = async (value: number) => {
    setBusy(true);
    try {
      const response = await callExtension<ConcurrencyResponse>({
        type: "SET_DOWNLOAD_CONCURRENCY",
        concurrency: value
      });
      setSettings(response.settings || {});
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
          <div className="concurrency-setting">
            <label htmlFor="downloadConcurrency">并行下载数</label>
            <select
              id="downloadConcurrency"
              value={concurrency}
              disabled={busy || concurrencyLocked}
              title={concurrencyLocked ? "任务进行或暂停时不能调整并行下载数" : undefined}
              onChange={(event) => void saveConcurrency(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
            <p>{concurrencyLocked
              ? "任务进行或暂停时保持当前并行数，全部结束后才可调整。"
              : "同时下载的文件数量，最高 5。"}</p>
          </div>
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
  const updateStatus = useUpdateStatus();
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
  const networkHealth = state.networkHealth;
  const showNetworkNotice = Boolean(
    hasOpenTasks &&
    networkHealth &&
    !networkHealth.suppressed &&
    networkHealth.activeTasks > 0 &&
    (networkHealth.highProbabilityWindow || ["slow", "severe"].includes(networkHealth.status))
  );
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
          {showNetworkNotice && networkHealth && (
            <NetworkNoticeCard health={networkHealth} refresh={refresh} showError={showError} />
          )}
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
        concurrencyLocked={active.length > 0}
        refreshGopeed={refreshGopeed}
        setConnection={setConnection}
        setSettings={setSettings}
        showError={showError}
      />

      <UpdateDiagnosticsCard showError={showError} />

      <p id="errorBox" className="error" hidden={!error}>
        {error?.message || ""}
      </p>
      <footer id="versionInfo" title={updateStatus?.message || ""}>
        版本 {version}{updateStatusLabel(updateStatus)}
      </footer>
    </main>
  );
}

const rootElement = document.getElementById("popup-root");
if (!rootElement) throw new Error("Popup React root was not found");
createRoot(rootElement).render(<PopupApp />);
