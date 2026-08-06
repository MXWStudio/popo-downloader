import { ApiError, Client } from "@gopeed/rest";
import {
  contractErrorMessage,
  parseGopeedTask,
  parseGopeedTaskId,
  parseGopeedTasks
} from "./contracts";

export interface GopeedSettings {
  gopeedEndpoint?: string;
  gopeedToken?: string;
}

export interface GopeedSdkOptions {
  timeoutMs?: number;
}

function clientFor(settings: GopeedSettings) {
  return new Client({
    host: String(settings?.gopeedEndpoint || "http://127.0.0.1:9999").replace(/\/+$/, ""),
    token: String(settings?.gopeedToken || "").trim()
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Gopeed SDK 请求超时（${timeoutMs}ms）`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeSdkError(error: unknown): Error {
  if (error instanceof ApiError) {
    const wrapped = new Error(error.msg || error.message || "Gopeed SDK 请求失败");
    Object.assign(wrapped, { name: "GopeedSdkError", code: error.code, cause: error });
    return wrapped;
  }
  if (error instanceof Error) return error;
  return new Error(String(error || "Gopeed SDK 请求失败"));
}

async function checked<T>(operation: Promise<unknown>, parser: (value: unknown) => T, options?: GopeedSdkOptions) {
  try {
    const value = await withTimeout(operation, Number(options?.timeoutMs || 8000));
    return parser(value);
  } catch (error) {
    const normalized = normalizeSdkError(error);
    if (normalized.name === "ZodError") {
      throw new Error(`Gopeed SDK 返回数据不符合约定：${contractErrorMessage(error)}`);
    }
    throw normalized;
  }
}

export function isAvailable() {
  return typeof Client === "function";
}

export function getTask(settings: GopeedSettings, taskId: string, options?: GopeedSdkOptions) {
  return checked(clientFor(settings).getTask(taskId), parseGopeedTask, options);
}

export function listTasks(settings: GopeedSettings, options?: GopeedSdkOptions) {
  return checked(clientFor(settings).getTasks(), parseGopeedTasks, options);
}

export function createTask(settings: GopeedSettings, body: unknown, options?: GopeedSdkOptions) {
  return checked(clientFor(settings).createTask(body as never), parseGopeedTaskId, options);
}

export async function pauseTask(settings: GopeedSettings, taskId: string, options?: GopeedSdkOptions) {
  await checked(clientFor(settings).pauseTask(taskId), () => undefined, options);
}

export async function continueTask(settings: GopeedSettings, taskId: string, options?: GopeedSdkOptions) {
  await checked(clientFor(settings).continueTask(taskId), () => undefined, options);
}

export async function deleteTask(settings: GopeedSettings, taskId: string, options?: GopeedSdkOptions) {
  await checked(clientFor(settings).deleteTask(taskId, true), () => undefined, options);
}
