import type { CollaborationCommand, CollaborationSnapshot } from "@mivlet/protocol";
import { editableQueue } from "../lib/work-queue";

/** Loaded only when a conversation queue entry is deliberately steered. */
export async function steerQueued(
  workspaceId: string,
  transport: {
    load: (workspaceId: string) => Promise<CollaborationSnapshot>;
    command: (workspaceId: string, command: CollaborationCommand) => Promise<CollaborationSnapshot>;
  },
  accept: (snapshot: CollaborationSnapshot) => void,
  id: string,
  expectedGeneration: number,
) {
  const eventId = `queued-steer:${id}`;
  const apply = async (command: CollaborationCommand) => {
    const snapshot = await transport.command(workspaceId, command);
    accept(snapshot);
    return snapshot;
  };
  const refreshed = await transport.load(workspaceId);
  accept(refreshed);
  let source = refreshed.work.find((work) => work.id === id);
  const queue = source
    ? editableQueue(refreshed.work, source.conversationId)
    : [];
  if (
    !source ||
    !queue.some((work) => work.id === id && work.generation === expectedGeneration)
  ) {
    throw new Error("This queued request changed. Refresh before steering it.");
  }
  if (source.attachments?.length) {
    throw new Error("Queued live steering is available only for text without attachments.");
  }
  if (source.outcomeGoal) {
    throw new Error("Queued live steering is unavailable for requests with an outcome goal.");
  }
  const text = source.userRequest.trim();
  if (!text || [...text].length > 2000) {
    throw new Error("Queued live steering requires 1–2000 characters of text.");
  }

  const previous = refreshed.work
    .flatMap((work) => work.liveSteering ?? [])
    .find((event) => event.id === eventId);
  if (previous && previous.text !== text) {
    throw new Error("This queued request already has a different live-steering event.");
  }
  if (previous && previous.delivery !== "accepted") {
    throw new Error(
      `The queued request is held because live guidance delivery is ${previous.delivery}. Inspect the receipt before retrying; it was not resent.`,
    );
  }
  if (previous && source.queue?.held) {
    const stopped = await apply({
      action: "stop-work",
      id,
      expectedGeneration: source.generation,
    });
    const remaining = stopped.work.find((work) => work.id === id);
    if (remaining?.status === "queued") {
      throw new Error("Live guidance was accepted, but the queued request remains held. Refresh before retrying removal.");
    }
    return stopped;
  }
  if (previous) {
    throw new Error("This queued request changed after live guidance was accepted. Refresh before removing it.");
  }
  if (source.queue?.held) {
    throw new Error("This queued request is already held without a delivery receipt. Inspect it before retrying.");
  }

  const targets = refreshed.work.filter(
    (work) =>
      work.id !== id &&
      work.conversationId === source!.conversationId &&
      work.agentId === source!.agentId &&
      work.status === "running" &&
      !work.executionOwner &&
      work.modelOptionId.startsWith("codex::") &&
      Boolean(work.currentRunId),
  );
  if (targets.length !== 1) {
    throw new Error(
      targets.length
        ? "Queued live steering requires one matching foreground Codex turn."
        : "Queued live steering requires a matching foreground Codex turn.",
    );
  }
  const target = targets[0];
  const held = await apply({
    action: "set-work-held",
    id,
    expectedGeneration,
    held: true,
  });
  source = held.work.find((work) => work.id === id);
  if (!source || source.status !== "queued" || !source.queue?.held) {
    throw new Error("The queued request could not be held before live delivery. Inspect its current state.");
  }
  let delivered: CollaborationSnapshot;
  try {
    delivered = await apply({
      action: "live-steer-work",
      id: target.id,
      expectedGeneration: target.generation,
      eventId,
      text,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Live guidance delivery failed after the queued request was held: ${reason} Inspect the saved delivery state before retrying.`,
    );
  }
  const receipt = delivered.work
    .find((work) => work.id === target.id)
    ?.liveSteering?.find((event) => event.id === eventId);
  if (!receipt) {
    throw new Error("Live guidance delivery is unclear. The queued request remains held; inspect the saved receipt before retrying.");
  }
  if (receipt.delivery !== "accepted") {
    throw new Error(
      `Live guidance delivery was ${receipt.delivery}. The queued request remains held; inspect the receipt before retrying.`,
    );
  }
  const stopped = await apply({
    action: "stop-work",
    id,
    expectedGeneration: source.generation,
  });
  const remaining = stopped.work.find((work) => work.id === id);
  if (remaining?.status === "queued") {
    throw new Error("Live guidance was accepted, but the queued request remains held. Refresh before retrying removal.");
  }
  return stopped;
}
