"use client";

import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="bg-cream text-ink border-hairline"
      style={{
        borderWidth: 1,
        borderStyle: "solid",
        borderRadius: 8,
        padding: 24,
        maxWidth: 360,
        width: "90%",
      }}
    >
      <h2 className="font-serif text-ink" style={{ margin: 0, fontSize: 18 }}>
        {title}
      </h2>
      <p className="text-ink-muted" style={{ margin: "12px 0 0", fontSize: 14 }}>
        {message}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
        <button
          type="button"
          onClick={onCancel}
          className="text-ink-muted border-hairline"
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            borderWidth: 1,
            borderStyle: "solid",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          {cancelLabel ?? "Cancelar"}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="bg-alert border-alert"
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            borderWidth: 1,
            borderStyle: "solid",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          {confirmLabel ?? "Borrar"}
        </button>
      </div>
    </dialog>
  );
}
