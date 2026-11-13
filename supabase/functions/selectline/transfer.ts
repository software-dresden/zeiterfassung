// Sends one time entry to SelectLine (or updates what was sent before). No database access: the
// caller loads the input, passes the stored state and a `save` callback, which is called after
// every step that changed something in SelectLine. A crash in between therefore never creates the
// same Auftrag or position twice.

import { documentKeyOf, isOpenDocument, partnerNumberOf, type SelectLineClient } from './client.ts';
import {
  buildParts,
  formatDate,
  TransferError,
  type EntryForTransfer,
  type PositionContext,
} from './positions.ts';

export interface TransferPart {
  /** SelectLine PositionIdentifier. */
  id: string;
  /** JSON of the payload last sent, to detect edits. "removed" when the part disappeared. */
  payload: string;
}

export interface TransferState {
  order_key: string | null;
  order_number: string | null;
  parts: Record<string, TransferPart>;
}

export interface TransferInput {
  entry: EntryForTransfer;
  customerNumber: string;
  /** Auftrag chosen by the technician (null: automatic). */
  chosenOrderKey: string | null;
  context: PositionContext;
}

export interface TransferResult {
  state: TransferState;
  orderCreated: boolean;
  added: number;
  updated: number;
  removed: number;
}

const REMOVED = 'removed';

const resolveOrder = async (
  client: SelectLineClient,
  input: TransferInput,
): Promise<{ key: string; number: string; created: boolean }> => {
  const { customerNumber, chosenOrderKey, entry, context } = input;
  const create = async () => {
    const order = await client.createOrder({
      customerNumber,
      employeeNumber: context.employeeNumber,
      date: entry.entry_date,
      headerText: `Leistungen aus der Zeiterfassung ab ${formatDate(entry.entry_date)}`,
    });
    return { ...order, created: true };
  };

  if (chosenOrderKey) {
    const doc = await client.getDocument(chosenOrderKey);
    if (doc.KindFlag !== 'F') throw new TransferError(`Beleg ${chosenOrderKey} ist kein Auftrag.`);
    const partner = partnerNumberOf(doc);
    if (partner !== null && partner !== customerNumber) {
      throw new TransferError(`Auftrag ${doc.Number} gehört zu einem anderen Kunden.`);
    }
    // Agreed rule: an Auftrag that is already done/invoiced gets no new positions, a new one is opened.
    if (!isOpenDocument(doc)) return create();
    return { key: documentKeyOf(doc), number: doc.Number, created: false };
  }

  const open = await client.listOpenOrders(customerNumber);
  if (open.length > 0) {
    throw new TransferError(
      'Für diesen Kunden gibt es offene Aufträge. Bitte in der Session einen Auftrag wählen.',
    );
  }
  return create();
};

export const runTransfer = async (
  client: SelectLineClient,
  input: TransferInput,
  previous: TransferState,
  save: (state: TransferState) => Promise<void>,
): Promise<TransferResult> => {
  // Validate everything before touching SelectLine.
  const parts = buildParts(input.entry, input.context);
  const state: TransferState = {
    order_key: previous.order_key,
    order_number: previous.order_number,
    parts: { ...previous.parts },
  };
  const result: TransferResult = { state, orderCreated: false, added: 0, updated: 0, removed: 0 };

  if (state.order_key && input.chosenOrderKey && input.chosenOrderKey !== state.order_key) {
    throw new TransferError(
      `Die Session liegt bereits in Auftrag ${state.order_number ?? state.order_key}; der Auftrag kann nicht mehr gewechselt werden.`,
    );
  }

  if (!state.order_key) {
    const order = await resolveOrder(client, input);
    state.order_key = order.key;
    state.order_number = order.number;
    result.orderCreated = order.created;
    await save(state);
  }
  const key = state.order_key as string;

  for (const [name, payload] of Object.entries(parts)) {
    const json = JSON.stringify(payload);
    const existing = state.parts[name];
    if (!existing) {
      const id = await client.addArticlePosition(key, payload);
      state.parts[name] = { id, payload: json };
      result.added++;
      await save(state);
    } else if (existing.payload !== json) {
      await client.updatePosition(key, existing.id, payload);
      state.parts[name] = { id: existing.id, payload: json };
      result.updated++;
      await save(state);
    }
  }

  // Parts that no longer exist (e.g. kilometers removed). The API user has no right to delete,
  // so the position is set to quantity 0 and marked.
  for (const [name, existing] of Object.entries(state.parts)) {
    if (parts[name] || existing.payload === REMOVED) continue;
    let previousPayload: Record<string, unknown> = {};
    try {
      previousPayload = JSON.parse(existing.payload);
    } catch {
      // keep empty
    }
    await client.updatePosition(key, existing.id, {
      ...previousPayload,
      CalculatedQuantityValue: 0,
      Memo: `Entfernt in der Zeiterfassung am ${formatDate(new Date().toISOString())}.`,
    });
    state.parts[name] = { id: existing.id, payload: REMOVED };
    result.removed++;
    await save(state);
  }

  return result;
};
