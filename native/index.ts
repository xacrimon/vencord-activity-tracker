

import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent, shell } from "electron";
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import path from "path";

import { PresenceLogEntry } from "../types";

let logsDir: string;

const getLogsDir = async () => {
    if (!logsDir) {
        const oldPath = path.join(DATA_DIR, "StalkerLogs");
        const newPath = path.join(DATA_DIR, "ActivityTrackerLogs");

        let useOld = false;
        try {
            const info = await stat(oldPath);
            if (info.isDirectory()) {
                useOld = true;
            }
        } catch {}

        logsDir = useOld ? oldPath : newPath;
        await mkdir(logsDir, { recursive: true });
    }
    return logsDir;
};

const getLogFilePath = async (userId: string) => path.join(await getLogsDir(), `${userId}.jsonl`);

/** Appends since this user's log was last compacted. Compaction is amortised over this many appends. */
const appendsSinceCompaction = new Map<string, number>();
const COMPACT_AFTER_APPENDS = 100;

/**
 * Serialises work per user. Callers fire log writes without awaiting them, so an append can land
 * between a compaction's read and its rename, and would otherwise be erased by the rename.
 */
const userLocks = new Map<string, Promise<unknown>>();

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const previous = userLocks.get(userId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    userLocks.set(userId, next.catch(() => {}));
    return next;
}

/**
 * Reads a log file, skipping unreadable lines rather than discarding the whole history: a single
 * truncated line must not cost the user every entry they have.
 *
 * Entries may be in either order on disk. Files written before appends were introduced are
 * newest-first; appended ones are oldest-first. Callers are given a defined order by readLogs,
 * and compactLogs normalises the file to oldest-first.
 */
async function parseLogFile(filePath: string): Promise<PresenceLogEntry[]> {
    let content: string;
    try {
        content = await readFile(filePath, "utf-8");
    } catch {
        return [];
    }

    const entries: PresenceLogEntry[] = [];
    let skipped = 0;

    for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line);
            if (entry && typeof entry.timestamp === "number") {
                entries.push(entry);
            } else {
                skipped++;
            }
        } catch {
            skipped++;
        }
    }

    if (skipped) {
        console.warn(`ActivityTracker: skipped ${skipped} unreadable line(s) in ${filePath}`);
    }
    return entries;
}

/**
 * Rewrites a log file oldest-first, so that later entries can simply be appended.
 * Writes to a temp file and renames, so an interrupted write cannot truncate the existing log.
 */
async function writeLogFile(filePath: string, entries: PresenceLogEntry[]) {
    const ordered = [...entries].sort((a, b) => a.timestamp - b.timestamp);
    const content = ordered.length ? ordered.map(log => JSON.stringify(log)).join("\n") + "\n" : "";
    const tmpPath = `${filePath}.tmp`;

    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);
}

export async function openLogsFolder(_event: IpcMainInvokeEvent) {
    const logsDir = await getLogsDir();
    await shell.openPath(logsDir);
}

export async function openLogFile(_event: IpcMainInvokeEvent, userId: string) {
    const filePath = await getLogFilePath(userId);
    const error = await shell.openPath(filePath);
    if (error) {
        await shell.openPath(await getLogsDir());
    }
}

/**
 * Drops entries older than the cutoff and normalises the file to oldest-first.
 * Returns how many entries were removed.
 */
export async function compactLogs(_event: IpcMainInvokeEvent, userId: string, cutoffMs: number) {
    return withUserLock(userId, () => compactLogsLocked(userId, cutoffMs));
}

async function compactLogsLocked(userId: string, cutoffMs: number) {
    const filePath = await getLogFilePath(userId);
    const entries = await parseLogFile(filePath);
    appendsSinceCompaction.set(userId, 0);

    if (!entries.length) return 0;

    const kept = cutoffMs ? entries.filter(log => log.timestamp >= cutoffMs) : entries;
    const removed = entries.length - kept.length;
    const isOldestFirst = kept.every((log, i) => i === 0 || kept[i - 1].timestamp <= log.timestamp);

    // Nothing to prune and already append-ready: leave the file alone.
    if (removed === 0 && isOldestFirst) return 0;

    await writeLogFile(filePath, kept);
    return removed;
}

export async function appendLog(_event: IpcMainInvokeEvent, userId: string, entry: PresenceLogEntry, cutoffMs: number) {
    return withUserLock(userId, async () => {
        const filePath = await getLogFilePath(userId);

        try {
            await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");

            const appends = (appendsSinceCompaction.get(userId) ?? 0) + 1;
            if (cutoffMs && appends >= COMPACT_AFTER_APPENDS) {
                await compactLogsLocked(userId, cutoffMs);
            } else {
                appendsSinceCompaction.set(userId, appends);
            }
        } catch (e) {
            console.error("Failed to append log", e);
            throw e;
        }
    });
}

export async function readLogs(_event: IpcMainInvokeEvent, userId: string, cutoffMs?: number): Promise<PresenceLogEntry[]> {
    return withUserLock(userId, () => readLogsLocked(userId, cutoffMs));
}

async function readLogsLocked(userId: string, cutoffMs?: number): Promise<PresenceLogEntry[]> {
    const filePath = await getLogFilePath(userId);
    const entries = await parseLogFile(filePath);
    const filtered = cutoffMs ? entries.filter(log => log.timestamp >= cutoffMs) : entries;

    return filtered.sort((a, b) => b.timestamp - a.timestamp);
}

export async function deleteLogs(_event: IpcMainInvokeEvent, userId: string) {
    return withUserLock(userId, () => deleteLogsLocked(userId));
}

async function deleteLogsLocked(userId: string) {
    const filePath = await getLogFilePath(userId);
    appendsSinceCompaction.delete(userId);

    for (const target of [filePath, `${filePath}.tmp`]) {
        try {
            await unlink(target);
        } catch (e) {
        }
    }
}
