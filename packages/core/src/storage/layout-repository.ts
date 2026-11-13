// Stored layout of the UI (ADR 0004, table `layouts`): one global document with a revision.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { validateLayoutDocument } from "@termdock/protocol";
import type { LayoutDocument } from "@termdock/protocol";
import { CoreError } from "../session/errors.js";

export interface StoredLayout {
  /** Undefined while nothing has been saved. */
  layout?: LayoutDocument;
  /** 0 while nothing is saved; grows by 1 with every save. */
  revision: number;
}

export interface LayoutRepository {
  get(): StoredLayout;
  /**
   * Replaces the layout and returns the new revision. With `baseRevision` that is not the current revision
   * it stores nothing and throws `CoreError("invalid_state")`. The caller has validated the document.
   */
  save(layout: LayoutDocument, baseRevision?: number): number;
}

function staleRevision(baseRevision: number, current: number): CoreError {
  return new CoreError(
    "invalid_state",
    `The layout has revision ${current}, not ${baseRevision}; load it again before saving`,
  );
}

/** Repository without a file, for tests and a Core without storage. */
export class InMemoryLayoutRepository implements LayoutRepository {
  private layout: LayoutDocument | undefined;
  private revision = 0;

  get(): StoredLayout {
    return this.layout === undefined
      ? { revision: this.revision }
      : { layout: structuredClone(this.layout), revision: this.revision };
  }

  save(layout: LayoutDocument, baseRevision?: number): number {
    if (baseRevision !== undefined && baseRevision !== this.revision) {
      throw staleRevision(baseRevision, this.revision);
    }
    this.layout = structuredClone(layout);
    this.revision += 1;
    return this.revision;
  }
}

/** Id of the one global layout row (`workspace_id` is NULL). */
const GLOBAL_LAYOUT_ID = "global";

export class SqliteLayoutRepository implements LayoutRepository {
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;

  /** `onInvalid` receives the reason when the stored document cannot be used; defaults to stderr. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly onInvalid: (message: string) => void = (message) =>
      void process.stderr.write(`termdock-core: ${message}\n`),
  ) {
    this.select = db.prepare("SELECT data, revision FROM layouts WHERE id = :id");
    this.upsert = db.prepare(`
      INSERT INTO layouts (id, workspace_id, data, updated_at, revision)
      VALUES (:id, NULL, :data, :updated_at, :revision)
      ON CONFLICT (id) DO UPDATE SET
        data = excluded.data, updated_at = excluded.updated_at, revision = excluded.revision
    `);
  }

  get(): StoredLayout {
    const row = this.select.get({ id: GLOBAL_LAYOUT_ID });
    if (row === undefined) return { revision: 0 };
    const revision = Number(row.revision);
    // An old or damaged document must not block every layout.get: report it and offer no layout. The revision
    // stays, so the next save with baseRevision still works.
    const layout = this.parse(row.data);
    return layout === undefined ? { revision } : { layout, revision };
  }

  private parse(data: unknown): LayoutDocument | undefined {
    let json: unknown;
    try {
      if (typeof data !== "string") throw new Error("expected text");
      json = JSON.parse(data);
    } catch (error) {
      this.onInvalid(`stored layout is not readable: ${error instanceof Error ? error.message : "unknown"}`);
      return undefined;
    }
    const checked = validateLayoutDocument(json);
    if (!checked.ok) {
      this.onInvalid(`stored layout is invalid: ${checked.error.message}`);
      return undefined;
    }
    return checked.value;
  }

  save(layout: LayoutDocument, baseRevision?: number): number {
    // Read, check and write under one write lock, so a second connection cannot slip in between.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = Number(this.select.get({ id: GLOBAL_LAYOUT_ID })?.revision ?? 0);
      if (baseRevision !== undefined && baseRevision !== current) throw staleRevision(baseRevision, current);
      const revision = current + 1;
      this.upsert.run({
        id: GLOBAL_LAYOUT_ID,
        data: JSON.stringify(layout),
        updated_at: new Date().toISOString(),
        revision,
      });
      this.db.exec("COMMIT");
      return revision;
    } catch (error) {
      // A failed COMMIT may already have ended the transaction; do not hide the real error behind a second one.
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
