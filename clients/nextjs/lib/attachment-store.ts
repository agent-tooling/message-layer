import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { insertAttachment, getAttachment, type AttachmentRow } from "@/lib/app-db";

const baseDir = join(process.cwd(), ".data", "attachments");

export type StoredAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadPath: string;
};

export interface AttachmentStore {
  put(input: {
    orgId: string;
    streamId: string;
    streamType: "channel" | "thread";
    uploaderActorId: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<StoredAttachment>;
  get(id: string): Promise<{ row: AttachmentRow; bytes: Buffer } | null>;
}

class LocalAttachmentStore implements AttachmentStore {
  async put(input: {
    orgId: string;
    streamId: string;
    streamType: "channel" | "thread";
    uploaderActorId: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<StoredAttachment> {
    const id = randomUUID().replace(/-/g, "");
    const safeName = input.filename.replaceAll("/", "_");
    const diskPath = join(baseDir, input.orgId, `${id}-${safeName}`);
    await mkdir(dirname(diskPath), { recursive: true });
    await writeFile(diskPath, input.bytes);

    insertAttachment({
      id,
      org_id: input.orgId,
      stream_id: input.streamId,
      stream_type: input.streamType,
      uploader_actor_id: input.uploaderActorId,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.bytes.byteLength,
      disk_path: diskPath,
      created_at: new Date().toISOString(),
    });

    return {
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      downloadPath: `/api/team/attachments/${id}`,
    };
  }

  async get(id: string): Promise<{ row: AttachmentRow; bytes: Buffer } | null> {
    const row = getAttachment(id);
    if (!row) {
      return null;
    }
    const bytes = await readFile(row.disk_path);
    return { row, bytes };
  }
}

export const attachmentStore: AttachmentStore = new LocalAttachmentStore();
