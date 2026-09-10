import type { ExecutionAttempt } from "@fable/protocol";
import { describe, expect, it, vi } from "vitest";
import type {
  DurableRunRecord,
  DurableRunWriter,
} from "./conversation-runtime";
import { createAttemptPersistence } from "./attempt-persistence";

const attempt = (transcript = ""): ExecutionAttempt => ({
  id: "attempt-1",
  providerId: "openai",
  model: "gpt-5",
  status: "streaming",
  transcript,
  exchanges: transcript ? [{ role: "assistant", content: transcript }] : [],
  turn: 0,
  pendingApprovalIds: [],
  recoverable: true,
  retryCount: 0,
  createdAt: "2026-09-10T10:00:00.000Z",
  updatedAt: "2026-09-10T10:00:00.000Z",
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("attempt persistence", () => {
  it("flushes the latest accepted transcript when stopped between checkpoints", async () => {
    const saved: ExecutionAttempt[] = [];
    const records: DurableRunRecord[] = [];
    const checkpoints: Array<{ content: string; terminal?: boolean }> = [];
    const persistence = createAttemptPersistence(async (value) => {
      saved.push(value);
    });
    persistence.setWriter({
      record: async (record) => {
        records.push(record);
      },
      checkpointAssistant: async (content, terminal) => {
        checkpoints.push({ content, terminal });
      },
    });

    persistence.current = attempt("visible tail below 512 characters");
    await persistence.stop();

    expect(checkpoints).toEqual([
      { content: "visible tail below 512 characters", terminal: true },
    ]);
    expect(records).toEqual([
      {
        kind: "interruption",
        content: "The response was stopped.",
        reason: "user-stop",
      },
    ]);
    expect(saved.at(-1)).toMatchObject({
      status: "cancelled",
      transcript: "visible tail below 512 characters",
      pendingApprovalIds: [],
    });
  });

  it("orders the terminal snapshot after an outstanding older save", async () => {
    const firstWrite = deferred();
    const saved: string[] = [];
    let calls = 0;
    const persistence = createAttemptPersistence(async (value) => {
      calls += 1;
      if (calls === 1) await firstWrite.promise;
      saved.push(`${value.status}:${value.transcript}`);
    });

    persistence.current = attempt("old checkpoint");
    const oldSave = persistence.save(persistence.current);
    persistence.current = attempt("old checkpoint plus visible tail");
    const stopping = persistence.stop();

    await Promise.resolve();
    expect(saved).toEqual([]);
    firstWrite.resolve();
    await Promise.all([oldSave, stopping]);

    expect(saved).toEqual([
      "streaming:old checkpoint",
      "cancelled:old checkpoint plus visible tail",
    ]);
  });

  it("freezes output and rejects late provider writes after Stop", async () => {
    const save = vi.fn(async () => {});
    const writer: DurableRunWriter = {
      record: vi.fn(async () => {}),
      checkpointAssistant: vi.fn(async () => {}),
    };
    const persistence = createAttemptPersistence(save);
    persistence.setWriter(writer);
    persistence.current = attempt("accepted");

    await persistence.stop();
    persistence.current = attempt("accepted late provider delta");
    await persistence.save(attempt("stale late save"));
    await persistence.record({ kind: "assistant", content: "late" });

    expect(persistence.current?.transcript).toBe("accepted");
    expect(save).toHaveBeenCalledOnce();
    expect(writer.record).toHaveBeenCalledOnce();
  });

  it("reports a failed final flush after attempting both durable stores", async () => {
    const save = vi.fn(async () => {
      throw new Error("attempt store unavailable");
    });
    const checkpointAssistant = vi.fn(async () => {});
    const record = vi.fn(async () => {});
    const persistence = createAttemptPersistence(save);
    persistence.setWriter({ checkpointAssistant, record });
    persistence.current = attempt("keep this text");

    await expect(persistence.stop()).rejects.toThrow(
      "attempt store unavailable",
    );
    expect(checkpointAssistant).toHaveBeenCalledWith("keep this text", true);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "interruption" }),
    );
  });

  it("still attempts the interruption marker when the final checkpoint fails", async () => {
    const record = vi.fn(async () => {});
    const persistence = createAttemptPersistence(async () => {});
    persistence.setWriter({
      checkpointAssistant: vi.fn(async () => {
        throw new Error("conversation checkpoint unavailable");
      }),
      record,
    });
    persistence.current = attempt("accepted output");

    await expect(persistence.stop()).rejects.toThrow(
      "conversation checkpoint unavailable",
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "interruption" }),
    );
  });
});
