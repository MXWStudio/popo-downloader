import { z } from "zod";

export const JOB_STATUSES = [
  "queued",
  "waiting_worker",
  "scanning",
  "scan_complete",
  "awaiting_confirmation",
  "starting",
  "downloading",
  "paused",
  "draining",
  "draining_paused",
  "complete",
  "cancelled",
  "failed"
] as const;

export const JobStatusSchema = z.enum(JOB_STATUSES);

const SettingsSchema = z.strictObject({
  formats: z.string().max(4096).optional(),
  includeKeywords: z.string().max(4096).optional(),
  excludeKeywords: z.string().max(4096).optional(),
  downloadRoot: z.string().max(1024).optional(),
  gopeedEndpoint: z.string().max(2048).optional(),
  gopeedToken: z.string().max(4096).optional(),
  gopeedDownloadDirOverride: z.string().max(32768).optional(),
  concurrency: z.number().int().min(1).max(5).optional(),
  gopeedConnections: z.number().int().min(1).max(16).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  recursive: z.boolean().optional(),
  preserveStructure: z.boolean().optional(),
  timeouts: z.record(z.string(), z.number().int().min(100).max(86_400_000)).optional()
});

const SimpleCommandSchema = z.strictObject({
  type: z.enum([
    "GET_STATE",
    "CHECK_GOPEED",
    "CANCEL_FOLDER_TASK",
    "START_DOWNLOAD",
    "PAUSE",
    "RESUME",
    "SNOOZE_NETWORK_REMINDER",
    "MUTE_NETWORK_REMINDER_TODAY",
    "CANCEL",
    "RETRY_FAILED",
    "RESET"
  ])
});

const JobCommandSchema = z.union([
  z.strictObject({
    type: z.enum(["CANCEL_JOB", "RETRY_JOB", "DISMISS_JOB"]),
    jobId: z.string().min(1).max(200)
  }),
  z.strictObject({
    type: z.literal("RESTORE_CANCELLED_JOB"),
    jobId: z.string().min(1).max(200),
    sourceTabId: z.number().int().nonnegative().optional()
  })
]);

export const RuntimeCommandSchema = z.union([
  SimpleCommandSchema,
  JobCommandSchema,
  z.strictObject({
    type: z.literal("SAVE_GOPEED_SETTINGS"),
    gopeedEndpoint: z.string().max(2048),
    gopeedToken: z.string().max(4096),
    gopeedDownloadDirOverride: z.string().max(32768)
  }),
  z.strictObject({
    type: z.literal("CHOOSE_DOWNLOAD_DIRECTORY"),
    initialPath: z.string().max(32768)
  }),
  z.strictObject({
    type: z.literal("SET_DOWNLOAD_CONCURRENCY"),
    concurrency: z.number().int().min(1).max(5)
  }),
  z.strictObject({ type: z.literal("SAVE_SETTINGS"), settings: SettingsSchema }),
  z.strictObject({
    type: z.literal("START_SCAN"),
    url: z.url({ protocol: /^https$/, hostname: /^docs\.popo\.netease\.com$/ }),
    settings: SettingsSchema
  }),
  z.strictObject({
    type: z.literal("START_FOLDER_SCAN"),
    folderName: z.string().min(1).max(1024),
    folderItemIndex: z.string().min(1).max(200),
    parentUrl: z.url({ protocol: /^https$/, hostname: /^docs\.popo\.netease\.com$/ })
  }),
  z.strictObject({
    type: z.enum(["SOURCE_PAGE_READY", "REGISTER_WORKER_FRAME"]),
    url: z.url({ protocol: /^https$/, hostname: /^docs\.popo\.netease\.com$/ })
  })
]);

const GopeedLabelsSchema = z.record(z.string().min(1).max(128), z.string().max(4096));

const GopeedProgressSchema = z.looseObject({
  used: z.number().finite().nonnegative().optional(),
  speed: z.number().finite().nonnegative().optional(),
  downloaded: z.number().finite().nonnegative().optional(),
  uploadSpeed: z.number().finite().nonnegative().optional(),
  uploaded: z.number().finite().nonnegative().optional()
});

export const GopeedTaskSchema = z.looseObject({
  id: z.string().min(1).max(512),
  status: z.enum(["ready", "running", "pause", "wait", "error", "done"]),
  name: z.string().max(32768).optional(),
  size: z.number().finite().nonnegative().optional(),
  progress: GopeedProgressSchema.optional(),
  meta: z.looseObject({
    req: z.looseObject({
      url: z.string().max(131072).optional(),
      labels: GopeedLabelsSchema.optional()
    }).optional(),
    res: z.looseObject({
      files: z.array(z.looseObject({
        name: z.string().max(32768),
        path: z.string().max(32768).optional(),
        size: z.number().finite().nonnegative().optional()
      })).optional()
    }).optional(),
    opts: z.looseObject({
      name: z.string().max(32768).optional(),
      path: z.string().max(32768).optional()
    }).optional()
  }).optional()
});

export const GopeedTaskListSchema = z.array(GopeedTaskSchema);
export const GopeedTaskIdSchema = z.string().min(1).max(512);

export const QueueJobSchema = z.looseObject({
  id: z.string().min(1).max(200),
  status: JobStatusSchema,
  createdAt: z.string().max(100).optional(),
  updatedAt: z.string().max(100).optional(),
  counts: z.looseObject({
    total: z.number().int().nonnegative().optional(),
    pending: z.number().int().nonnegative().optional(),
    success: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    cancelled: z.number().int().nonnegative().optional()
  }).optional()
});

export function parseRuntimeCommand(value: unknown) {
  return RuntimeCommandSchema.parse(value);
}

export function parseGopeedTask(value: unknown) {
  return GopeedTaskSchema.parse(value);
}

export function parseGopeedTasks(value: unknown) {
  return GopeedTaskListSchema.parse(value);
}

export function parseGopeedTaskId(value: unknown) {
  return GopeedTaskIdSchema.parse(value);
}

export function sanitizeStoredJobs(value: unknown) {
  if (!Array.isArray(value)) return { jobs: [], rejected: 0 };
  const jobs: Array<z.infer<typeof QueueJobSchema>> = [];
  let rejected = 0;
  for (const candidate of value) {
    const result = QueueJobSchema.safeParse(candidate);
    if (result.success) jobs.push(result.data);
    else rejected += 1;
  }
  return { jobs, rejected };
}

export function contractErrorMessage(error: unknown) {
  if (!(error instanceof z.ZodError)) return String(error || "未知数据错误");
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("；");
}
