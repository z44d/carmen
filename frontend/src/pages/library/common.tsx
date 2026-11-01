/**
 * Small building blocks shared by the Library pages: the page summary line
 * (the tab bar owns the titles now), the empty-state hint and the two
 * dialogs (playlist form and destructive confirmation) used by both the
 * grid and the detail view.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { Button, IconButton, Spinner } from '../../components/ui';
import { Dialog, DialogActions, DialogContent, DialogTitle } from '../../components/ui/Overlay';
import { TextField } from '../../components/ui/Field';

import { CloseIcon } from './glyphs';

/* ── page summary ─────────────────────────────────────────────────────── */

interface PageSummaryProps {
  /** Small muted status line under the tab bar (counts, freshness, …). */
  children?: ReactNode;
  /** Rendered on the far right (buttons, filters, …). */
  action?: ReactNode;
}

/**
 * One quiet line introducing a Library page — the sticky tab bar already
 * carries the title, so pages only need their caption and any page-level
 * action (e.g. "New playlist").
 */
export function PageSummary({ children, action }: PageSummaryProps) {
  return (
    <div className="mb-3 flex min-h-[28px] items-center gap-2">
      {children && <p className="m-0 min-w-0 text-sm leading-[1.43] text-muted">{children}</p>}
      {/* MIGRATION: the old `ml: 'auto'` on this box was a dead letter under
          MUI — Stack's spacing reset (`> :not(style) ~ :not(style)`, specificity
          0,1,2) beat the child rule (0,1,0), so the action never pushed right
          and kept the 8px spacing margin instead. Flex `gap` reproduces that
          spacing; no `ml-auto` is added. */}
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}

/* ── empty state ──────────────────────────────────────────────────────── */

interface EmptyHintProps {
  title: string;
  hint?: string;
  icon?: ReactNode;
  /** One quiet line instead of the full centred block. */
  dense?: boolean;
}

export function EmptyHint({ title, hint, icon, dense = false }: EmptyHintProps) {
  if (dense) {
    return (
      <span className="block py-1 text-xs leading-[1.4] text-disabled">
        {title}
        {hint ? ` — ${hint}` : ''}
      </span>
    );
  }
  return (
    <div className="px-4 py-10 text-center">
      {icon && (
        <div className="mb-2 flex justify-center text-disabled" aria-hidden>
          {icon}
        </div>
      )}
      <p className="m-0 text-base font-semibold text-muted">{title}</p>
      {hint && <span className="text-xs leading-[1.4] text-disabled">{hint}</span>}
    </div>
  );
}

/* ── confirmation dialog ──────────────────────────────────────────────── */

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** Renders a spinner-free "busy" label while the action settles. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Destructive-action confirmation (delete a playlist, …). */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  busy = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <p className="m-0 text-sm leading-[1.43] text-muted">{message}</p>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button color="error" variant="contained" onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ── playlist form dialog ─────────────────────────────────────────────── */

interface PlaylistFormDialogProps {
  open: boolean;
  /** `create` also collects the optional description, `rename` is name-only. */
  mode: 'create' | 'rename';
  initialName?: string;
  initialDescription?: string;
  /** Trimmed values — stays open (and busy) until the promise settles. */
  onSubmit: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}

/** Create / rename a playlist; the name is required, the description optional. */
export function PlaylistFormDialog({
  open,
  mode,
  initialName = '',
  initialDescription = '',
  onSubmit,
  onClose,
}: PlaylistFormDialogProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the fields every time the dialog opens (rename needs the old name).
  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setDescription(initialDescription);
    setSaving(false);
    setError(null);
  }, [open, initialName, initialDescription]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(trimmed, description.trim());
      onClose();
    } catch (submitError) {
      console.warn('[library] playlist form failed', submitError);
      setError('Could not save the playlist — please try again.');
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>
        {mode === 'create' ? 'New playlist' : 'Rename playlist'}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          disabled={saving}
          className="!absolute right-2 top-2"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Playlist name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={saving}
          error={Boolean(error)}
          helperText={error ?? ' '}
          margin="dense"
          // MIGRATION: the kit TextField takes no top-level `onKeyDown` —
          // the handler moves onto the control through `inputProps`.
          inputProps={{
            onKeyDown: (event) => {
              if (event.key === 'Enter') void submit();
            },
          }}
        />
        {mode === 'create' && (
          <TextField
            fullWidth
            label="Description (optional)"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={saving}
            margin="dense"
            minRows={2}
            multiline
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={!name.trim() || saving}>
          {saving ? (
            <Spinner size={18} />
          ) : mode === 'create' ? (
            'Create'
          ) : (
            'Save'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
