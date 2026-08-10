import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from './ui.js';

// Not in the handoff — added because deleting a seat destroys infrastructure
// and revokes a token, and the handoff itself flags the missing confirmation as
// a production requirement.
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus starts inside the dialog rather than wherever the
  // trigger left it.
  useEffect(() => {
    panelRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        zIndex: 50,
      }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: '100%',
          background: 'var(--surface)',
          color: 'var(--ink)',
          borderRadius: 'var(--r-modal)',
          boxShadow: 'var(--shadow-modal)',
          padding: 24,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
        <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink-2)' }}>
          {children}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 22 }}>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
