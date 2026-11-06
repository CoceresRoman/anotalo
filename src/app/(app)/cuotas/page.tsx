"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog";
import IconButton from "../../components/IconButton";
import EditIcon from "../../components/icons/EditIcon";
import TrashIcon from "../../components/icons/TrashIcon";
import { formatCents, parseAmountToCents } from "../../../lib/money";
import type { BotLocale } from "../../../lib/config";
import { toArgentinaDateString } from "../../../lib/timezone";
import { useRefetchOnFocus } from "../../hooks/useRefetchOnFocus";

type CuotaItem = {
  id: string;
  name: string;
  amountCents: number;
  totalInstallments: number | null;
  currentInstallment: number;
  groupId: string | null;
  active: boolean;
  paidExpenseId: string | null;
};

type CuotasResponse = { items: CuotaItem[]; defaultCurrency: string; locale: BotLocale };

type Group = { id: string; name: string };

// The CURRENT Argentina month, computed exactly like payItem/payGroup
// (src/lib/cuotas.ts) compute the month they pay — not the browser's local
// clock — so "is the selected month the one a payment would land in?" can
// never disagree with the server.
function currentMonth(): string {
  return toArgentinaDateString(new Date()).slice(0, 7);
}

// "YYYY-MM" plus n months, carrying the year over at the boundary.
function addMonths(yearMonth: string, n: number): string {
  const [year, month] = yearMonth.split("-").map(Number);
  const total = year * 12 + (month - 1) + n;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, "0")}`;
}

const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

// Manual lookup rather than `new Date(yearMonth)` — parsing a bare
// "YYYY-MM" string reads as UTC midnight and can show the wrong month
// depending on the browser's timezone (same pitfall other pages in this
// app already avoid for full "YYYY-MM-DD" dates).
function monthLabel(yearMonth: string): string {
  const month = Number(yearMonth.split("-")[1]);
  return MONTH_LABELS[month - 1];
}

const PROJECTION_MONTHS = 6;

function installmentLabel(item: CuotaItem): string {
  return item.totalInstallments === null
    ? `Cuota ${item.currentInstallment}`
    : `Cuota ${item.currentInstallment}/${item.totalInstallments}`;
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderWidth: 1,
  borderStyle: "solid",
  borderRadius: 6,
  padding: 8,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "transparent",
  cursor: "pointer",
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  borderWidth: 1,
  borderStyle: "solid",
  background: "transparent",
  cursor: "pointer",
};

export default function CuotasPage() {
  const [month, setMonth] = useState(currentMonth());
  const [items, setItems] = useState<CuotaItem[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  // Sourced from /api/cuotas's own response (never imported from
  // src/lib/config.ts directly — this is a "use client" file, and
  // process.env isn't inlined into the browser bundle; see src/lib/money.ts).
  const [defaultCurrency, setDefaultCurrency] = useState("ARS");
  const [locale, setLocale] = useState<BotLocale>("es");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Cuota (RecurringItem) create/edit dialog.
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CuotaItem | null>(null);
  const [itemName, setItemName] = useState("");
  const [itemAmount, setItemAmount] = useState("");
  const [itemIndefinida, setItemIndefinida] = useState(true);
  const [itemTotalInstallments, setItemTotalInstallments] = useState("");
  const [itemStartInstallment, setItemStartInstallment] = useState("1");
  const [itemStartYearMonth, setItemStartYearMonth] = useState(currentMonth());
  const [itemGroupId, setItemGroupId] = useState("");
  const [itemFormError, setItemFormError] = useState<string | null>(null);
  const [itemSaving, setItemSaving] = useState(false);
  const itemDialogRef = useRef<HTMLDialogElement>(null);

  // Agrupador (RecurringGroup) create/rename dialog.
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupFormError, setGroupFormError] = useState<string | null>(null);
  const [groupSaving, setGroupSaving] = useState(false);
  const groupDialogRef = useRef<HTMLDialogElement>(null);

  const [deleteItemTarget, setDeleteItemTarget] = useState<CuotaItem | null>(null);
  const [undoItemTarget, setUndoItemTarget] = useState<CuotaItem | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);

  // Totals for the summary row at the top of the page: "cuánto falta pagar
  // este mes" and the next PROJECTION_MONTHS months' committed totals.
  // Always anchored to the real current Argentina month, independent of
  // whatever `month` the browsable list below is showing.
  const [pendienteCents, setPendienteCents] = useState<number | null>(null);
  const [projection, setProjection] = useState<{ yearMonth: string; totalCents: number }[] | null>(null);
  const [projectionError, setProjectionError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = itemDialogRef.current;
    if (!dialog) return;
    if (itemDialogOpen && !dialog.open) dialog.showModal();
    else if (!itemDialogOpen && dialog.open) dialog.close();
  }, [itemDialogOpen]);

  useEffect(() => {
    const dialog = groupDialogRef.current;
    if (!dialog) return;
    if (groupDialogOpen && !dialog.open) dialog.showModal();
    else if (!groupDialogOpen && dialog.open) dialog.close();
  }, [groupDialogOpen]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`/api/cuotas?month=${month}`).then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json() as Promise<CuotasResponse>;
      }),
      fetch(`/api/agrupadores`).then((res) => {
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        return res.json() as Promise<Group[]>;
      }),
    ])
      .then(([cuotasBody, groupsBody]) => {
        if (cancelled) return;
        setItems(cuotasBody.items);
        setGroups(groupsBody);
        setDefaultCurrency(cuotasBody.defaultCurrency);
        setLocale(cuotasBody.locale);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudieron cargar las cuotas.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [month]);

  async function refreshProjection() {
    const base = currentMonth();
    const months = Array.from({ length: PROJECTION_MONTHS }, (_, i) => addMonths(base, i));

    try {
      const responses = await Promise.all(
        months.map((yearMonth) =>
          fetch(`/api/cuotas?month=${yearMonth}`).then((res) => {
            if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
            return res.json() as Promise<CuotasResponse>;
          })
        )
      );
      // El total comprometido de cada mes es la suma de las cuotas activas
      // ese mes, sin importar si ya se pagaron o no — es una proyección de
      // lo que corresponde, no de lo que falta.
      setProjection(
        months.map((yearMonth, i) => ({
          yearMonth,
          totalCents: responses[i].items
            .filter((item) => item.active)
            .reduce((sum, item) => sum + item.amountCents, 0),
        }))
      );
      // Lo que falta pagar AHORA es distinto: solo las activas de este mes
      // que todavía no se marcaron como pagadas.
      setPendienteCents(
        responses[0].items
          .filter((item) => item.active && item.paidExpenseId === null)
          .reduce((sum, item) => sum + item.amountCents, 0)
      );
    } catch {
      setProjectionError("No se pudo calcular la proyección de cuotas.");
    }
  }

  useEffect(() => {
    refreshProjection();
  }, []);

  async function refreshCuotas() {
    try {
      const res = await fetch(`/api/cuotas?month=${month}`);
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const body: CuotasResponse = await res.json();
      setItems(body.items);
      setDefaultCurrency(body.defaultCurrency);
      setLocale(body.locale);
    } catch {
      setActionError("No se pudo actualizar la lista de cuotas.");
    }
  }

  async function refreshGroups() {
    try {
      const res = await fetch(`/api/agrupadores`);
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const body: Group[] = await res.json();
      setGroups(body);
    } catch {
      setActionError("No se pudo actualizar la lista de agrupadores.");
    }
  }

  // On returning to this tab, silently refresh everything already shown
  // (no loading spinner) rather than re-running the initial Promise.all
  // load above, which would flash "Cargando..." over the current list.
  const refreshOnFocus = useCallback(() => {
    refreshCuotas();
    refreshGroups();
    refreshProjection();
  }, [month]);

  useRefetchOnFocus(refreshOnFocus);

  const itemsByGroup = useMemo(() => {
    const map = new Map<string, CuotaItem[]>();
    const sueltas: CuotaItem[] = [];
    for (const item of items ?? []) {
      if (item.groupId === null) {
        sueltas.push(item);
      } else {
        const arr = map.get(item.groupId) ?? [];
        arr.push(item);
        map.set(item.groupId, arr);
      }
    }
    return { map, sueltas };
  }, [items]);

  function openCreateItem() {
    setEditingItem(null);
    setItemName("");
    setItemAmount("");
    setItemIndefinida(true);
    setItemTotalInstallments("");
    setItemStartInstallment("1");
    setItemStartYearMonth(currentMonth());
    setItemGroupId("");
    setItemFormError(null);
    setItemDialogOpen(true);
  }

  function openEditItem(item: CuotaItem) {
    setEditingItem(item);
    setItemName(item.name);
    setItemAmount(String(item.amountCents / 100));
    setItemIndefinida(item.totalInstallments === null);
    setItemTotalInstallments(item.totalInstallments === null ? "" : String(item.totalInstallments));
    setItemGroupId(item.groupId ?? "");
    setItemFormError(null);
    setItemDialogOpen(true);
  }

  async function handleSaveItem(e: React.FormEvent) {
    e.preventDefault();

    const amountCents = parseAmountToCents(itemAmount);
    if (!itemName.trim() || amountCents === null) {
      setItemFormError("Completá el nombre y un monto válido.");
      return;
    }

    let totalInstallments: number | null = null;
    if (!itemIndefinida) {
      const parsed = Number(itemTotalInstallments);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setItemFormError("La cantidad de cuotas tiene que ser un número entero positivo.");
        return;
      }
      totalInstallments = parsed;
    }

    setItemSaving(true);
    setItemFormError(null);
    try {
      let res: Response;
      if (editingItem) {
        // startInstallment/startYearMonth are write-only fields: GET
        // /api/cuotas never returns them, so there is no reliable value to
        // prefill on edit — omit them from the PATCH body entirely rather
        // than risk overwriting them with wrong data.
        res = await fetch(`/api/cuotas/${editingItem.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: itemName.trim(),
            amountCents,
            totalInstallments,
            groupId: itemGroupId === "" ? null : itemGroupId,
          }),
        });
      } else {
        const startInstallmentParsed = Number(itemStartInstallment);
        const startInstallment =
          Number.isInteger(startInstallmentParsed) && startInstallmentParsed > 0
            ? startInstallmentParsed
            : 1;
        res = await fetch(`/api/cuotas`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: itemName.trim(),
            amountCents,
            totalInstallments,
            startInstallment,
            startYearMonth: itemStartYearMonth,
            groupId: itemGroupId === "" ? null : itemGroupId,
          }),
        });
      }
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      setItemDialogOpen(false);
      await Promise.all([refreshCuotas(), refreshProjection()]);
    } catch {
      setItemFormError("No se pudo guardar la cuota.");
    } finally {
      setItemSaving(false);
    }
  }

  async function handleConfirmDeleteItem() {
    if (!deleteItemTarget) return;
    const target = deleteItemTarget;
    setDeleteItemTarget(null);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/cuotas/${target.id}`, { method: "DELETE" });
      if (res.status !== 204) throw new Error(`Request failed with status ${res.status}`);
      await Promise.all([refreshCuotas(), refreshProjection()]);
    } catch {
      setDeleteError("No se pudo borrar la cuota.");
    }
  }

  function openCreateGroup() {
    setEditingGroup(null);
    setGroupName("");
    setGroupFormError(null);
    setGroupDialogOpen(true);
  }

  function openEditGroup(group: Group) {
    setEditingGroup(group);
    setGroupName(group.name);
    setGroupFormError(null);
    setGroupDialogOpen(true);
  }

  async function handleSaveGroup(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = groupName.trim();
    if (!trimmed) {
      setGroupFormError("Ingresá un nombre.");
      return;
    }

    setGroupSaving(true);
    setGroupFormError(null);
    try {
      const res = editingGroup
        ? await fetch(`/api/agrupadores/${editingGroup.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          })
        : await fetch(`/api/agrupadores`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: trimmed }),
          });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      setGroupDialogOpen(false);
      await refreshGroups();
    } catch {
      setGroupFormError("No se pudo guardar el agrupador.");
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleConfirmDeleteGroup() {
    if (!deleteGroupTarget) return;
    const target = deleteGroupTarget;
    setDeleteGroupTarget(null);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/agrupadores/${target.id}`, { method: "DELETE" });
      if (res.status === 409) {
        setDeleteError("No se puede borrar un agrupador que todavía tiene cuotas.");
        return;
      }
      if (res.status !== 204) throw new Error(`Request failed with status ${res.status}`);
      await refreshGroups();
    } catch {
      setDeleteError("No se pudo borrar el agrupador.");
    }
  }

  async function handlePayItem(item: CuotaItem) {
    setActionError(null);
    try {
      const res = await fetch(`/api/cuotas/${item.id}/pagar`, { method: "POST" });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      await Promise.all([refreshCuotas(), refreshProjection()]);
    } catch {
      setActionError("No se pudo marcar la cuota como pagada.");
    }
  }

  // The listed items that share `item`'s payment: a group payment ("Pagar
  // {agrupador}") creates ONE Expense shared by every item it covered, so
  // undoing it from any one of those items undoes all of them.
  function itemsSharingPayment(item: CuotaItem): CuotaItem[] {
    if (!item.paidExpenseId) return [];
    return (items ?? []).filter((other) => other.paidExpenseId === item.paidExpenseId);
  }

  function undoConfirmationMessage(item: CuotaItem): string {
    const sharing = itemsSharingPayment(item);
    if (sharing.length <= 1) {
      return `¿Deshacer el pago de "${item.name}"? Se borra el gasto que generó.`;
    }
    const groupName = item.groupId ? groups?.find((g) => g.id === item.groupId)?.name : undefined;
    const names = sharing.map((other) => `"${other.name}"`).join(", ");
    return groupName
      ? `Este pago es el pago combinado de "${groupName}": deshacerlo deshace el pago de las ${sharing.length} cuotas que cubrió (${names}) y borra su gasto. ¿Deshacer?`
      : `Esto va a deshacer el pago combinado de varias cuotas (${names}) y borrar su gasto. ¿Deshacer?`;
  }

  async function handleConfirmUndoItem() {
    if (!undoItemTarget) return;
    const item = undoItemTarget;
    setUndoItemTarget(null);
    if (!item.paidExpenseId) return;
    setActionError(null);
    try {
      // "Deshacer" reuses the gastos delete endpoint: there is no separate
      // "unpay" route. This also undoes a whole group payment in one step
      // when the paidExpenseId is shared across several items.
      const res = await fetch(`/api/gastos/${item.paidExpenseId}`, { method: "DELETE" });
      if (res.status !== 204) throw new Error(`Request failed with status ${res.status}`);
      await Promise.all([refreshCuotas(), refreshProjection()]);
    } catch {
      setActionError("No se pudo deshacer el pago.");
    }
  }

  async function handlePayGroup(group: Group) {
    setActionError(null);
    try {
      const res = await fetch(`/api/agrupadores/${group.id}/pagar`, { method: "POST" });
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      await Promise.all([refreshCuotas(), refreshProjection()]);
    } catch {
      setActionError("No se pudo pagar el agrupador.");
    }
  }

  const isCurrentMonth = month === currentMonth();

  function renderItemsTable(rows: CuotaItem[]) {
    return (
      <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, minWidth: 520 }}>
        <thead>
          <tr className="text-ink-faint" style={{ fontSize: 13 }}>
            <th style={{ textAlign: "left", fontWeight: 500 }}>Nombre</th>
            <th style={{ textAlign: "left", fontWeight: 500 }}>Cuota</th>
            <th style={{ textAlign: "right", fontWeight: 500 }}>Monto</th>
            <th></th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr
              key={item.id}
              className="border-hairline text-ink"
              style={{ borderTopWidth: 1, borderTopStyle: "solid" }}
            >
              <td className="font-serif" style={{ padding: "8px 0" }}>
                {item.name}
                {!item.active && (
                  <span
                    className="text-ink-faint border-hairline"
                    style={{
                      display: "inline-block",
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      marginLeft: 8,
                      padding: "2px 6px",
                      borderWidth: 1,
                      borderStyle: "solid",
                      borderRadius: 999,
                    }}
                  >
                    no vigente este mes
                  </span>
                )}
              </td>
              <td className="text-ink-muted" style={{ padding: "8px 0" }}>
                {installmentLabel(item)}
              </td>
              <td className="tabular-nums" style={{ textAlign: "right", padding: "8px 16px 8px 0" }}>
                {formatCents(item.amountCents, defaultCurrency, locale)}
              </td>
              <td style={{ padding: "8px 8px 8px 0", whiteSpace: "nowrap" }}>
                {/* Paying always lands in the CURRENT month (payItem), so
                    "Marcar pagada" only exists while that's the month shown. */}
                {item.active ? (
                  item.paidExpenseId !== null ? (
                    <button
                      type="button"
                      onClick={() => setUndoItemTarget(item)}
                      className="text-ink-muted border-hairline"
                      style={secondaryButtonStyle}
                    >
                      Deshacer
                    </button>
                  ) : isCurrentMonth ? (
                    <button
                      type="button"
                      onClick={() => handlePayItem(item)}
                      className="text-ink border-hairline"
                      style={secondaryButtonStyle}
                    >
                      Marcar pagada
                    </button>
                  ) : (
                    <span className="text-ink-faint" title="Solo se puede marcar como pagada en el mes actual">
                      Sin pagar
                    </span>
                  )
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                <IconButton onClick={() => openEditItem(item)} ariaLabel="Editar cuota">
                  <EditIcon />
                </IconButton>
              </td>
              <td style={{ padding: "8px 0", whiteSpace: "nowrap" }}>
                <IconButton onClick={() => setDeleteItemTarget(item)} ariaLabel="Borrar cuota">
                  <TrashIcon />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    );
  }

  return (
    <main className="bg-cream text-ink p-4 sm:p-6" style={{ maxWidth: 960, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 className="font-serif text-ink" style={{ fontSize: 28, fontWeight: 600 }}>
          Cuotas
        </h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Mes"
            className="border-hairline text-ink"
            style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 6, padding: 4 }}
          />
          <button type="button" onClick={openCreateGroup} className="text-ink border-hairline" style={secondaryButtonStyle}>
            + Agrupador
          </button>
          <button type="button" onClick={openCreateItem} className="bg-ink text-cream" style={primaryButtonStyle}>
            + Nueva cuota
          </button>
        </div>
      </div>

      {projectionError && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {projectionError}
        </p>
      )}

      {pendienteCents !== null && (
        <div
          className="border-hairline"
          style={{ marginTop: 16, padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
        >
          <div className="text-ink-faint" style={{ fontSize: 13 }}>
            Falta pagar este mes
          </div>
          <h2 className="font-serif text-ink" style={{ margin: "4px 0 0", fontSize: 28 }}>
            {formatCents(pendienteCents, defaultCurrency, locale)}
          </h2>
        </div>
      )}

      {projection && (
        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
          {projection.map((p, i) => {
            // Mes actual y siguiente destacados, el resto como referencia.
            const destacado = i < 2;
            return (
              <div
                key={p.yearMonth}
                className="border-hairline"
                style={{
                  flex: "1 1 120px",
                  padding: destacado ? 14 : 10,
                  borderWidth: destacado ? 2 : 1,
                  borderStyle: "solid",
                  borderRadius: 8,
                }}
              >
                <div className="text-ink-faint" style={{ fontSize: 12 }}>
                  {monthLabel(p.yearMonth)}
                </div>
                <div
                  className="font-serif text-ink"
                  style={{ marginTop: 2, fontSize: destacado ? 20 : 15, fontWeight: destacado ? 600 : 400 }}
                >
                  {formatCents(p.totalCents, defaultCurrency, locale)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isCurrentMonth && (
        <p className="text-ink-muted" style={{ marginTop: 12 }}>
          Estás viendo otro mes: los pagos solo se pueden marcar en el mes actual.
        </p>
      )}
      {loading && <p className="text-ink-muted">Cargando...</p>}
      {error && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      {actionError && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {actionError}
        </p>
      )}
      {deleteError && (
        <p className="text-alert" style={{ marginTop: 12 }}>
          {deleteError}
        </p>
      )}

      {items && groups && (
        <>
          {groups.map((group) => {
            const groupItems = itemsByGroup.map.get(group.id) ?? [];
            // Same as "Marcar pagada": payGroup always pays the CURRENT
            // month, so this is only offered while that's the month shown.
            const canPayGroup = isCurrentMonth && groupItems.some((i) => i.active && i.paidExpenseId === null);
            // Solo las vigentes este mes suman al total del agrupador, igual
            // que "Falta pagar este mes" y la proyección de arriba.
            const groupTotalCents = groupItems
              .filter((i) => i.active)
              .reduce((sum, i) => sum + i.amountCents, 0);
            return (
              <section
                key={group.id}
                className="border-hairline"
                style={{ marginTop: 24, padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                  <h3 className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
                    {group.name}
                    <span className="text-ink-muted tabular-nums" style={{ fontSize: 14, fontWeight: 400, marginLeft: 10 }}>
                      {formatCents(groupTotalCents, defaultCurrency, locale)}
                    </span>
                  </h3>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {canPayGroup && (
                      <button
                        type="button"
                        onClick={() => handlePayGroup(group)}
                        className="text-ink border-hairline"
                        style={secondaryButtonStyle}
                      >
                        Pagar {group.name}
                      </button>
                    )}
                    <IconButton onClick={() => openEditGroup(group)} ariaLabel="Renombrar agrupador">
                      <EditIcon />
                    </IconButton>
                    <IconButton onClick={() => setDeleteGroupTarget(group)} ariaLabel="Borrar agrupador">
                      <TrashIcon />
                    </IconButton>
                  </div>
                </div>
                {groupItems.length === 0 ? (
                  <p className="text-ink-muted" style={{ marginTop: 8 }}>
                    Sin cuotas en este agrupador.
                  </p>
                ) : (
                  renderItemsTable(groupItems)
                )}
              </section>
            );
          })}

          <section
            className="border-hairline"
            style={{ marginTop: 24, padding: 16, borderWidth: 1, borderStyle: "solid", borderRadius: 8 }}
          >
            <h3 className="font-serif text-ink" style={{ fontSize: 18, fontWeight: 600 }}>
              Sueltas
            </h3>
            {itemsByGroup.sueltas.length === 0 ? (
              <p className="text-ink-muted" style={{ marginTop: 8 }}>
                No hay cuotas sueltas.
              </p>
            ) : (
              renderItemsTable(itemsByGroup.sueltas)
            )}
          </section>
        </>
      )}

      <dialog
        ref={itemDialogRef}
        onCancel={(e) => {
          e.preventDefault();
          setItemDialogOpen(false);
        }}
        className="bg-cream text-ink border-hairline"
        style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 8, padding: 24, maxWidth: 420, width: "90%" }}
      >
        <h2 className="font-serif text-ink" style={{ margin: 0, fontSize: 18 }}>
          {editingItem ? "Editar cuota" : "Nueva cuota"}
        </h2>
        <form onSubmit={handleSaveItem} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="text-ink-muted" style={{ fontSize: 13 }}>
            Nombre
            <input
              type="text"
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              className="border-hairline text-ink"
              style={{ ...fieldStyle, marginTop: 4 }}
            />
          </label>
          <label className="text-ink-muted" style={{ fontSize: 13 }}>
            Monto
            <input
              type="text"
              inputMode="decimal"
              value={itemAmount}
              onChange={(e) => setItemAmount(e.target.value)}
              className="border-hairline text-ink"
              style={{ ...fieldStyle, marginTop: 4 }}
            />
          </label>
          <label className="text-ink-muted" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={itemIndefinida}
              onChange={(e) => setItemIndefinida(e.target.checked)}
            />
            Indefinida (sin cantidad total de cuotas)
          </label>
          {!itemIndefinida && (
            <label className="text-ink-muted" style={{ fontSize: 13 }}>
              Cantidad total de cuotas
              <input
                type="number"
                min={1}
                value={itemTotalInstallments}
                onChange={(e) => setItemTotalInstallments(e.target.value)}
                className="border-hairline text-ink"
                style={{ ...fieldStyle, marginTop: 4 }}
              />
            </label>
          )}
          {!editingItem && (
            <>
              <label className="text-ink-muted" style={{ fontSize: 13 }}>
                Cuota inicial
                <input
                  type="number"
                  min={1}
                  value={itemStartInstallment}
                  onChange={(e) => setItemStartInstallment(e.target.value)}
                  className="border-hairline text-ink"
                  style={{ ...fieldStyle, marginTop: 4 }}
                />
              </label>
              <label className="text-ink-muted" style={{ fontSize: 13 }}>
                Mes de inicio
                <input
                  type="month"
                  value={itemStartYearMonth}
                  onChange={(e) => setItemStartYearMonth(e.target.value)}
                  className="border-hairline text-ink"
                  style={{ ...fieldStyle, marginTop: 4 }}
                />
              </label>
            </>
          )}
          <label className="text-ink-muted" style={{ fontSize: 13 }}>
            Agrupador
            <select
              value={itemGroupId}
              onChange={(e) => setItemGroupId(e.target.value)}
              className="border-hairline text-ink"
              style={{ ...fieldStyle, marginTop: 4 }}
            >
              <option value="">Sin agrupar</option>
              {(groups ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          {itemFormError && <p className="text-alert" style={{ margin: 0, fontSize: 13 }}>{itemFormError}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => setItemDialogOpen(false)}
              disabled={itemSaving}
              className="text-ink-muted border-hairline"
              style={secondaryButtonStyle}
            >
              Cancelar
            </button>
            <button type="submit" disabled={itemSaving} className="bg-ink text-cream" style={primaryButtonStyle}>
              Guardar
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        ref={groupDialogRef}
        onCancel={(e) => {
          e.preventDefault();
          setGroupDialogOpen(false);
        }}
        className="bg-cream text-ink border-hairline"
        style={{ borderWidth: 1, borderStyle: "solid", borderRadius: 8, padding: 24, maxWidth: 360, width: "90%" }}
      >
        <h2 className="font-serif text-ink" style={{ margin: 0, fontSize: 18 }}>
          {editingGroup ? "Renombrar agrupador" : "Nuevo agrupador"}
        </h2>
        <form onSubmit={handleSaveGroup} style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="text-ink-muted" style={{ fontSize: 13 }}>
            Nombre
            <input
              type="text"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              className="border-hairline text-ink"
              style={{ ...fieldStyle, marginTop: 4 }}
            />
          </label>
          {groupFormError && <p className="text-alert" style={{ margin: 0, fontSize: 13 }}>{groupFormError}</p>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => setGroupDialogOpen(false)}
              disabled={groupSaving}
              className="text-ink-muted border-hairline"
              style={secondaryButtonStyle}
            >
              Cancelar
            </button>
            <button type="submit" disabled={groupSaving} className="bg-ink text-cream" style={primaryButtonStyle}>
              Guardar
            </button>
          </div>
        </form>
      </dialog>

      <ConfirmDialog
        open={deleteItemTarget !== null}
        title="Borrar cuota"
        message="¿Seguro que querés borrar esta cuota? Esta acción no se puede deshacer."
        onConfirm={handleConfirmDeleteItem}
        onCancel={() => setDeleteItemTarget(null)}
      />

      <ConfirmDialog
        open={undoItemTarget !== null}
        title="Deshacer pago"
        message={undoItemTarget ? undoConfirmationMessage(undoItemTarget) : ""}
        onConfirm={handleConfirmUndoItem}
        onCancel={() => setUndoItemTarget(null)}
      />

      <ConfirmDialog
        open={deleteGroupTarget !== null}
        title="Borrar agrupador"
        message="¿Seguro que querés borrar este agrupador? Solo se puede borrar si no tiene cuotas."
        onConfirm={handleConfirmDeleteGroup}
        onCancel={() => setDeleteGroupTarget(null)}
      />
    </main>
  );
}
