/* Feature 8 — 20-operation in-memory undo stack. Ops carry their own inverse
 * (captured before-values), so undo survives snapshot races. */

export interface UndoOp {
  label: string;
  at: Date;
  undo: () => Promise<void>;
}

export const UNDO_LIMIT = 20;

export class UndoStack {
  ops: UndoOp[] = [];

  push(op: Omit<UndoOp, 'at'>) {
    this.ops.push({ ...op, at: new Date() });
    if (this.ops.length > UNDO_LIMIT) this.ops.shift(); // drop oldest
  }

  async pop(): Promise<UndoOp | null> {
    const op = this.ops.pop();
    if (!op) return null;
    await op.undo();
    return op;
  }
}
